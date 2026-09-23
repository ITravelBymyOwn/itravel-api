// /api/context.js
// ITBMO Context Intelligence V1.1 + Persistence V1
// Contextual analysis for an already-generated trip with additive persistence.
// Never regenerates or modifies itinerary_data. No partner/affiliate ranking.

import OpenAI from "openai";
import crypto from "crypto";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_CONTEXT_MODEL || "gpt-5.6-luna";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";

const ITBMO_ADMIN_TEST_BYPASS =
  String(process.env.ITBMO_ADMIN_TEST_BYPASS || "false").toLowerCase() === "true";
const ITBMO_ADMIN_USER_ID = String(process.env.ITBMO_ADMIN_USER_ID || "").trim();
const ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION =
  String(process.env.ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION || "false").toLowerCase() === "true";
const ITBMO_PREVIEW_PAYMENT_BYPASS =
  String(process.env.ITBMO_PREVIEW_PAYMENT_BYPASS || "true").toLowerCase() === "true";

const CONTEXT_VERSION = "1.9-route-segments";
const MAX_CANDIDATES = 120;
const CONTEXT_BATCH_SIZE = 24;
const CONTEXT_BATCH_CONCURRENCY = 3;
const CONTEXT_BATCH_TIMEOUT_MS = 45000;
const CONTEXT_BATCH_RETRIES = 2;
const ALLOWED_NEEDS = new Set([
  "ticket_required",
  "reservation_recommended",
  "guided_tour_optional",
  "intercity_transport",
  "transport_arrangement",
  "no_action"
]);
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);
const ALLOWED_ENTITY_TYPES = new Set([
  "attraction",
  "museum",
  "monument",
  "site",
  "experience",
  "route",
  "transport",
  "other"
]);

function headers(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function clean(value, max = 500) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeUiLanguage(value) {
  return String(value || "").toLowerCase() === "en" ? "en" : "es";
}

function normalizeTripLanguage(value) {
  const original = clean(value, 80);
  const raw = original
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\b(es|spa|spanish|espanol|castellano)\b/.test(raw)) return "es";
  if (/\b(en|eng|english|ingles)\b/.test(raw)) return "en";
  if (/\b(pt|por|portuguese|portugues)\b/.test(raw)) return "pt";
  if (/\b(fr|fre|french|francais)\b/.test(raw)) return "fr";
  if (/\b(de|ger|german|deutsch|aleman)\b/.test(raw)) return "de";
  if (/\b(it|ita|italian|italiano)\b/.test(raw)) return "it";

  // Do not constrain Context Intelligence to a fixed language allow-list.
  // Preserve any other traveler-selected language as metadata; the model must
  // still infer and understand the actual language directly from the source.
  return original || "";
}

function tripContentLanguage(trip) {
  const checkpoint = plain(trip?.itinerary_data);
  const plannerState = plain(checkpoint?.planner_state);
  return normalizeTripLanguage(
    plannerState?.itineraryLang ||
    plannerState?.itinerary_lang ||
    plain(trip?.planner_input)?.post_payment_progress?.itinerary_lang ||
    ""
  );
}

function contextVersionFor(uiLanguage) {
  return `${CONTEXT_VERSION}-${normalizeUiLanguage(uiLanguage)}`;
}

async function supabaseFetch(path, options = {}) {
  if (!REST_URL || !SUPABASE_SECRET_KEY) {
    const error = new Error("Context service is not configured");
    error.code = "CONTEXT_SERVER_CONFIG";
    throw error;
  }

  const response = await fetch(`${REST_URL}${path}`, {
    ...options,
    headers: headers(options.headers || {})
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getActiveSession(rawToken) {
  if (!rawToken) return null;

  const rows = await supabaseFetch(
    `/user_sessions?select=id,user_id,expires_at,revoked_at&token_hash=eq.${encodeURIComponent(hashToken(rawToken))}&limit=1`,
    { method: "GET" }
  );

  const session = Array.isArray(rows) ? rows[0] || null : null;
  if (!session || session.revoked_at) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  return session;
}

async function getOwnedTrip(tripId, userId) {
  const rows = await supabaseFetch(
    `/trips?select=id,user_id,status,language,destinations,itinerary_data,generated_at,updated_at&` +
    `id=eq.${encodeURIComponent(tripId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

function sameInstant(a, b) {
  const x = new Date(a || 0).getTime();
  const y = new Date(b || 0).getTime();
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

function normalizedAdmissionText(...values) {
  return values
    .map(value => clean(value, 320))
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactAdmissionText(value) {
  return normalizedAdmissionText(value)
    .replace(/[^a-z0-9\u00c0-\u024f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blocksAttractionAdmission(source, entityName = "", entityType = "other") {
  if (!source) return true;
  if (entityType === "transport" || entityType === "route") return true;

  const entity = normalizedAdmissionText(entityName || source.entity_hint || source.activity);
  const activity = normalizedAdmissionText(source.activity || source.source_activity);
  const transport = normalizedAdmissionText(source.transport);
  const route = normalizedAdmissionText(
    source.from,
    source.to,
    source.source_route
  );

  // Transport infrastructure is never an attraction-admission need.
  const transportHub = /(?:^|\b)(?:airport|aeropuerto|aeroport|aeroporto|flughafen|bahnhof|hauptbahnhof|stazione|estacao|gare|train station|railway station|rail station|bus station|coach station|metro station|subway station|ferry terminal|bus terminal|rail terminal|airport terminal|estacion de tren|estacion ferroviaria|estacion de autobuses|estacion de bus|estacion de metro|terminal de autobuses|terminal de bus|terminal de ferry|terminal ferroviaria)(?:\b|$)/i;
  const knownHub = /(?:^|\b)(?:roma termini|milano centrale|napoli centrale|venezia santa lucia|firenze santa maria novella|barcelona sants|madrid atocha|paris gare du nord|london st pancras)(?:\b|$)/i;
  if (transportHub.test(entity) || knownHub.test(entity)) return true;

  // Lodging and food venues are not admission products. A named restaurant may
  // not contain the word "restaurant", so also inspect the source activity for
  // explicit meal intent before allowing an admission classification.
  const lodgingOrFood = /(?:^|\b)(?:hotel|hostel|alojamiento|accommodation|airbnb|resort|restaurant|restaurante|ristorante|trattoria|osteria|pizzeria|cafe|coffee shop|bar|pub|gelateria|bakery|panaderia)(?:\b|$)/i;
  const mealIntent = /(?:^|\b)(?:desayuno|almuerzo|comida|cena|breakfast|lunch|dinner|brunch|tapas|degustacion|gastronomic meal)(?:\b|$)/i;
  if (lodgingOrFood.test(entity) || lodgingOrFood.test(activity) || mealIntent.test(activity)) return true;

  // Ordinary public-space experiences should never become admission products.
  const publicSpace = /(?:^|\b)(?:mercado|market|barrio|neighborhood|district|plaza|square|calle|street|paseo|walk|walking|recorrido a pie|mirador del valle|viewpoint|gran via|puerta del sol)(?:\b|$)/i;
  if (publicSpace.test(entity) && !/(?:museum|museo|palace|palacio|alcazar|catedral|cathedral|tower|torre|interior)/i.test(entity)) return true;

  // Explicit non-admission intent.
  const nonAdmissionVisit = /(?:^|\b)(?:photo stop|parada fotografica|exterior|outside|fachada|shopping|compras|free time|tiempo libre)(?:\b|$)/i;
  if (nonAdmissionVisit.test(activity)) return true;

  // Distinguish an attraction from the transport used to reach it. Only block a
  // movement row when the entity itself still represents that movement/compound
  // label. If the model extracted a clean attraction entity, preserve it.
  const movementIntent = /(?:^|\b)(?:traslado|transfer|regreso|retorno|salida|llegada|conexion|embarque|anreise|abreise|ruckfahrt|rueckfahrt|zugfahrt|ankunft|abfahrt|transfert|retour|arrivee|depart|trasferimento|ritorno|arrivo|partenza|deslocamento)(?:\b|$)/i;
  const movementMode = /(?:^|\b)(?:train|tren|zug|treno|trem|rail|bus|coach|autobus|metro|subway|tram|flight|vuelo|flug|volo|ferry|ferri|funicular|cremallera|rack railway|cable car|aeri|gondola|shuttle|r5)(?:\b|$)/i;
  const entityHasMovement = movementMode.test(entity) || movementIntent.test(entity);
  const activityIsMovement = movementIntent.test(activity) && (
    movementMode.test(activity) || movementMode.test(transport) || movementMode.test(route)
  );
  const entityMatchesActivity = compactAdmissionText(entity) === compactAdmissionText(activity);

  if (activityIsMovement && (entityHasMovement || entityMatchesActivity)) return true;

  return false;
}

function filterUnsafeAdmissionNeeds(needs) {
  return (Array.isArray(needs) ? needs : []).filter(item => {
    if (!item || (item.need_type !== "ticket_required" && item.need_type !== "reservation_recommended")) {
      return true;
    }

    return !blocksAttractionAdmission(
      {
        activity: item.source_activity,
        source_activity: item.source_activity,
        source_route: item.source_route,
        transport: item.transport,
        entity_hint: item.entity_name
      },
      item.entity_name,
      item.entity_type
    );
  });
}

async function getPersistedContext(trip, city, contextVersion) {
  const runs = await supabaseFetch(
    `/trip_context_runs?select=id,context_version,source_trip_updated_at,candidate_count,visible_count,generated_at&` +
    `trip_id=eq.${encodeURIComponent(trip.id)}&city=eq.${encodeURIComponent(city)}&limit=1`,
    { method: "GET" }
  );

  const run = Array.isArray(runs) ? runs[0] || null : null;
  if (!run) return null;
  if (run.context_version !== contextVersion) return null;
  if (!sameInstant(run.source_trip_updated_at, trip.updated_at)) return null;

  const needs = await supabaseFetch(
    `/trip_travel_needs?select=candidate_id,category,city,day,entity_name,entity_type,need_type,confidence,user_message,source_activity,source_route,transport&` +
    `trip_id=eq.${encodeURIComponent(trip.id)}&city=eq.${encodeURIComponent(city)}&` +
    `context_version=eq.${encodeURIComponent(contextVersion)}&order=day.asc,candidate_id.asc`,
    { method: "GET" }
  );

  const safeNeeds = filterUnsafeAdmissionNeeds(
    Array.isArray(needs) ? needs.map(item => ({
      ...item,
      id: `${item.candidate_id}:${item.need_type}`
    })) : []
  );

  return {
    run,
    needs: safeNeeds
  };
}

async function persistContext(trip, userId, city, candidates, needs, contextVersion) {
  const generatedAt = new Date().toISOString();

  // Replace only this trip/city's derived context. Existing core trip data is untouched.
  await supabaseFetch(
    `/itinerary_context_entities?trip_id=eq.${encodeURIComponent(trip.id)}&city=eq.${encodeURIComponent(city)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );

  const entityRows = candidates.map(source => ({
    trip_id: trip.id,
    user_id: userId,
    city,
    candidate_id: source.candidate_id,
    day: source.day,
    entity_name: source.entity_hint || source.activity,
    entity_type: "other",
    source_activity: source.activity,
    source_route: [source.from, source.to].filter(Boolean).join(" → "),
    transport: source.transport || null,
    source_notes: source.context_notes || source.notes || null,
    context_version: contextVersion,
    source_trip_updated_at: trip.updated_at
  }));

  let persistedEntities = [];
  if (entityRows.length) {
    persistedEntities = await supabaseFetch('/itinerary_context_entities', {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(entityRows)
    });
  }

  const entityIdByCandidate = new Map(
    (Array.isArray(persistedEntities) ? persistedEntities : [])
      .map(row => [row.candidate_id, row.id])
  );

  // Derived needs are replaceable cache data. Remove the prior city set so
  // switching the Workspace UI language never leaves stale localized messages.
  await supabaseFetch(
    `/trip_travel_needs?trip_id=eq.${encodeURIComponent(trip.id)}&city=eq.${encodeURIComponent(city)}`,
    { method: "DELETE", headers: { Prefer: "return=minimal" } }
  );

  const needRows = needs.map(item => ({
    trip_id: trip.id,
    user_id: userId,
    entity_id: entityIdByCandidate.get(String(item.id || '').split(':')[0]) || null,
    city,
    candidate_id: String(item.id || '').split(':')[0],
    day: item.day,
    category: item.category,
    entity_name: item.entity_name,
    entity_type: item.entity_type,
    need_type: item.need_type,
    confidence: item.confidence,
    user_message: item.user_message || null,
    source_activity: item.source_activity || null,
    source_route: item.source_route || null,
    transport: item.transport || null,
    context_version: contextVersion,
    source_trip_updated_at: trip.updated_at
  }));

  if (needRows.length) {
    await supabaseFetch('/trip_travel_needs', {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(needRows)
    });
  }

  await supabaseFetch('/trip_context_runs?on_conflict=trip_id,city', {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify({
      trip_id: trip.id,
      user_id: userId,
      city,
      context_version: contextVersion,
      source_trip_updated_at: trip.updated_at,
      candidate_count: candidates.length,
      visible_count: needs.length,
      generated_at: generatedAt
    })
  });

  return generatedAt;
}

function previewBypass(userId) {
  const isProduction = String(process.env.VERCEL_ENV || "").toLowerCase() === "production";
  if (!isProduction) return ITBMO_PREVIEW_PAYMENT_BYPASS && Boolean(userId);

  if (!ITBMO_ADMIN_TEST_BYPASS || !ITBMO_ADMIN_USER_ID) return false;
  if (String(userId || "") !== ITBMO_ADMIN_USER_ID) return false;
  return ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION;
}

async function hasEntitlement(tripId, userId) {
  if (previewBypass(userId)) return true;

  const rows = await supabaseFetch(
    `/payments?select=id&trip_id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&status=eq.paid&limit=1`,
    { method: "GET" }
  );
  if (Array.isArray(rows) && rows.length > 0) return true;

  const promoRows = await supabaseFetch(
    `/promo_redemptions?select=id&trip_id=eq.${encodeURIComponent(tripId)}&` +
    `user_id=eq.${encodeURIComponent(userId)}&status=eq.consumed&final_amount=eq.0&limit=1`,
    { method: "GET" }
  );
  return Array.isArray(promoRows) && promoRows.length > 0;
}

function cityNames(trip) {
  return (Array.isArray(trip?.destinations) ? trip.destinations : [])
    .map(item => clean(item?.city, 120))
    .filter(Boolean);
}

function normalizeActivity(activity, city) {
  let value = clean(activity, 240).replace(/^rev:\s*/i, "");
  const prefix = new RegExp(`^${escapeRegExp(city)}\\s*[–—-]\\s*`, "i");
  value = value.replace(prefix, "").trim();
  return value || clean(activity, 240);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLowValueRow(row) {
  const activity = clean(row?.activity, 240).toLowerCase();
  if (!activity) return true;

  const lowValue = [
    "desayuno", "breakfast",
    "almuerzo", "lunch",
    "cena", "dinner",
    "check-in", "check in", "check-out", "check out",
    "hotel", "alojamiento", "accommodation",
    "tiempo libre", "free time",
    "descanso", "rest"
  ];

  return lowValue.some(term =>
    activity === term ||
    activity.includes(` – ${term}`) ||
    activity.includes(` - ${term}`)
  );
}

function isGenericTransferActivity(activity) {
  return /(^|\s[-–—]\s)(traslado\s+(a|al|hacia)|regreso\s+(a|al|hacia)|transfer\s+to|return\s+to)\b/i
    .test(clean(activity, 240));
}

function normalizeEntityKey(value) {
  return clean(value, 180)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(galleria|gallery|museo|museum|catedral|cathedral|basilica|piazza|plaza|the|la|el|de|del|della|degli|di|of)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function entityMatch(a, b) {
  const x = normalizeEntityKey(a);
  const y = normalizeEntityKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function transportMinutes(row) {
  const source = `${clean(row?.duration, 160)} ${clean(row?.transport, 120)}`.toLowerCase();
  let total = 0;

  const hours = [...source.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hora|horas)\b/g)];
  for (const match of hours) total += Math.round(parseFloat(match[1].replace(",", ".")) * 60);

  const minutes = [...source.matchAll(/(\d+)\s*(?:m|min|mins|minuto|minutos)\b/g)];
  for (const match of minutes) total += Number(match[1]);

  return total;
}

function detectTransportArrangement(row, destinationNames) {
  const from = clean(row?.from, 160);
  const to = clean(row?.to, 160);
  const transport = clean(row?.transport, 120);
  const activity = clean(row?.activity, 240);
  const combined = `${activity} ${from} ${to} ${transport}`.toLowerCase();

  const cityHits = destinationNames.filter(name => {
    const n = name.toLowerCase();
    return from.toLowerCase().includes(n) ||
      to.toLowerCase().includes(n) ||
      activity.toLowerCase().includes(n);
  });

  const longDistanceMode =
    /\b(train|tren|flight|vuelo|bus|coach|ferry|ferri|rail|ferrocarril|avión|avion)\b/i.test(combined);

  const plannedRoadTransport =
    /\b(coche|car|driver|conductor|alquiler|rental|private transfer|traslado privado)\b/i.test(combined);

  const minutes = transportMinutes(row);
  const genericTransfer = isGenericTransferActivity(activity);
  const intercity = cityHits.length >= 2 || (longDistanceMode && Boolean(from) && Boolean(to));

  return {
    intercity,
    significant:
      intercity ||
      (genericTransfer && plannedRoadTransport) ||
      (genericTransfer && longDistanceMode) ||
      (genericTransfer && minutes >= 45),
    minutes
  };
}

function explicitTourHint(row) {
  return /\b(tour|visita guiada|guided visit|guided tour|private tour|tour privado)\b/i
    .test(`${clean(row?.activity, 240)} ${clean(row?.notes, 320)} ${clean(row?.transport, 120)}`);
}

function accessEvidence(row) {
  const activity = clean(row?.activity, 240);
  const notes = clean(row?.notes, 520);
  const source = `${activity} ${notes}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ");

  const conditional =
    /\b(considera|si quieres|si deseas|si es posible|segun entradas|segun ticket(?:s)?|opcional|optional|if you want|if desired|if possible|depending on (?:the )?ticket(?:s)?|where possible|consider|wenn du|falls du|wenn moglich|je nach ticket|si vous|si possible|selon (?:les )?billets|facultatif|se vuoi|se desideri|se possibile|in base (?:al|ai) bigliett(?:o|i)|opzionale|se quiser|se possivel)\b/i
      .test(source);

  const directAdmission =
    /\b(entrada(?:s)?(?:\s+(?:anticipada|anticipadas|con hora))?|billete(?:s)?|boleto(?:s)?|ticket(?:s)?|admission|entry ticket(?:s)?|timed entry|advance ticket(?:s)?|eintritt(?:skarte|skarten)?|billet(?:s)?|bigliett(?:o|i)|ingress(?:o|i))\b/i
      .test(source);

  const alreadyIncluded =
    /\b(incluye(?:n)?\s+(?:la\s+)?entrada|entrada\s+incluida|ticket(?:s)?\s+included|includes?\s+(?:the\s+)?(?:entry|admission|ticket)|eintritt\s+inklusive|billet(?:s)?\s+inclus|ingresso\s+incluso|ingressi\s+inclusi)\b/i
      .test(source);

  const bookingSignal =
    /\b(reserva(?:r|\s+anticipada|\s+con antelacion)?|reservacion|reservation|book(?:ing)?\s+(?:ahead|in advance)|advance booking|reservierung|im voraus buchen|reservation a l avance|reserver a l avance|prenotazione|prenota(?:re)?\s+in anticipo|reserva antecipada|reserve com antecedencia)\b/i
      .test(source);

  const accessRequired =
    /\b(requiere(?:\s+reserva|\s+entrada)?|obligatori[oa]|required|must book|reservation required|ticket required|requires?\s+(?:a\s+)?ticket|reservierung erforderlich|erfordert|obligatoire|necessite|obbligatori[oa]|richiede|obrigatori[oa]|requer)\b/i
      .test(source);

  if (alreadyIncluded) {
    return { hint: "", evidence: "" };
  }

  if (directAdmission && !conditional) {
    return { hint: "ticket_required", evidence: clean(notes || activity, 260) };
  }

  if (accessRequired && (directAdmission || bookingSignal)) {
    return { hint: "ticket_required", evidence: clean(notes || activity, 260) };
  }

  if (directAdmission || bookingSignal) {
    return { hint: "reservation_recommended", evidence: clean(notes || activity, 260) };
  }

  return { hint: "", evidence: "" };
}

function rowPhysicalDestination(row, fallbackCity="") {
  return clean(row?.physical_location || row?.commerce_context?.physical_destination || fallbackCity, 160);
}

function buildCandidates(trip, requestedCity) {
  const checkpoint = plain(trip?.itinerary_data);
  const itineraries = plain(checkpoint.itineraries);
  const requestedKey = normalizeEntityKey(requestedCity);
  const candidates = [];
  const pendingContextNotes = new Map();
  const physicalNames = new Set(cityNames(trip));

  for (const [sourceCity, rawCityData] of Object.entries(itineraries)) {
    const byDay = plain(plain(rawCityData).byDay);
    Object.values(byDay).forEach(rows => (Array.isArray(rows)?rows:[]).forEach(row=>{
      const physical=rowPhysicalDestination(row,sourceCity);
      if(physical) physicalNames.add(physical);
      const cc=plain(row?.commerce_context);
      if(cc.origin) physicalNames.add(clean(cc.origin,160));
      if(cc.destination) physicalNames.add(clean(cc.destination,160));
    }));
  }
  const destinationNames=[...physicalNames].filter(Boolean);
  const matchedPhysicalName=destinationNames.find(name=>normalizeEntityKey(name)===requestedKey) || clean(requestedCity,160);
  let matchedAny=false;

  for (const [sourceCity, rawCityData] of Object.entries(itineraries)) {
    const byDay = plain(plain(rawCityData).byDay);
    Object.keys(byDay).map(Number).filter(Number.isFinite).sort((a,b)=>a-b).forEach(day=>{
      const rows=Array.isArray(byDay[day])?byDay[day]:[];
      rows.forEach((row,index)=>{
        if(!row||typeof row!=="object"||isLowValueRow(row)) return;
        const cc=plain(row.commerce_context);
        const semantic=clean(cc.semantic_type,80).toUpperCase();
        const physical=rowPhysicalDestination(row,sourceCity);
        const isTransport=semantic==="TRANSPORT";
        const belongs=isTransport
          ? normalizeEntityKey(cc.origin||row.from)===requestedKey
          : normalizeEntityKey(physical)===requestedKey;
        if(!belongs) return;
        matchedAny=true;

        const activity=normalizeActivity(row.activity,physical||sourceCity);
        if(!activity) return;
        const transportInfo=detectTransportArrangement(row,destinationNames);
        const genericTransfer=isGenericTransferActivity(row.activity);
        if(genericTransfer&&!transportInfo.significant){
          const destination=clean(row.to,180);
          if(destination) pendingContextNotes.set(`${sourceCity}:${day}:${index+1}`,clean(row.notes,320));
          return;
        }
        const candidateId=`${normalizeEntityKey(sourceCity)||'unit'}-${day}-${index+1}`;
        const destination=clean(row.to,180);
        const entityHint=clean(cc.canonical_place,180)||destination||activity;
        const ownNotes=clean(row.notes,320).replace(/^valid:\s*/i,"");
        const contextNotes=clean(`${pendingContextNotes.get(candidateId)||""} ${ownNotes}`,620);
        pendingContextNotes.delete(candidateId);
        const evidence=accessEvidence({activity,notes:contextNotes});
        candidates.push({
          candidate_id:candidateId,day,activity,entity_hint:entityHint,notes:ownNotes,context_notes:contextNotes,
          from:clean(row.from,160),to:destination,transport:clean(row.transport,120),
          physical_destination:physical,source_planning_unit:sourceCity,
          intercity_hint:transportInfo.intercity,transport_arrangement_hint:transportInfo.significant,
          explicit_tour_hint:explicitTourHint(row),
          commerce_semantic_type:semantic,
          commerce_ticket_need:clean(cc.ticket_need,40).toLowerCase(),
          commerce_guided_tour_value:clean(cc.guided_tour_value,40).toLowerCase(),
          destination_priority:clean(cc.destination_priority,40).toLowerCase(),
          commerce_canonical_place:clean(cc.canonical_place,180),
          access_hint:evidence.hint||(semantic==='ATTRACTION_TICKET'?(String(cc.ticket_need||'').toLowerCase()==='required'?'ticket_required':'reservation_recommended'):''),
          access_evidence:evidence.evidence||clean(cc.canonical_place||row.activity,260),
          route_resolution:plain(cc.route_resolution)
        });
      });
    });
  }
  return {city:matchedAny?matchedPhysicalName:"",candidates:candidates.slice(0,MAX_CANDIDATES)};
}

function systemPrompt(language, itineraryLanguage = "") {
  const outputLanguage = normalizeUiLanguage(language) === "en" ? "English" : "Spanish";
  const sourceLanguage = itineraryLanguage || "unknown / mixed";

  return `You are the Context Intelligence engine for ITBMO, a travel-planning product.

Your job is NOT to redesign the itinerary and NOT to sell products.
Your job is to identify what the traveler genuinely needs to arrange to execute the itinerary as written, while clearly separating self-guided access from optional guided experiences.

The itinerary source language metadata may be ${sourceLanguage}. It is a hint only, never an allow-list or a reason to reject content. Detect and understand the actual language directly from the supplied itinerary text, including languages not explicitly named by ITBMO, and write user_message only in ${outputLanguage}.

Analyze only the supplied itinerary candidates. Never add attractions, routes, dates, times, or activities that are not present in the source. Treat destination_priority=essential/high as a destination-defining signal: evaluate independent admission first and, when guidance materially adds value, a separate optional tour.

Allowed need_type values:
- ticket_required
- reservation_recommended
- guided_tour_optional
- intercity_transport
- transport_arrangement
- no_action

ACCESS-FIRST RULES (CRITICAL):
1. For every named attraction, museum, gallery, archaeological site, monument interior, palace, tower/dome, paid garden/site, or similar visit, first ask: "Can the traveler execute this exact planned visit independently, and does doing so intrinsically require or strongly benefit from admission/reservation?"
2. If admission is intrinsic to doing the planned visit, use ticket_required. This is the self-guided access need. Do NOT substitute a guided tour for it.
3. If advance booking is strongly useful but not mandatory, use reservation_recommended.
4. If only one component requires payment/reservation (for example a dome climb or special interior), state that condition in user_message and do not imply the whole site requires it.
5. candidate.access_hint and candidate.access_evidence are source-derived clues. Respect them unless the clue clearly refers to transport rather than attraction admission.
5A. candidate.commerce_semantic_type, commerce_ticket_need, commerce_guided_tour_value and commerce_canonical_place are structured signals emitted by the itinerary engine. Treat them as stronger evidence than generic prose: ATTRACTION_TICKET with ticket_need=required must produce ticket_required; recommended/optional/unknown normally produces reservation_recommended when access is genuinely controlled. guided_tour_value=high may additionally produce guided_tour_optional, but never instead of the access need. FREE_SIGHT, RESTAURANT and LOGISTICS must not become ticket needs without contradictory explicit evidence.
6. You may use stable, high-confidence general tourism knowledge only to recognize whether admission is intrinsic to a famous named attraction. Never invent operational details, current prices, availability, opening hours, reservation deadlines, ticket variants, or provider rules.
7. When multiple itinerary rows on the same day are clearly parts of one commonly shared admission complex, avoid duplicate purchase needs. Anchor one need to the earliest relevant candidate, use a combined entity_name, and classify the duplicate access rows no_action. Do this only with high confidence.
8. guided_tour_optional is a separate enhancement. It must never replace ticket_required/reservation_recommended. Think in EXPERIENCE CLUSTERS, never itinerary rows. Ordinary plazas, streets, neighborhoods, markets, viewpoints, exteriors and short walking stops are ingredients of an overview experience, not separate tour products. When two or more sightseeing rows in the same locality can naturally be covered by one walking/city/overview tour, return ONE guided_tour_optional anchored to the earliest candidate and classify the other tour alternatives no_action. Use attraction-specific guided tours only when that exact attraction is a genuinely distinct experience that materially benefits from guidance.
9. Prefer no_action for plazas, streets, exterior photo stops, ordinary neighborhood walks, free public spaces, meals, hotel time, free time, and simple local movement unless the source itself clearly indicates an arrangement is needed.
10. intercity_transport is only for actual movement between the trip's main destinations already visible in the source.
11. transport_arrangement is for a meaningful regional/day-trip transfer already in the itinerary that clearly requires planning. Never use it for ordinary walking or short local movement.
12. Generic transfer rows can contain evidence about the destination. Use entity_hint and context_notes so a ticket clue from a preceding transfer is not lost.
13. Never invent products, providers, prices, availability, ticket inventory, or commercial claims.
14. confidence must be high, medium, or low.
15. user_message must be short, helpful, non-commercial, and written in ${outputLanguage}.
16. Use cautious language when a requirement can vary. Do not present uncertain claims as facts.
17. A candidate may produce zero, one, or at most two visible needs. If there are two, one must be guided_tour_optional and the other must be a primary access/logistics need.
18. reason is concise evidence, not hidden chain-of-thought.

Return valid JSON only:
{
  "classifications": [
    {
      "candidate_id": "1-1",
      "entity_name": "specific entity or combined access complex from the source",
      "entity_type": "attraction|museum|monument|site|experience|route|transport|other",
      "need_type": "ticket_required|reservation_recommended|guided_tour_optional|intercity_transport|transport_arrangement|no_action",
      "confidence": "high|medium|low",
      "user_message": "short traveler-facing message",
      "reason": "brief evidence-based rationale"
    }
  ]
}`;
}
function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try { return JSON.parse(raw); } catch {}

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  return null;
}

function isContextAbort(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  return /abort/i.test(name) || /request was aborted/i.test(message);
}

function isRetryableContextError(error) {
  const status = Number(error?.status || 0);
  return isContextAbort(error) || status === 408 || status === 409 || status === 429 || status >= 500;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function classifyCandidateBatch(city, candidates, language, itineraryLanguage, batchIndex) {
  let lastError = null;

  for (let attempt = 0; attempt <= CONTEXT_BATCH_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTEXT_BATCH_TIMEOUT_MS);

    try {
      const response = await client.responses.create(
        {
          model: MODEL,
          reasoning: { effort: "low" },
          input: [
            {
              role: "system",
              content: [{ type: "input_text", text: systemPrompt(language, itineraryLanguage) }]
            },
            {
              role: "user",
              content: [{
                type: "input_text",
                text: JSON.stringify({
                  city,
                  candidates
                })
              }]
            }
          ],
          max_output_tokens: 3200
        },
        { signal: controller.signal }
      );

      const parsed = extractJson(response?.output_text || "");
      if (!Array.isArray(parsed?.classifications)) {
        throw new Error("CONTEXT_INVALID_MODEL_OUTPUT");
      }

      return parsed.classifications;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableContextError(error);
      console.warn("[CONTEXT BATCH]", {
        city,
        batch: batchIndex + 1,
        attempt: attempt + 1,
        retryable,
        name: error?.name,
        status: error?.status,
        message: error?.message
      });

      if (!retryable || attempt >= CONTEXT_BATCH_RETRIES) break;
      await wait(700 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("CONTEXT_BATCH_FAILED");
}

async function classifyCandidates(city, candidates, language, itineraryLanguage) {
  if (!candidates.length) return [];

  const batches = [];
  for (let index = 0; index < candidates.length; index += CONTEXT_BATCH_SIZE) {
    batches.push(candidates.slice(index, index + CONTEXT_BATCH_SIZE));
  }

  const results = new Array(batches.length);
  const errors = [];
  let nextBatch = 0;

  async function worker() {
    while (true) {
      const batchIndex = nextBatch;
      nextBatch += 1;
      if (batchIndex >= batches.length) return;

      try {
        results[batchIndex] = await classifyCandidateBatch(
          city,
          batches[batchIndex],
          language,
          itineraryLanguage,
          batchIndex
        );
      } catch (error) {
        errors.push({ batchIndex, error });
        results[batchIndex] = [];
      }
    }
  }

  const workerCount = Math.min(CONTEXT_BATCH_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const classifications = results.flat();
  if (!classifications.length && errors.length) {
    throw errors[0].error;
  }

  if (errors.length) {
    console.warn("[CONTEXT PARTIAL RESULT]", {
      city,
      failed_batches: errors.map(item => item.batchIndex + 1),
      total_batches: batches.length
    });
  }

  return classifications;
}

function categoryForNeed(needType) {
  if (needType === "ticket_required" || needType === "reservation_recommended") return "tickets";
  if (needType === "guided_tour_optional") return "tours";
  if (needType === "intercity_transport" || needType === "transport_arrangement") return "transport";
  return "none";
}

function encodedResolvedRoute(source){
  const rr=plain(source?.route_resolution);
  const legs=Array.isArray(rr?.legs)?rr.legs.filter(leg=>leg&&leg.origin&&leg.destination):[];
  if(!legs.length)return [source?.from,source?.to].filter(Boolean).join(" → ");
  const payload={v:1,parent:{origin:clean(source?.from,160),destination:clean(source?.to,160)},summary:clean(rr?.summary,420),legs:legs.slice(0,12).map((leg,index)=>({
    index:index+1,direction:clean(leg.direction,24),origin:clean(leg.origin,160),destination:clean(leg.destination,160),mode:clean(leg.mode,40),departure_time:clean(leg.departure_time,16),arrival_time:clean(leg.arrival_time,16),estimated_minutes:Number(leg.estimated_minutes||0)||0,commerce_eligible:Boolean(leg.commerce_eligible),note:clean(leg.note,240)
  }))};
  return `ITBMO_ROUTE_V1|${encodeURIComponent(JSON.stringify(payload))}`;
}

function sanitizeClassifications(candidates, classifications, city) {
  const sourceById = new Map(candidates.map(item => [item.candidate_id, item]));
  const usedCandidateNeed = new Set();
  const visible = [];

  for (const raw of classifications) {
    const candidateId = clean(raw?.candidate_id, 80);
    const source = sourceById.get(candidateId);
    if (!source) continue;

    const needType = ALLOWED_NEEDS.has(raw?.need_type) ? raw.need_type : "no_action";
    const confidence = ALLOWED_CONFIDENCE.has(raw?.confidence) ? raw.confidence : "low";
    const entityType = ALLOWED_ENTITY_TYPES.has(raw?.entity_type) ? raw.entity_type : "other";
    const entityName = clean(raw?.entity_name, 180) || source.entity_hint || source.activity;

    if (needType === "no_action" || confidence === "low") continue;

    const semantic = String(source.commerce_semantic_type || "").toUpperCase();
    if ((needType === "ticket_required" || needType === "reservation_recommended") &&
        ["RESTAURANT","LOGISTICS","FREE_SIGHT","NONE","TRANSPORT"].includes(semantic)) continue;
    if (needType === "guided_tour_optional" &&
        !["ATTRACTION_TICKET","TOUR_EXPERIENCE","FREE_SIGHT"].includes(semantic)) continue;

    if (
      (needType === "ticket_required" || needType === "reservation_recommended") &&
      blocksAttractionAdmission(source, entityName, entityType)
    ) continue;

    if (needType === "intercity_transport" && !source.intercity_hint) continue;
    if (needType === "transport_arrangement" && !source.transport_arrangement_hint) continue;

    if (
      needType === "guided_tour_optional" &&
      confidence !== "high" &&
      !source.explicit_tour_hint
    ) {
      continue;
    }

    const dedupeKey = `${candidateId}:${needType}`;
    if (usedCandidateNeed.has(dedupeKey)) continue;
    usedCandidateNeed.add(dedupeKey);

    visible.push({
      id: `${candidateId}:${needType}`,
      category: categoryForNeed(needType),
      city,
      day: source.day,
      entity_name: entityName,
      entity_type: entityType,
      need_type: needType,
      confidence,
      user_message: clean(raw?.user_message, 300),
      source_activity: source.activity,
      source_route: (needType === "intercity_transport" || needType === "transport_arrangement") ? encodedResolvedRoute(source) : [source.from, source.to].filter(Boolean).join(" → "),
      transport: source.transport
    });
  }

  const byCandidate = new Map();
  for (const item of visible) {
    const candidateId = item.id.split(":")[0];
    if (!byCandidate.has(candidateId)) byCandidate.set(candidateId, []);
    byCandidate.get(candidateId).push(item);
  }

  const finalNeeds = [];
  for (const items of byCandidate.values()) {
    const primary = items.find(item =>
      item.need_type === "ticket_required" ||
      item.need_type === "reservation_recommended" ||
      item.need_type === "intercity_transport" ||
      item.need_type === "transport_arrangement"
    );
    const optionalTour = items.find(item => item.need_type === "guided_tour_optional");

    if (primary) finalNeeds.push(primary);
    if (optionalTour) finalNeeds.push(optionalTour);
  }

  return finalNeeds;
}


function accessMessage(needType, entityName, language) {
  const entity = clean(entityName, 180);
  if (normalizeUiLanguage(language) === "en") {
    if (needType === "ticket_required") {
      return entity ? `Plan the admission needed to visit ${entity} as scheduled.` : "Plan the admission needed for this visit.";
    }
    return entity ? `Booking ${entity} in advance may make this planned visit easier.` : "Advance booking may be useful for this visit.";
  }

  if (needType === "ticket_required") {
    return entity ? `Prepara la entrada necesaria para visitar ${entity} según tu itinerario.` : "Prepara la entrada necesaria para esta visita.";
  }
  return entity ? `Reservar ${entity} con antelación puede facilitar esta visita planificada.` : "Reservar con antelación puede ser útil para esta visita.";
}

function localityFromCandidate(source, fallbackCity) {
  const activity = clean(source?.activity, 240);
  const match = activity.match(/^([^–—-]{2,80})\s*[–—-]\s*/);
  return clean(match?.[1] || fallbackCity, 100) || fallbackCity;
}

function consolidateOptionalTours(candidates, needs, city, language) {
  const sourceById = new Map(candidates.map(item => [item.candidate_id, item]));
  const nonTours = (needs || []).filter(item => item.need_type !== "guided_tour_optional");
  const tourNeeds = (needs || []).filter(item => item.need_type === "guided_tour_optional");
  const groups = new Map();

  for (const need of tourNeeds) {
    const source = sourceById.get(String(need.id || "").split(":")[0]);
    if (!source) continue;
    const locality = localityFromCandidate(source, city);
    const key = locality.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ need, source, locality });
  }

  const consolidated = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      const { need, source } = group[0];
      const generic = /(?:barrio|neighborhood|district|plaza|square|market|mercado|paseo|walk|mirador|viewpoint|traslado|transfer)/i.test(`${source.activity} ${need.entity_name}`);
      if (!generic && (source.explicit_tour_hint || need.confidence === "high")) consolidated.push(need);
      continue;
    }
    const first = group[0];
    const locality = first.locality;
    consolidated.push({
      ...first.need,
      id: `${first.source.candidate_id}:guided_tour_optional`,
      entity_name: normalizeUiLanguage(language) === "en" ? `${locality} city tour` : `City tour en ${locality}`,
      entity_type: "experience",
      confidence: "high",
      user_message: normalizeUiLanguage(language) === "en"
        ? `A city tour can combine several of the ${locality} sights already included in your itinerary.`
        : `Un city tour puede reunir varios de los lugares de ${locality} que ya están incluidos en tu itinerario.`,
      source_activity: group.map(x => x.source.activity).slice(0, 4).join(" · ")
    });
  }
  const output=[...nonTours, ...consolidated];
  const hasOverview=output.some(item=>item?.need_type==="guided_tour_optional" && /\b(city tour|tour panoramico|highlights tour)\b/i.test(semanticNeedKey(item?.entity_name||"")));
  const sightseeingCandidates=(candidates||[]).filter(source=>!source?.intercity_hint && !source?.transport_arrangement_hint && !/\b(check[- ]?in|check[- ]?out|hotel|alojamiento|breakfast|desayuno|lunch|almuerzo|dinner|cena|transfer|traslado)\b/i.test(`${source?.activity||""} ${source?.entity_hint||""}`));
  if(!hasOverview && sightseeingCandidates.length>=1 && city){
    const source=sightseeingCandidates[0];
    output.push({
      id:`${source.candidate_id}:guided_tour_optional:city-overview`,category:"tours",city,day:source.day,
      entity_name:normalizeUiLanguage(language)==="en"?`${city} city tour`:`City tour en ${city}`,
      entity_type:"experience",need_type:"guided_tour_optional",confidence:"high",
      user_message:normalizeUiLanguage(language)==="en"?`Compare a destination-wide guided overview of ${city} with exploring independently.`:`Compara una visita panorámica guiada de ${city} con recorrer el destino por cuenta propia.`,
      source_activity:source.activity,source_route:"",derived_by:"deterministic_city_overview"
    });
  }
  return output;
}

function ensureEvidenceBackedAccessNeeds(candidates, needs, city, language) {
  const result = Array.isArray(needs) ? [...needs] : [];
  const accessByCandidate = new Set(
    result
      .filter(item => item?.need_type === "ticket_required" || item?.need_type === "reservation_recommended")
      .map(item => String(item?.id || "").split(":")[0])
  );

  for (const source of candidates) {
    if (!source?.access_hint || accessByCandidate.has(source.candidate_id)) continue;
    if (source.intercity_hint || source.transport_arrangement_hint) continue;
    if (blocksAttractionAdmission(source, source.entity_hint || source.activity, "other")) continue;

    const needType = source.access_hint === "ticket_required"
      ? "ticket_required"
      : "reservation_recommended";

    result.push({
      id: `${source.candidate_id}:${needType}`,
      category: "tickets",
      city,
      day: source.day,
      entity_name: source.entity_hint || source.activity,
      entity_type: "attraction",
      need_type: needType,
      confidence: needType === "ticket_required" ? "high" : "medium",
      user_message: accessMessage(needType, source.entity_hint || source.activity, language),
      source_activity: source.activity,
      source_route: [source.from, source.to].filter(Boolean).join(" → "),
      transport: source.transport
    });
    accessByCandidate.add(source.candidate_id);
  }

  return result;
}

function ensureGuidedAdmissionAlternatives(candidates, needs, city, language) {
  const result=Array.isArray(needs)?[...needs]:[];
  const sourceById=new Map((candidates||[]).map(x=>[x.candidate_id,x]));
  const hasTourForCandidate=id=>result.some(n=>n?.need_type==='guided_tour_optional'&&String(n?.id||'').split(':')[0]===id);
  for(const access of [...result]){
    if(!['ticket_required','reservation_recommended'].includes(access?.need_type))continue;
    const candidateId=String(access?.id||'').split(':')[0];
    const source=sourceById.get(candidateId);
    const guidedValue=String(source?.commerce_guided_tour_value||'').toLowerCase();
    const attraction=clean(access?.entity_name||source?.entity_hint||source?.activity,180);
    if(!attraction||hasTourForCandidate(candidateId))continue;
    if(!['high','recommended','strong'].includes(guidedValue)&&!source?.explicit_tour_hint)continue;
    result.push({id:`${candidateId}:guided_tour_optional:admission`,category:'tours',city,day:source?.day||access.day,
      entity_name:normalizeUiLanguage(language)==='en'?`Guided ${attraction} tour with admission`:`Tour guiado de ${attraction} con entrada`,
      entity_type:'experience',need_type:'guided_tour_optional',confidence:'high',
      user_message:normalizeUiLanguage(language)==='en'?`Compare visiting ${attraction} independently with a guided option that includes admission.`:`Compara la entrada para visitar ${attraction} por tu cuenta con una opción guiada que incluya el acceso.`,
      source_activity:source?.activity||access.source_activity||attraction,source_route:access.source_route||'',derived_by:'deterministic_guided_admission_alternative'});
  }
  return result;
}

function semanticNeedKey(value) {
  return clean(value,220).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\b(city tour|tour panoramico|highlights tour|guided tour|visita guiada|tour de|entrada|ticket|interior|torres?|tower|patios?|salones?|apartamentos? reales?|royal apartments?)\b/g," ")
    .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}

function dedupeSemanticNeeds(needs=[]) {
  const rank=item=>item?.need_type==="ticket_required"?4:item?.need_type==="reservation_recommended"?3:item?.confidence==="high"?2:1;
  const out=[];
  for(const item of needs){
    const category=categoryForNeed(item?.need_type),key=semanticNeedKey(item?.entity_name||item?.source_activity);
    const overview=item?.need_type==="guided_tour_optional"&&/\b(city tour|tour panoramico|highlights tour)\b/.test(semanticNeedKey(item?.entity_name));
    const index=out.findIndex(existing=>{
      if(categoryForNeed(existing?.need_type)!==category)return false;
      const other=semanticNeedKey(existing?.entity_name||existing?.source_activity);
      const otherOverview=existing?.need_type==="guided_tour_optional"&&/\b(city tour|tour panoramico|highlights tour)\b/.test(semanticNeedKey(existing?.entity_name));
      return (overview&&otherOverview)||(key&&other&&(key===other||(Math.min(key.length,other.length)>=7&&(key.includes(other)||other.includes(key)))));
    });
    if(index<0)out.push(item);else if(rank(item)>rank(out[index]))out[index]=item;
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const sessionToken = clean(body.session_token, 500);
    const tripId = clean(body.trip_id, 120);
    const requestedCity = clean(body.city, 160);
    const uiLanguage = normalizeUiLanguage(body.ui_language || body.language || "es");
    const contextVersion = contextVersionFor(uiLanguage);

    if (!sessionToken || !tripId || !requestedCity) {
      return res.status(400).json({
        ok: false,
        code: "CONTEXT_INPUT_REQUIRED",
        error: "session_token, trip_id and city are required"
      });
    }

    const session = await getActiveSession(sessionToken);
    if (!session) {
      return res.status(401).json({
        ok: false,
        code: "CONTEXT_NOT_AUTHORIZED",
        error: "Invalid or expired session"
      });
    }

    const trip = await getOwnedTrip(tripId, session.user_id);
    if (!trip) {
      return res.status(404).json({
        ok: false,
        code: "CONTEXT_TRIP_NOT_FOUND",
        error: "Trip not found"
      });
    }

    if (trip.status !== "generated") {
      return res.status(409).json({
        ok: false,
        code: "CONTEXT_TRIP_NOT_READY",
        error: "Trip is not generated"
      });
    }

    const entitled = await hasEntitlement(tripId, session.user_id);
    if (!entitled) {
      return res.status(402).json({
        ok: false,
        code: "CONTEXT_NOT_AUTHORIZED",
        error: "Trip entitlement required"
      });
    }

    const { city, candidates } = buildCandidates(trip, requestedCity);
    if (!city) {
      return res.status(404).json({
        ok: false,
        code: "CONTEXT_CITY_NOT_FOUND",
        error: "City not found in trip"
      });
    }

    // Persistence is a cache of derived context only. The generated itinerary remains the source of truth.
    try {
      const persisted = await getPersistedContext(trip, city, contextVersion);
      if (persisted) {
        return res.status(200).json({
          ok: true,
          context_version: contextVersion,
          trip_id: trip.id,
          city,
          generated_at: persisted.run.generated_at,
          needs: persisted.needs,
          meta: {
            candidate_count: persisted.run.candidate_count,
            visible_count: persisted.run.visible_count,
            persisted: true,
            cache_hit: true
          }
        });
      }
    } catch (cacheError) {
      console.warn("[CONTEXT PERSISTENCE READ]", cacheError);
    }

    let needs = [];
    if (candidates.length) {
      const itineraryLanguage = normalizeTripLanguage(body.trip_language) || tripContentLanguage(trip);
      let classifications=[];
      try {
        classifications=await classifyCandidates(city,candidates,uiLanguage,itineraryLanguage);
      } catch (classificationError) {
        console.warn("[CONTEXT MODEL FALLBACK]",{city,message:classificationError?.message});
      }
      needs = sanitizeClassifications(candidates, classifications, city);
      needs = consolidateOptionalTours(candidates, needs, city, uiLanguage);
      needs = ensureEvidenceBackedAccessNeeds(candidates, needs, city, uiLanguage);
      needs = ensureGuidedAdmissionAlternatives(candidates, needs, city, uiLanguage);
      needs = dedupeSemanticNeeds(needs);
    }

    let persisted = false;
    let generatedAt = new Date().toISOString();
    try {
      generatedAt = await persistContext(trip, session.user_id, city, candidates, needs, contextVersion);
      persisted = true;
    } catch (persistError) {
      // Persistence must never block a traveler from using Context Intelligence.
      console.error("[CONTEXT PERSISTENCE WRITE]", persistError);
    }

    return res.status(200).json({
      ok: true,
      context_version: contextVersion,
      trip_id: trip.id,
      city,
      generated_at: generatedAt,
      needs,
      meta: {
        candidate_count: candidates.length,
        visible_count: needs.length,
        persisted,
        cache_hit: false
      }
    });
  } catch (error) {
    console.error("[CONTEXT INTELLIGENCE]", error);

    return res.status(500).json({
      ok: false,
      code: isContextAbort(error) ? "CONTEXT_TIMEOUT" : "CONTEXT_ERROR",
      error: "Unable to analyze this trip right now"
    });
  }
}
