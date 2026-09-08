// /api/context.js
// ITBMO Context Intelligence V1
// Read-only contextual analysis for an already-generated trip.
// No Supabase writes. No itinerary regeneration. No partner/affiliate ranking.

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

const MAX_CANDIDATES = 120;
const ALLOWED_NEEDS = new Set([
  "ticket_required",
  "reservation_recommended",
  "guided_tour_optional",
  "intercity_transport",
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

  return lowValue.some(term => activity === term || activity.includes(` – ${term}`) || activity.includes(` - ${term}`));
}

function detectIntercity(row, destinationNames) {
  const from = clean(row?.from, 160).toLowerCase();
  const to = clean(row?.to, 160).toLowerCase();
  const transport = clean(row?.transport, 120).toLowerCase();
  const activity = clean(row?.activity, 240).toLowerCase();

  const cityHits = destinationNames.filter(name => {
    const n = name.toLowerCase();
    return from.includes(n) || to.includes(n) || activity.includes(n);
  });

  const intercityMode = /\b(train|tren|flight|vuelo|bus|coach|ferry|ferri|rail|ferrocarril|avión|avion)\b/i
    .test(`${transport} ${activity}`);

  return cityHits.length >= 2 || (intercityMode && Boolean(from) && Boolean(to));
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

      rows.forEach((row, index) => {
        if (!row || typeof row !== "object") return;

        const intercity = detectIntercity(row, destinationNames);
        if (!intercity && isLowValueRow(row)) return;

        const activity = normalizeActivity(row.activity, city);
        if (!activity && !intercity) return;

        candidates.push({
          candidate_id: `${day}-${index + 1}`,
          day,
          activity,
          notes: clean(row.notes, 320).replace(/^valid:\s*/i, ""),
          from: clean(row.from, 160),
          to: clean(row.to, 160),
          transport: clean(row.transport, 120),
          intercity_hint: intercity
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
- no_action

Rules:
1. Prefer no_action when there is no clear traveler action.
2. ticket_required means an admission/ticket is intrinsic to doing the named visit. Do not use it merely because advance booking can be convenient.
3. reservation_recommended means advance reservation is genuinely useful for the planned visit, but do not imply it is mandatory unless the source clearly supports that.
4. guided_tour_optional is optional and must never replace the planned activity. Use it only when a guided experience is a sensible enhancement for the exact activity already in the itinerary.
5. intercity_transport is only for actual city-to-city or equivalent long-distance movement already visible in the source.
6. Do not classify ordinary meals, hotel time, free time, neighborhood walks, generic transfers, or simple local movement unless the source clearly creates one of the allowed needs.
7. Never invent prices, availability, opening hours, rules, reservation deadlines, ticket types, providers, or affiliate products.
8. confidence must be high, medium, or low.
9. The user_message must be short, helpful, non-commercial, and written in ${outputLanguage}.
10. Use cautious language when the need can vary. Do not present uncertain claims as facts.
11. Return exactly one classification for every candidate_id.
12. reason is internal explanatory text, concise and factual; do not expose chain-of-thought.

Return valid JSON only:
{
  "classifications": [
    {
      "candidate_id": "1-1",
      "entity_name": "specific entity or route from the source",
      "entity_type": "attraction|museum|monument|site|experience|route|transport|other",
      "need_type": "ticket_required|reservation_recommended|guided_tour_optional|intercity_transport|no_action",
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
  if (needType === "intercity_transport") return "transport";
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

    if (needType === "no_action") continue;
    if (confidence === "low") continue;

    if (needType === "intercity_transport" && !source.intercity_hint) {
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
      entity_name: clean(raw?.entity_name, 180) || source.activity,
      entity_type: entityType,
      need_type: needType,
      confidence,
      user_message: clean(raw?.user_message, 300),
      source_activity: source.activity,
      source_route: [source.from, source.to].filter(Boolean).join(" → "),
      transport: source.transport
    });
  }

  // Keep one primary actionable need per source activity, plus one optional tour enhancement.
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
      item.need_type === "intercity_transport"
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

    if (!candidates.length) {
      return res.status(200).json({
        ok: true,
        context_version: "1.0",
        trip_id: trip.id,
        city,
        generated_at: new Date().toISOString(),
        needs: [],
        meta: {
          candidate_count: 0,
          visible_count: 0,
          persisted: false
        }
      });
    }

    const language = trip.language === "en" ? "en" : "es";
    const classifications = await classifyCandidates(city, candidates, language);
    const needs = sanitizeClassifications(candidates, classifications, city);

    return res.status(200).json({
      ok: true,
      context_version: "1.0",
      trip_id: trip.id,
      city,
      generated_at: new Date().toISOString(),
      needs,
      meta: {
        candidate_count: candidates.length,
        visible_count: needs.length,
        persisted: false
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
