// /api/context.js
// ITBMO Context Intelligence V1.1 + Persistence V1
// Contextual analysis for an already-generated trip with additive persistence.
// Never regenerates or modifies itinerary_data. No partner/affiliate ranking.

import OpenAI from "openai";
import crypto from "crypto";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_CONTEXT_MODEL || process.env.OPENAI_MODEL || "gpt-5-mini";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const REST_URL = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : "";

const ITBMO_ADMIN_TEST_BYPASS =
  String(process.env.ITBMO_ADMIN_TEST_BYPASS || "false").toLowerCase() === "true";
const ITBMO_ADMIN_USER_ID = String(process.env.ITBMO_ADMIN_USER_ID || "").trim();
const ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION =
  String(process.env.ITBMO_ADMIN_BYPASS_ALLOW_PRODUCTION || "false").toLowerCase() === "true";

const CONTEXT_VERSION = "1.1";
const MAX_CANDIDATES = 120;
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

async function getPersistedContext(trip, city) {
  const runs = await supabaseFetch(
    `/trip_context_runs?select=id,context_version,source_trip_updated_at,candidate_count,visible_count,generated_at&` +
    `trip_id=eq.${encodeURIComponent(trip.id)}&city=eq.${encodeURIComponent(city)}&limit=1`,
    { method: "GET" }
  );

  const run = Array.isArray(runs) ? runs[0] || null : null;
  if (!run) return null;
  if (run.context_version !== CONTEXT_VERSION) return null;
  if (!sameInstant(run.source_trip_updated_at, trip.updated_at)) return null;

  const needs = await supabaseFetch(
    `/trip_travel_needs?select=candidate_id,category,city,day,entity_name,entity_type,need_type,confidence,user_message,source_activity,source_route,transport&` +
    `trip_id=eq.${encodeURIComponent(trip.id)}&city=eq.${encodeURIComponent(city)}&` +
    `context_version=eq.${encodeURIComponent(CONTEXT_VERSION)}&order=day.asc,candidate_id.asc`,
    { method: "GET" }
  );

  return {
    run,
    needs: Array.isArray(needs) ? needs.map(item => ({
      ...item,
      id: `${item.candidate_id}:${item.need_type}`
    })) : []
  };
}

async function persistContext(trip, userId, city, candidates, needs) {
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
    context_version: CONTEXT_VERSION,
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
    context_version: CONTEXT_VERSION,
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
      context_version: CONTEXT_VERSION,
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
  if (!isProduction) return Boolean(userId);

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

  return Array.isArray(rows) && rows.length > 0;
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

function buildCandidates(trip, requestedCity) {
  const checkpoint = plain(trip?.itinerary_data);
  const itineraries = plain(checkpoint.itineraries);
  const destinationNames = cityNames(trip);
  const city = destinationNames.find(name => name.toLowerCase() === requestedCity.toLowerCase()) || "";

  if (!city) return { city: "", candidates: [] };

  const cityData = plain(itineraries[city]);
  const byDay = plain(cityData.byDay);
  const candidates = [];

  Object.keys(byDay)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
    .forEach(day => {
      const rows = Array.isArray(byDay[day]) ? byDay[day] : [];
      const substantive = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) =>
          row &&
          typeof row === "object" &&
          !isLowValueRow(row) &&
          !isGenericTransferActivity(row?.activity)
        );

      rows.forEach((row, index) => {
        if (!row || typeof row !== "object") return;
        if (isLowValueRow(row)) return;

        const activity = normalizeActivity(row.activity, city);
        if (!activity) return;

        const transportInfo = detectTransportArrangement(row, destinationNames);
        const genericTransfer = isGenericTransferActivity(row.activity);

        if (genericTransfer && !transportInfo.significant) {
          const destination = clean(row.to, 180);
          const match = substantive.find(({ row: target }) =>
            entityMatch(destination, target?.activity) ||
            entityMatch(destination, target?.to) ||
            entityMatch(activity, target?.activity)
          );

          if (match) {
            const existingId = `${day}-${match.index + 1}`;
            const existing = candidates.find(item => item.candidate_id === existingId);

            if (existing) {
              existing.context_notes = clean(
                `${existing.context_notes || existing.notes || ""} ${clean(row.notes, 320)}`,
                620
              );
            }
            return;
          }
        }

        const destination = clean(row.to, 180);
        const entityHint = genericTransfer && destination ? destination : activity;

        candidates.push({
          candidate_id: `${day}-${index + 1}`,
          day,
          activity,
          entity_hint: entityHint,
          notes: clean(row.notes, 320).replace(/^valid:\s*/i, ""),
          context_notes: clean(row.notes, 320).replace(/^valid:\s*/i, ""),
          from: clean(row.from, 160),
          to: destination,
          transport: clean(row.transport, 120),
          intercity_hint: transportInfo.intercity,
          transport_arrangement_hint: transportInfo.significant,
          explicit_tour_hint: explicitTourHint(row)
        });
      });
    });

  return {
    city,
    candidates: candidates.slice(0, MAX_CANDIDATES)
  };
}
function systemPrompt(language) {
  const outputLanguage = language === "en" ? "English" : "Spanish";

  return `You are the Context Intelligence engine for ITBMO, a travel-planning product.

Your job is NOT to redesign the itinerary and NOT to sell products.
Your only job is to identify what the traveler may genuinely need to arrange in order to execute the itinerary.

Analyze only the supplied itinerary candidates. Never add attractions, routes, dates, times, or activities that are not present in the source.

Allowed need_type values:
- ticket_required
- reservation_recommended
- guided_tour_optional
- intercity_transport
- transport_arrangement
- no_action

Rules:
1. Prefer no_action when there is no clear traveler action.
2. ticket_required means admission is intrinsic to doing the named visit. Be strict. If only a specific component requires a ticket (for example a dome climb), state that condition in user_message instead of implying the whole site requires it.
3. reservation_recommended means advance booking is genuinely useful for the exact planned visit, but do not imply it is mandatory.
4. guided_tour_optional is optional and must never replace the planned activity. Use it only when a guided option is explicitly supported by the source or is a high-confidence enhancement for that exact activity.
5. intercity_transport is for actual movement between trip cities already visible in the source.
6. transport_arrangement is for a meaningful regional/day-trip transfer already in the itinerary that clearly requires planning (for example a rental car, driver, train, bus or other non-trivial arrangement). Never use it for ordinary local walking or short city movement.
7. Generic transfer rows may contain useful logistics about the destination. Use entity_hint as the traveler-facing entity when appropriate; do not make the traveler act on a label such as "Transfer to..." if the real need is for the destination.
8. Ordinary meals, hotel time, free time, neighborhood walks, return-to-hotel walks, and simple local movement should normally be no_action.
9. Never invent prices, availability, opening hours, rules, reservation deadlines, ticket types, providers, or affiliate products.
10. confidence must be high, medium, or low.
11. The user_message must be short, helpful, non-commercial, and written in ${outputLanguage}.
12. Use cautious language when the need can vary. Do not present uncertain claims as facts.
13. A candidate may produce zero, one, or at most two visible needs. If there are two, one must be guided_tour_optional and the other must be a primary logistical need.
14. reason is internal explanatory text, concise and factual; do not expose chain-of-thought.

Return valid JSON only:
{
  "classifications": [
    {
      "candidate_id": "1-1",
      "entity_name": "specific entity or route from the source",
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

async function classifyCandidates(city, candidates, language) {
  if (!candidates.length) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await client.responses.create(
      {
        model: MODEL,
        reasoning: { effort: "low" },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt(language) }]
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
        max_output_tokens: 5000
      },
      { signal: controller.signal }
    );

    const parsed = extractJson(response?.output_text || "");
    return Array.isArray(parsed?.classifications) ? parsed.classifications : [];
  } finally {
    clearTimeout(timeout);
  }
}

function categoryForNeed(needType) {
  if (needType === "ticket_required" || needType === "reservation_recommended") return "tickets";
  if (needType === "guided_tour_optional") return "tours";
  if (needType === "intercity_transport" || needType === "transport_arrangement") return "transport";
  return "none";
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

    if (needType === "no_action" || confidence === "low") continue;

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
      entity_name: clean(raw?.entity_name, 180) || source.entity_hint || source.activity,
      entity_type: entityType,
      need_type: needType,
      confidence,
      user_message: clean(raw?.user_message, 300),
      source_activity: source.activity,
      source_route: [source.from, source.to].filter(Boolean).join(" → "),
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = req.body || {};
    const sessionToken = clean(body.session_token, 500);
    const tripId = clean(body.trip_id, 120);
    const requestedCity = clean(body.city, 160);

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
      const persisted = await getPersistedContext(trip, city);
      if (persisted) {
        return res.status(200).json({
          ok: true,
          context_version: CONTEXT_VERSION,
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
      const language = trip.language === "en" ? "en" : "es";
      const classifications = await classifyCandidates(city, candidates, language);
      needs = sanitizeClassifications(candidates, classifications, city);
    }

    let persisted = false;
    let generatedAt = new Date().toISOString();
    try {
      generatedAt = await persistContext(trip, session.user_id, city, candidates, needs);
      persisted = true;
    } catch (persistError) {
      // Persistence must never block a traveler from using Context Intelligence.
      console.error("[CONTEXT PERSISTENCE WRITE]", persistError);
    }

    return res.status(200).json({
      ok: true,
      context_version: CONTEXT_VERSION,
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
      code: error?.name === "AbortError" ? "CONTEXT_TIMEOUT" : "CONTEXT_ERROR",
      error: "Unable to analyze this trip right now"
    });
  }
}
