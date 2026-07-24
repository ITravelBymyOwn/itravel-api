// /api/chat.js — v64 (master-plan lock + global timing/daylight; stage-safe) — ESM compatible on Vercel
// ✅ Keeps v58 interface: receives {mode, input/history/messages} and returns { text: "<string>" }.
// ✅ Does NOT break "info" mode: returns free text.
// ✅ Adjusts ONLY the planner prompt + parse/guardrails to enforce strong rules (prefer city_day, 2-line duration, auroras, macro-tours, etc.).
// ✅ SURGICAL ADJUSTMENT: "info" fully open (any topic) + planner/info respond in the REAL language of the user's content (any language).
// ✅ SURGICAL ADJUSTMENT: Info Chat "like ChatGPT": keeps context using messages/history and responds conversationally.
// ✅ SURGICAL ADJUSTMENT: Planner: forces use of ALL info in the Planner tab, especially Preferences/Restrictions/Special conditions + Travelers (if provided).

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

// ==============================
// Helpers
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function _lastUserText_(messages = []) {
  try {
    for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || "").toLowerCase() === "user") {
        return String(m?.content || "");
      }
    }
  } catch {}
  return "";
}

// ✅ NEW (ULTRA-SURGICAL): detect explicit language choice in the last user message.
// This is used ONLY to override output language when the user explicitly selects a language
// (e.g., "Português", "Espanol", "English", "Deutsch", "pt", "es", etc.).
function detectLanguageOverride(messages = []) {
  const raw = _lastUserText_(messages);
  const t = String(raw || "").trim();
  if (!t) return null;

  // Normalize: lowercase + remove accents + keep letters/spaces only
  const noAccents = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const cleaned = noAccents.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  // Only treat as "language pick" if it's short-ish (prevents normal sentences from triggering)
  // e.g., "Português", "pt", "Español", "English", "francais"
  const tokens = cleaned.split(" ").filter(Boolean);
  const joined = cleaned;

  // If user writes a long sentence, don't override
  if (joined.length > 28 && tokens.length > 2) return null;

  // Common language name / code aliases (include misspellings)
  const map = [
    { code: "en", names: ["en", "eng", "english", "ingles", "ingl", "anglais"] },
    { code: "es", names: ["es", "spa", "spanish", "espanol", "español", "castellano"] },
    { code: "pt", names: ["pt", "por", "portuguese", "portugues", "português", "portuges", "portugez"] },
    { code: "fr", names: ["fr", "fre", "french", "francais", "français", "frances", "francese"] },
    { code: "de", names: ["de", "ger", "german", "deutsch", "alemán", "aleman", "allemand"] },
    { code: "it", names: ["it", "ita", "italian", "italiano", "italienne"] },
  ];

  const isMatch = (val, candidate) => {
    if (!val || !candidate) return false;
    if (val === candidate) return true;
    // tolerate small typos by prefix match (safe because we limit length)
    if (val.length >= 3 && candidate.startsWith(val)) return true;
    if (candidate.length >= 3 && val.startsWith(candidate)) return true;
    return false;
  };

  // Check single token first (most common)
  if (tokens.length === 1) {
    const w = tokens[0];
    for (const entry of map) {
      for (const n of entry.names) {
        if (isMatch(w, n)) return entry.code;
      }
    }
    return null;
  }

  // If 2 tokens, allow things like "portuguese brazil" (still counts as pt)
  if (tokens.length === 2) {
    for (const entry of map) {
      for (const n of entry.names) {
        if (isMatch(tokens[0], n) || isMatch(tokens[1], n)) return entry.code;
      }
    }
  }

  return null;
}

// Simple multi-language detection (surgical): ONLY for fallback/guardrails when the model doesn't respond.
// Note: does NOT affect normal content (the model decides language via prompt).
function detectUserLang(messages = []) {
  const t = _lastUserText_(messages).trim();
  if (!t) return "en";

  const s = t.toLowerCase();

  // Strong Spanish signals
  if (/[¿¡ñáéíóúü]/i.test(t)) return "es";
  const esHits = (s.match(/\b(el|la|los|las|de|que|y|para|con|por|una|un|como|donde|qué|cuál|cuáles|cómo)\b/g) || [])
    .length;

  // Strong English signals
  const enHits = (s.match(/\b(the|and|for|with|to|from|what|which|how|where|when|please)\b/g) || []).length;

  // Strong French signals
  const frHits = (s.match(/\b(le|la|les|des|de|du|et|pour|avec|sans|où|quoi|quel|quelle|quels|quelles|s\'il|vous)\b/g) || [])
    .length;

  // Strong Italian signals
  const itHits = (s.match(/\b(il|lo|la|i|gli|le|di|che|e|per|con|senza|dove|cosa|quale|quali|grazie)\b/g) || []).length;

  // Strong German signals
  const deHits = (s.match(/\b(der|die|das|und|für|mit|ohne|wo|was|welche|welcher|bitte|danke)\b/g) || []).length;

  // Strong Portuguese signals
  const ptHits = (s.match(/\b(o|a|os|as|de|que|e|para|com|sem|onde|qual|quais|obrigado|por favor)\b/g) || []).length;

  const scores = [
    ["en", enHits],
    ["es", esHits],
    ["fr", frHits],
    ["it", itHits],
    ["de", deHits],
    ["pt", ptHits],
  ];

  scores.sort((a, b) => (b?.[1] || 0) - (a?.[1] || 0));
  const top = scores[0];
  const topLang = String(top?.[0] || "en");
  const topScore = Number(top?.[1] || 0);

  // If there are no clear signals, default to EN (so your fallback is consistent)
  if (!topScore) return "en";
  return topLang;
}

// v52.5-style robust JSON extraction (surgical: replaces cleanToJSON without changing external usage)
function cleanToJSON(raw = "") {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw);
  } catch {}

  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  } catch {}

  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}

  return null;
}

function fallbackJSON(lang = "en") {
  // Fallback is always English (surgical: avoid partial translations here)
  return {
    destination: "Unknown",
    city_day: [
      {
        city: "Unknown",
        day: 1,
        rows: [
          {
            day: 1,
            start: "09:30",
            end: "11:00",
            activity: "Unknown – Base itinerary (fallback)",
            from: "Hotel",
            to: "Center",
            transport: "Walk or local transport (depending on location)",
            duration: "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat",
            notes: "⚠️ I couldn't generate the itinerary. Check your API key/deployment and try again.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: "⚠️ Local fallback: check your Vercel config or API key.",
  };
}

// Guard-rail: avoids a blank table if the model fails in planner
function skeletonCityDay(destination = "Destination", daysTotal = 1, lang = "en") {
  // Skeleton is always English (surgical: avoid partial translations here)
  const city = String(destination || "Destination").trim() || "Destination";
  const n = Math.max(1, Number(daysTotal) || 1);
  const blocks = [];

  for (let d = 1; d <= n; d++) {
    blocks.push({
      city,
      day: d,
      rows: [
        {
          day: d,
          start: "09:30",
          end: "11:00",
          activity: `${city} – Retry generation (itinerary pending)`,
          from: "Hotel",
          to: "Center",
          transport: "Walk or local transport (depending on location)",
          duration: "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat",
          notes:
            "⚠️ No valid itinerary was produced in this attempt. Retry or adjust conditions; when it works, you’ll see the final plan here.",
          kind: "",
          zone: "",
        },
      ],
    });
  }

  return blocks;
}

function _normalizeDurationText_(txt) {
  const s = String(txt ?? "").trim();
  if (!s) return s;

  // "Transport: X, Activity: Y" => 2 lines
  if (/Transport\s*:/i.test(s) && /Activity\s*:/i.test(s) && s.includes(",")) {
    return s.replace(/\s*,\s*Activity\s*:/i, "\nActivity:");
  }

  // If it comes in a single line without line breaks but has both labels, try forcing split with common separators
  if (/Transport\s*:/i.test(s) && /Activity\s*:/i.test(s) && !s.includes("\n")) {
    const tmp = s.replace(/\s*\|\s*/g, ", ").replace(/\s*;\s*/g, ", ");
    if (tmp.includes(",")) return tmp.replace(/\s*,\s*Activity\s*:/i, "\nActivity:");
  }

  return s;
}

function _hasAnyRows_(city_day) {
  if (!Array.isArray(city_day) || !city_day.length) return false;
  return city_day.some((b) => Array.isArray(b?.rows) && b.rows.length > 0);
}

function _normalizeCityDayShape_(city_day, destinationFallback = "") {
  const blocks = Array.isArray(city_day) ? city_day : [];
  const out = blocks
    .map((b, idx) => ({
      city: String(b?.city || b?.destination || destinationFallback || "").trim(),
      day: Number(b?.day) || idx + 1,
      rows: Array.isArray(b?.rows) ? b.rows : [],
    }))
    .sort((a, b) => a.day - b.day);

  out.forEach((b) => {
    b.rows = (Array.isArray(b.rows) ? b.rows : []).map((r) => ({
      ...r,
      day: Number(r?.day) || b.day,
      duration: _normalizeDurationText_(r?.duration),
      kind: r?.kind ?? "",
      zone: r?.zone ?? "",
    }));
  });

  return out;
}

function normalizeParsed(parsed) {
  if (!parsed) return parsed;

  try {
    // Prefer city_day; if legacy rows arrive, keep them for compat but the frontend ideally uses city_day
    if (Array.isArray(parsed.city_day)) {
      const dest = String(parsed?.destination || "").trim();
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
    }

    // If the model returned legacy "rows", normalize duration/kind/zone too
    if (Array.isArray(parsed.rows)) {
      parsed.rows = parsed.rows.map((r) => ({
        ...r,
        duration: _normalizeDurationText_(r?.duration),
        kind: r?.kind ?? "",
        zone: r?.zone ?? "",
      }));
    }

    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d?.rows)
          ? d.rows.map((r) => ({
              ...r,
              duration: _normalizeDurationText_(r?.duration),
              kind: r?.kind ?? "",
              zone: r?.zone ?? "",
            }))
          : d.rows,
        city_day: Array.isArray(d?.city_day)
          ? _normalizeCityDayShape_(d.city_day, d?.name || d?.destination || "")
          : d.city_day,
      }));
    }
  } catch {}

  return parsed;
}


// ==============================
// v62 — Stage-aware global quality layer
// IMPORTANT: preserves the current staged contract used by planner.js.
// ==============================

const ITBMO_FINAL_REPAIR_ENABLED =
  String(process.env.ITBMO_FINAL_REPAIR_ENABLED || "false").toLowerCase() === "true";

function _allMessageText_(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => String(m?.content || ""))
    .join("\n\n");
}

function detectPlannerStage(messages = []) {
  const text = _allMessageText_(messages);
  const s = text.toLowerCase();

  // The frontend's staged planner sends explicit strategic/master-plan instructions.
  // These responses must pass through without being forced into city_day.
  if (
    /\[master\s*plan\]/i.test(text) ||
    /\bmaster[_\s-]*plan\b/i.test(text) ||
    /\bmaster\s+day\s+plan\b/i.test(text) ||
    /\bstrategic\s+plan\b/i.test(text) ||
    /\bday\s+identit(?:y|ies)\b/i.test(text) ||
    /\bday\s+buckets?\b/i.test(text) ||
    /\bdo\s+not\s+generate\s+(?:final\s+)?rows\b/i.test(text)
  ) {
    return "master_plan";
  }

  if (
    /\bcity_day\b/i.test(text) ||
    /\bgenerate\s+(?:the\s+)?(?:final\s+)?itinerary\b/i.test(text) ||
    /\bgenerate\s+(?:rows|day\s+rows|itinerary\s+rows)\b/i.test(text) ||
    /\busing\s+(?:the\s+)?master\s+plan\b/i.test(text) ||
    /\bday\s+generation\b/i.test(text)
  ) {
    return "itinerary";
  }

  return "one_shot";
}

const MASTER_PLAN_QUALITY_LAYER = `
MASTER-PLAN STAGE — PRESERVE THE REQUESTED INTERMEDIATE SCHEMA:

This is the trip-wide strategic stage. The current frontend keeps only each row's day and activity
theme, so the activity value must preserve the strategic decisions required by later block calls.

SCHEMA AND COMPATIBILITY
- Follow the exact JSON schema requested by the frontend.
- Do NOT force city_day or final itinerary rows when the frontend requests a strategic Format B.
- Return exactly one strategic row for every requested day and no extra rows.
- Keep all required row fields present so the existing frontend parser continues to work.
- Return JSON only.

MANDATORY ACTIVITY FORMAT
Use:
"PLAN – <exclusive day identity and geographic corridor> | Anchors: <3–8 reserved anchors or experience categories>"

Examples are structural only:
"PLAN – Arrival and compact historic core | Anchors: central square, cathedral exterior, waterfront"
"PLAN – Northern regional corridor | Anchors: waterfall A, village B, thermal experience C"

The text after "PLAN –" is passed unchanged to the block generator. Therefore:
- Name one EXCLUSIVE corridor/bucket per day.
- List the principal anchors reserved for that day.
- Do not repeat a major anchor, attraction, neighborhood, regional corridor, macro-tour, spa,
  wildlife experience or equivalent alias in another day's theme.
- If a day is intentionally light because of arrival/departure or a short user window, say so in
  the identity instead of recycling earlier attractions.

TRIP-WIDE ALLOCATION
Before returning JSON, internally build a reservation ledger:
1. classify the base as dense city, gateway/outward base, hybrid, nature base, island/relax base,
   or multi-base road trip;
2. rank the strongest feasible city, regional, nature, culture, wellness, wildlife, food,
   adventure and seasonal buckets;
3. assign each selected bucket to one day only;
4. reserve every major anchor to one day only;
5. audit all day themes together for duplicate corridors and duplicate anchors.

For stays of five or more days:
- Strong unused regional or signature experiences must be consumed before a second weak urban
  filler day, when season, daylight, distance, safety and traveler profile make them feasible.
- At a gateway/outward base, outward/regional/special days should normally outnumber generic city
  filler days.
- Do not split one coherent macro-route into two days merely to fill the calendar.
- Do not schedule a macro-route plus its anchor experience on one day and then repeat that anchor
  or route as a separate day.
- The arrival and final days must have different scopes and reserved anchors.
- If the requested duration is longer than the premium inventory, a lighter day is preferable to
  repetition. Do not fabricate novelty.

DATE, DAYLIGHT AND ANCHOR TIME
- Use actual dates, latitude/season, daily windows, lodging/base and transport.
- Protect plausible useful daylight for landscape-dependent outdoor buckets.
- Use darkness for transfers, indoor activities, meals, thermal experiences and optional night
  opportunities.
- Reserve realistic dwell for immersive anchors: thermal lagoons/spas, wildlife or whale-watching
  cruises, guided tours, large museums, theme parks, archaeological complexes and substantial
  hikes. Do not assign more daytime stops than can realistically coexist with the anchor.

GLOBALITY
- These rules apply to every destination worldwide.
- Destination examples in the base prompt are curatorial support only; never let them override
  the user's actual destination, date or constraints.
`.trim();

const FINAL_ITINERARY_QUALITY_LAYER = `
FINAL ITINERARY QUALITY LAYER — GLOBAL, BLOCK-SAFE AND DESTINATION-INDEPENDENT

Apply these rules only when producing actual itinerary rows.

1. MASTER-THEME LOCK — HIGHEST PRIORITY
- The supplied day themes are approved trip-wide reservations from the Master Plan.
- Treat each theme's identity, corridor and listed Anchors as the exclusive scope of that day.
- Do not replace, broaden or duplicate the theme with a different corridor.
- Do not add famous attractions merely because they are nearby or popular if they are not part of
  the supplied day's scope.
- Within the current request, compare all supplied day themes and keep their POIs, corridors,
  neighborhoods, macro-routes and experience types distinct.
- One coherent macro-route may appear on only one day. One major anchor may appear on only one day.
- If the theme is intentionally light, keep it light. Never recycle earlier icons to make it look full.

2. DATE, SEASON AND USEFUL DAYLIGHT
- The actual date and destination latitude are hard planning inputs.
- Infer a plausible useful-daylight window before placing scenic outdoor activities.
- Schedule landscape-, viewpoint-, beach-, waterfall-, cliff-, trail- and photography-dependent
  stops within useful daylight.
- Use darkness for long transfers, indoor activities, meals, thermal experiences and conditional
  night opportunities.
- If the desired route does not fit daylight, reduce optional stops; do not move them into darkness.
- Never claim live weather, road, sea, volcanic, opening-hour or visibility information. Tell the
  traveler to confirm those conditions when relevant.

3. REALISTIC EXPERIENCE DWELL — CATEGORY-BASED
Before assigning a row duration, classify the experience:
- destination thermal lagoon / major hot-spring or spa complex: normally 2h30–4h;
- an iconic thermal lagoon comparable to Blue Lagoon: minimum 3h of actual experience time, plus
  realistic arrival, parking, check-in, changing, shower and exit logistics when material;
- whale watching / wildlife cruise / marine safari: normally 2h30–4h of activity time, plus
  check-in, boarding and disembarkation logistics;
- substantial guided walking or food tour: normally 2h30–4h;
- large museum or major immersive exhibition: normally 1h30–3h;
- major theme park, palace or archaeological complex: normally 3h to a full day;
- substantial hike: include the complete outbound and return walking time, adjusted for terrain,
  traveler profile and season;
- simple viewpoint/photo stop: normally 15–45m.

These are global category rules, not destination hardcoding.
If an experience cannot receive its useful minimum inside the user's window, move it, reduce the
day's scope or omit it. Never publish a misleadingly short visit.

4. TIME MATHEMATICS AND TRANSFERS
- Every row interval must contain transport plus activity.
- Minimum transport + minimum activity must fit between start and end.
- Include parking, walking from parking, check-in, security, boarding, changing or pickup time when
  operationally necessary.
- No overlaps, teleporting or unexplained giant gaps.
- Every regional/day-trip day must end with an explicit return to the lodging/base unless the user
  sleeps elsewhere.
- Estimate long returns conservatively from the actual final stop to the actual lodging/base.
- Do not shorten a return simply to fit the requested end time; instead remove an optional stop.
- A pure return row must use only a short arrival/parking/settling activity buffer, normally 5–20m.
- Duration must have exactly two lines:
  Transport: <realistic estimate or range>
  Activity: <realistic estimate or range>
- Under one hour use minutes. From one hour onward use hours/minutes. Never use 0h or 0m.

5. MACRO-ROUTES AND MICRO-STOPS
- For a regional route, first inventory the strongest logical stops on that exact corridor.
- Select the best feasible subset according to route continuity, daylight, safety, traveler fit and
  anchor dwell time.
- Important sub-stops must be separate rows rather than hidden only in Notes.
- A rich regional day will often contain 6–10 meaningful rows, but quality and feasibility are more
  important than row count.
- Do not add a weak museum, generic café or filler stop at the expense of a signature on-route stop.
- Avoid backtracking and do not revisit the same route on another day.

6. TRANSPORT AND LOCATIONS
- Choose transport per leg.
- Prefer walking for compact, safe urban clusters even when a rental car exists.
- Rental-car wording belongs in transport, never in hotel/from/to names.
- Every To field must contain one concrete primary place, not alternatives or slash-separated choices.
- From should continue from the previous row's To.

7. CONDITIONAL AURORA / NIGHT OPPORTUNITIES
- Aurora content is forbidden outside plausible auroral latitude and season.
- When plausible, do not promise sightings and do not force a rigid main activity row.
- Add a concise note to 1–3 suitable evening/end-of-day rows, beginning only after a plausible dark hour.
- Explain that the traveler may either drive independently to a safe dark area when roads/weather
  permit or book a paid guided tour.
- State that cloud cover, geomagnetic activity, road conditions and visibility must be checked.
- Do not repeat an identical aurora note every night.

8. QUALITY
- Use one selected language for all user-facing values.
- Preserve official proper names but translate generic instructions.
- Remove debug, placeholder and internal-planning wording.
- Silently audit the requested block for scope fidelity, duplicates, daylight, duration mathematics,
  transfers, continuity, returns and language before returning JSON.
`.trim();

function buildStagePrompt(basePrompt, stage) {
  if (stage === "master_plan") {
    return `${MASTER_PLAN_QUALITY_LAYER}\n\n${basePrompt}`.trim();
  }
  return `${FINAL_ITINERARY_QUALITY_LAYER}\n\n${basePrompt}`.trim();
}

// Master-plan responses can legitimately use a schema other than city_day.
function _isNonEmptyJSON_(value) {
  if (Array.isArray(value)) return value.length > 0;
  return !!value && typeof value === "object" && Object.keys(value).length > 0;
}


function _v64MasterRows_(parsed) {
  if (!parsed || typeof parsed !== "object") return [];

  if (Array.isArray(parsed.rows)) return parsed.rows;

  if (Array.isArray(parsed.city_day)) {
    return parsed.city_day.flatMap((block) =>
      (Array.isArray(block?.rows) ? block.rows : []).map((row) => ({
        ...row,
        day: Number(row?.day) || Number(block?.day) || 0,
      }))
    );
  }

  for (const key of ["destinations", "itineraries"]) {
    if (!Array.isArray(parsed?.[key])) continue;
    const all = [];
    for (const item of parsed[key]) {
      if (Array.isArray(item?.rows)) all.push(...item.rows);
      if (Array.isArray(item?.city_day)) {
        for (const block of item.city_day) {
          all.push(
            ...(Array.isArray(block?.rows) ? block.rows : []).map((row) => ({
              ...row,
              day: Number(row?.day) || Number(block?.day) || 0,
            }))
          );
        }
      }
    }
    if (all.length) return all;
  }

  return [];
}

function _v64MasterNorm_(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^.*?\bplan\b\s*[–-]\s*/i, "")
    .replace(/\banchors?\s*:/gi, " ")
    .replace(/[|/(),;:]+/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _v64MasterTokens_(value = "") {
  const stop = new Set([
    "and","or","the","of","to","in","for","with","from","day","route","tour","area",
    "city","local","core","light","arrival","departure","final","orientation","experience",
    "y","o","el","la","los","las","de","del","al","en","con","para","por","dia","día",
    "ruta","tour","area","área","ciudad","local","ligero","llegada","salida","final",
    "e","ou","do","da","dos","das","com","para","por","jour","et","ou","de","du","des",
    "avec","pour","und","oder","der","die","das","mit","fur","für"
  ]);

  return [...new Set(
    _v64MasterNorm_(value)
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stop.has(token))
  )];
}

function _v64MasterSimilarity_(a = "", b = "") {
  const A = new Set(_v64MasterTokens_(a));
  const B = new Set(_v64MasterTokens_(b));
  if (!A.size || !B.size) return 0;

  let intersection = 0;
  for (const token of A) if (B.has(token)) intersection += 1;
  return intersection / Math.min(A.size, B.size);
}

function _v64ExtractMasterScope_(activity = "") {
  const raw = String(activity || "").trim();
  const withoutPlan = raw.replace(/^.*?\bPLAN\b\s*[–-]\s*/i, "").trim();
  const parts = withoutPlan.split("|");
  const identity = String(parts[0] || withoutPlan).trim();
  const anchors = String(parts.slice(1).join(" | ") || "").trim();
  return { raw, identity, anchors };
}

function _v64AuditMasterPlan_(parsed, expectedDays = 0) {
  const rows = _v64MasterRows_(parsed);
  const errors = [];
  const usable = rows
    .map((row) => ({
      day: Number(row?.day) || 0,
      ..._v64ExtractMasterScope_(row?.activity),
    }))
    .filter((row) => row.day > 0);

  if (expectedDays > 0) {
    const daySet = new Set(usable.map((row) => row.day));
    for (let day = 1; day <= expectedDays; day += 1) {
      if (!daySet.has(day)) errors.push({ code: "MASTER_MISSING_DAY", day });
    }
    if (usable.length !== expectedDays) {
      errors.push({
        code: "MASTER_ROW_COUNT",
        expected: expectedDays,
        actual: usable.length,
      });
    }
  }

  for (const row of usable) {
    if (!/\|\s*anchors?\s*:/i.test(row.raw)) {
      errors.push({
        code: "MASTER_SCOPE_NOT_LOCKED",
        day: row.day,
        instruction:
          'Use activity format "PLAN – <exclusive identity/corridor> | Anchors: <reserved anchors>".',
      });
    }
  }

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];

      const identityA = _v64MasterNorm_(a.identity);
      const identityB = _v64MasterNorm_(b.identity);
      const anchorA = _v64MasterNorm_(a.anchors);
      const anchorB = _v64MasterNorm_(b.anchors);

      const sameIdentity =
        identityA &&
        identityB &&
        (identityA === identityB ||
          (identityA.length >= 8 &&
            identityB.length >= 8 &&
            (identityA.includes(identityB) || identityB.includes(identityA))) ||
          _v64MasterSimilarity_(identityA, identityB) >= 0.6);

      const anchorSimilarity = _v64MasterSimilarity_(anchorA, anchorB);
      const sameAnchor =
        anchorA &&
        anchorB &&
        (anchorA === anchorB ||
          (anchorA.length >= 8 &&
            anchorB.length >= 8 &&
            (anchorA.includes(anchorB) || anchorB.includes(anchorA))) ||
          anchorSimilarity >= 0.5);

      if (sameIdentity) {
        errors.push({
          code: "MASTER_DUPLICATE_SCOPE",
          days: [a.day, b.day],
          first: a.identity,
          second: b.identity,
        });
      }

      if (sameAnchor) {
        errors.push({
          code: "MASTER_DUPLICATE_ANCHORS",
          days: [a.day, b.day],
          first: a.anchors,
          second: b.anchors,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    rows: usable,
  };
}

function _v64ExpectedMasterDays_(messages = []) {
  const text = _allMessageText_(messages);
  const patterns = [
    /create\s+(?:a\s+)?strategic\s+distribution\s+plan\s+only.*?\((\d+)\s+day/i,
    /exactly\s+(\d+)\s+rows\s+total/i,
    /day\s+1\s+to\s+day\s+(\d+)/i,
    /(\d+)\s+day\/s/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return Math.max(1, Number(match[1]) || 0);
  }
  return 0;
}

async function _v64RepairMasterPlanOnce_(
  parsed,
  report,
  effectivePrompt,
  clientMessages,
  expectedDays
) {
  if (!parsed || report.ok) return null;

  const repairPrompt = `${effectivePrompt}

MASTER-PLAN SURGICAL REPAIR:
- Return the complete strategic plan in exactly the same JSON schema as the draft.
- Return exactly ${expectedDays || "the requested number of"} rows, one per requested day.
- Keep every user-provided daily window, date, base, transport, preference and restriction.
- Every activity MUST use:
  "PLAN – <exclusive day identity and geographic corridor> | Anchors: <3–8 reserved anchors>"
- Rebuild only the conflicting scopes, but audit all rows together.
- No macro-route, region, neighborhood, major attraction, spa/thermal anchor, wildlife tour,
  museum anchor or equivalent alias may be reserved on two days.
- Do not split one coherent macro-route into multiple days.
- Prefer a lighter but distinct day over repetition.
- Preserve strong unused regional, nature, culture, wellness, wildlife, food and adventure buckets.
- JSON only.

DETERMINISTIC MASTER ERRORS:
${JSON.stringify(report.errors)}

CURRENT MASTER DRAFT:
${JSON.stringify(parsed)}
`.trim();

  const raw = await callStructured(
    [{ role: "system", content: repairPrompt }, ...clientMessages],
    0.12,
    6000,
    85000
  );

  const repaired = cleanToJSON(raw);
  return _isNonEmptyJSON_(repaired) ? repaired : null;
}

function _hasRenderableItinerary_(parsed) {
  return !!(
    parsed &&
    (Array.isArray(parsed.city_day) ||
      Array.isArray(parsed.rows) ||
      Array.isArray(parsed.destinations))
  );
}

function _v62NormKey_(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _v62ParseTime_(value = "") {
  const m = String(value || "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function _v62CleanLocation_(value = "") {
  return String(value || "")
    .replace(/\bclose\s+to\b/gi, "")
    .replace(/\brecommend\s*me\b/gi, "")
    .replace(/\brecommended\s+by\s+(the\s+)?planner\b/gi, "")
    .replace(/\bas\s+appropriate\b/gi, "")
    .replace(/,\s*(?:rental\s*car|rent[- ]?a[- ]?car|veh[ií]culo\s+alquilado|coche\s+alquilado|carro\s+alugado)\b/gi, "")
    .replace(/\(\s*(?:rental\s*car|veh[ií]culo\s+alquilado|coche\s+alquilado|carro\s+alugado)\s*\)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "")
    .trim();
}

function _v62DurationBounds_(value = "") {
  const original = String(value || "").trim();
  if (!original) return null;

  const normalize = (input) =>
    String(input || "")
      .toLowerCase()
      .replace(/,/g, ".")
      .replace(/[–—]/g, "-")
      .replace(/[~≈]/g, "")
      .replace(/\b(?:aprox(?:\.|imadamente)?|approx(?:\.|imately)?)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const parsePoint = (input) => {
    const s = normalize(input);
    if (!s) return null;

    const compact = s.match(/\b(\d+)\s*h\s*(\d{1,2})\b/);
    if (compact) return Number(compact[1]) * 60 + Number(compact[2]);

    const colon = s.match(/\b(\d{1,2}):(\d{2})\b/);
    if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

    let total = 0;
    let found = false;

    const hours = s.match(
      /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|hora|horas)\b/
    );
    const minutes = s.match(
      /(\d+)\s*(?:m|min|mins|minute|minutes|minuto|minutos)\b/
    );

    if (hours) {
      total += Math.round(Number(hours[1]) * 60);
      found = true;
    }
    if (minutes) {
      total += Number(minutes[1]);
      found = true;
    }

    if (!found) {
      const bare = s.match(/^\d+(?:\.\d+)?$/);
      if (bare) return Math.round(Number(bare[0]));
    }

    return found && total > 0 ? total : null;
  };

  const s = normalize(original);
  const parts = s.split(/\s*-\s*/).filter(Boolean);

  if (parts.length >= 2) {
    let first = parsePoint(parts[0]);
    let second = parsePoint(parts[1]);

    // Shared trailing unit: "45-60 min", "1.5-2 h".
    if (first != null && second == null) {
      if (/\b(?:m|min|mins|minute|minutes|minuto|minutos)\b/.test(parts[1])) {
        first = parsePoint(`${parts[0]} min`);
      } else if (/\b(?:h|hr|hrs|hour|hours|hora|horas)\b/.test(parts[1])) {
        first = parsePoint(`${parts[0]} h`);
      }
      second = parsePoint(parts[1]);
    }

    if (first != null && second != null) {
      return { min: Math.min(first, second), max: Math.max(first, second) };
    }
  }

  const single = parsePoint(s);
  return single != null ? { min: single, max: single } : null;
}

function _v62ExtractDurationPart_(duration = "", labels = []) {
  const source = String(duration || "");
  for (const label of labels) {
    const match = source.match(new RegExp(`${label}\\s*:\\s*([^\\n|;]+)`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function _v62FormatMinutes_(minutes) {
  const n = Math.max(1, Math.round(Number(minutes) || 1));
  if (n < 60) return `~${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
}

function _v62NormalizeDuration_(row = {}) {
  const raw = String(row?.duration || "");
  const transportRaw = _v62ExtractDurationPart_(raw, ["Transport", "Transporte"]);
  const activityRaw = _v62ExtractDurationPart_(raw, [
    "Activity",
    "Actividad",
    "Atividade",
    "Activité",
    "Aktivität",
    "Attività",
  ]);

  const transport = _v62DurationBounds_(transportRaw);
  const activity = _v62DurationBounds_(activityRaw);

  if (transport && activity) {
    return `Transport: ${_v62FormatMinutes_(transport.min)}\nActivity: ${_v62FormatMinutes_(activity.min)}`;
  }

  return _normalizeDurationText_(raw);
}

function _v62NormalizeFinalParsed_(parsed) {
  parsed = normalizeParsed(parsed);
  if (!parsed || typeof parsed !== "object") return parsed;

  try {
    if (Array.isArray(parsed.city_day)) {
      parsed.city_day = parsed.city_day.map((block) => {
        let previousTo = "";
        const day = Number(block?.day) || 1;

        const rows = (Array.isArray(block?.rows) ? block.rows : []).map((row) => {
          const activity = String(row?.activity || "").replace(/\s+/g, " ").trim();
          const from =
            _v62CleanLocation_(row?.from) ||
            _v62CleanLocation_(previousTo) ||
            "Hotel";
          const inferredTo = activity.split(/\s+[–-]\s+/).pop() || "Destination";
          const to =
            _v62CleanLocation_(row?.to) ||
            _v62CleanLocation_(inferredTo) ||
            "Destination";

          const normalized = {
            ...row,
            day: Number(row?.day) || day,
            activity,
            from,
            to,
            transport: String(row?.transport || "").replace(/\s+/g, " ").trim(),
            duration: _v62NormalizeDuration_(row),
            notes: String(row?.notes || "").replace(/\s+/g, " ").trim(),
            kind: row?.kind ?? "",
            zone: row?.zone ?? "",
          };

          previousTo = normalized.to;
          return normalized;
        });

        return { ...block, day, rows };
      });
    }
  } catch {}

  return parsed;
}

function _v62IsTransitNode_(value = "") {
  return /\b(hotel|hostel|apartment|apartamento|alojamiento|accommodation|airport|aeropuerto|aeroporto|station|estacion|estacao|terminal|parking|car park|base city|centro|city center|city centre)\b/.test(
    _v62NormKey_(value)
  );
}

function _v62CanonicalPoi_(row = {}) {
  if (
    /\b(breakfast|lunch|dinner|brunch|restaurant|cafe|desayuno|almuerzo|cena|restaurante|almoço|jantar)\b/i.test(
      `${row?.activity || ""} ${row?.to || ""}`
    )
  ) {
    return "";
  }

  const raw = String(row?.to || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\/.*$/g, " ");
  let key = _v62NormKey_(raw);

  if (!key || _v62IsTransitNode_(key)) return "";

  key = key
    .replace(/\b(parking|entrance|entrada|reception|recepcion|visitor center|visitor centre|mirador|viewpoint|tower|torre|exterior|interior|concert hall|hall)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return key.length >= 5 ? key : "";
}


function _v64ExperienceProfile_(row = {}) {
  const text = _v62NormKey_(
    `${row?.activity || ""} ${row?.to || ""} ${row?.notes || ""}`
  );

  if (/\bblue lagoon\b|\bbl[aá]a l[oó]ni[dð]\b/.test(text)) {
    return { type: "iconic_thermal_lagoon", minimumActivityMinutes: 180 };
  }

  if (
    /\bthermal lagoon\b|\bhot springs?\b|\bthermal baths?\b|\bgeothermal spa\b|\bonsen\b|\bhammam\b|\bspa complex\b|\bbalneario\b|\btermas\b|\bbanos termales\b|\bbaños termales\b|\baguas termales\b|\blaguna termal\b/.test(text)
  ) {
    return { type: "destination_thermal_experience", minimumActivityMinutes: 150 };
  }

  if (
    /\bwhale watching\b|\bavistamiento de ballenas\b|\bavistamiento de cetaceos\b|\bavistamiento de cetáceos\b|\bwildlife cruise\b|\bmarine safari\b|\bdolphin watching\b|\bboat safari\b|\bsafari marino\b|\bobservacao de baleias\b|\bobservação de baleias\b/.test(text)
  ) {
    return { type: "wildlife_marine_tour", minimumActivityMinutes: 150 };
  }

  if (
    /\bfood tour\b|\bgastronomic tour\b|\bgastronomy tour\b|\btour gastronomico\b|\btour gastronómico\b|\bculinary tour\b|\bguided walking tour\b/.test(text)
  ) {
    return { type: "substantial_guided_tour", minimumActivityMinutes: 150 };
  }

  if (
    /\btheme park\b|\bamusement park\b|\bparque tematico\b|\bparque temático\b|\bmajor archaeological site\b|\bgran complejo arqueologico\b|\bgran complejo arqueológico\b/.test(text)
  ) {
    return { type: "major_complex", minimumActivityMinutes: 180 };
  }

  if (
    /\bmajor museum\b|\bimmersive exhibition\b|\bgran museo\b|\bmuseo nacional\b|\bnational museum\b/.test(text)
  ) {
    return { type: "major_museum", minimumActivityMinutes: 90 };
  }

  return { type: "", minimumActivityMinutes: 0 };
}

function _v64IsReturnRow_(row = {}) {
  const text = _v62NormKey_(`${row?.activity || ""} ${row?.to || ""}`);
  return /\b(return|back to|regreso|retorno|regresso|volta|volver|vuelta)\b/.test(text);
}

function _v62ValidateFinal_(parsed) {
  const errors = [];
  const cityDay = Array.isArray(parsed?.city_day) ? parsed.city_day : [];

  if (!cityDay.length) {
    return { ok: true, errors: [], affected_days: [] };
  }

  const poiMap = new Map();

  for (const block of cityDay) {
    const day = Number(block?.day) || 0;
    const rows = Array.isArray(block?.rows) ? block.rows : [];
    let previousEnd = null;
    let previousTo = "";

    rows.forEach((row, index) => {
      const rowNumber = index + 1;
      const start = _v62ParseTime_(row?.start);
      const end = _v62ParseTime_(row?.end);

      if (start == null || end == null || start >= end) {
        errors.push({ code: "INVALID_TIME", day, row: rowNumber });
      }

      if (previousEnd != null && start != null && start < previousEnd) {
        errors.push({ code: "TIME_OVERLAP", day, row: rowNumber });
      }

      const transport = _v62DurationBounds_(
        _v62ExtractDurationPart_(row?.duration, ["Transport", "Transporte"])
      );
      const activity = _v62DurationBounds_(
        _v62ExtractDurationPart_(row?.duration, [
          "Activity",
          "Actividad",
          "Atividade",
          "Activité",
          "Aktivität",
          "Attività",
        ])
      );

      if (start != null && end != null && transport && activity) {
        const available = end - start;
        const needed = transport.min + activity.min;

        if (needed > available + 5) {
          errors.push({
            code: "DURATION_DOES_NOT_FIT",
            day,
            row: rowNumber,
            available_minutes: available,
            required_minutes: needed,
          });
        }

        const profile = _v64ExperienceProfile_(row);
        if (
          profile.minimumActivityMinutes > 0 &&
          activity.min < profile.minimumActivityMinutes
        ) {
          errors.push({
            code: "ANCHOR_DWELL_TOO_SHORT",
            day,
            row: rowNumber,
            experience_type: profile.type,
            actual_activity_minutes: activity.min,
            minimum_activity_minutes: profile.minimumActivityMinutes,
          });
        }

        if (_v64IsReturnRow_(row) && activity.min > 30) {
          errors.push({
            code: "RETURN_ACTIVITY_TOO_LONG",
            day,
            row: rowNumber,
            actual_activity_minutes: activity.min,
          });
        }
      }

      if (
        /\s\/\s|\bor similar\b|\bo similar\b|\bselected\b|\bseleccionados\b|\brecommended restaurant\b|\brestaurante recomendado\b/i.test(
          String(row?.to || "")
        )
      ) {
        errors.push({
          code: "AMBIGUOUS_DESTINATION",
          day,
          row: rowNumber,
          to: row?.to,
        });
      }

      if (
        /(?:,|\()\s*(?:rental\s*car|rent[- ]?a[- ]?car|veh[ií]culo\s+alquilado|coche\s+alquilado|carro\s+alugado)\b/i.test(
          `${row?.from || ""} ${row?.to || ""}`
        )
      ) {
        errors.push({
          code: "LOCATION_TRANSPORT_CONTAMINATION",
          day,
          row: rowNumber,
        });
      }

      if (index > 0 && previousTo) {
        const fromKey = _v62NormKey_(row?.from);
        const priorKey = _v62NormKey_(previousTo);
        const compatible =
          fromKey === priorKey ||
          fromKey.includes(priorKey) ||
          priorKey.includes(fromKey) ||
          (_v62IsTransitNode_(fromKey) && _v62IsTransitNode_(priorKey));

        if (!compatible) {
          errors.push({
            code: "CONTINUITY",
            day,
            row: rowNumber,
            expected_from: previousTo,
            actual_from: row?.from,
          });
        }
      }

      const poi = _v62CanonicalPoi_(row);
      if (poi) {
        if (!poiMap.has(poi)) poiMap.set(poi, []);
        poiMap.get(poi).push({ day, row: rowNumber });
      }

      previousEnd = end;
      previousTo = row?.to || "";
    });
  }

  const entries = [...poiMap.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i; j < entries.length; j++) {
      const [poiA, usesA] = entries[i];
      const [poiB, usesB] = entries[j];
      const same =
        poiA === poiB ||
        (i !== j &&
          poiA.length >= 7 &&
          poiB.length >= 7 &&
          (poiA.includes(poiB) || poiB.includes(poiA)));

      if (!same) continue;

      const uses = i === j ? usesA : [...usesA, ...usesB];
      const distinctDays = [...new Set(uses.map((use) => use.day))];

      if (distinctDays.length > 1) {
        errors.push({
          code: i === j ? "DUPLICATE_POI" : "DUPLICATE_POI_ALIAS",
          poi: i === j ? poiA : `${poiA} <> ${poiB}`,
          uses,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    affected_days: [
      ...new Set(
        errors.flatMap((error) => {
          const days = [];
          if (Number.isFinite(Number(error?.day))) days.push(Number(error.day));
          for (const use of Array.isArray(error?.uses) ? error.uses : []) {
            if (Number.isFinite(Number(use?.day))) days.push(Number(use.day));
          }
          return days;
        })
      ),
    ].sort((a, b) => a - b),
  };
}

async function _v62RepairFinalOnce_(
  parsed,
  report,
  effectivePrompt,
  clientMessages
) {
  if (!ITBMO_FINAL_REPAIR_ENABLED || report.ok) return null;

  const repairPrompt = `${effectivePrompt}

FINAL SURGICAL REPAIR:
- Return the complete itinerary in exactly the same external JSON schema as the draft.
- Correct every deterministic error listed below.
- Preserve all strong, distinct regional/signature days and all explicit must-includes.
- Do not replace a difficult regional day with repeated city attractions.
- Recalculate every affected row so transport + activity fits inside start/end.
- Remove duplicate major POIs across days, including aliases and subtitle variants.
- Remove rental-car wording from hotel/from/to fields.
- Use walking in compact urban clusters when practical.
- Correct season/daylight logic and include a conditional timed seasonal signature experience
  when globally appropriate.
- Return JSON only.

VALIDATION ERRORS:
${JSON.stringify(report.errors)}

CURRENT DRAFT:
${JSON.stringify(parsed)}
`.trim();

  const raw = await callStructured(
    [{ role: "system", content: repairPrompt }, ...clientMessages],
    0.12,
    9000,
    85000
  );

  const repaired = cleanToJSON(raw);
  if (!_hasRenderableItinerary_(repaired)) return null;

  return _v62NormalizeFinalParsed_(repaired);
}


// ==============================
// Improved base prompt ✨ (PLANNER) — Adjusted to v52.5 rules
// ==============================
const SYSTEM_PROMPT = `
You are Astra, the smart travel planner of ITravelByMyOwn.
Your output must be EXCLUSIVELY a valid JSON (no markdown, no backticks, no extra text).

LANGUAGE (CRITICAL):
Primary rule (highest priority):
- ALWAYS respond in the language explicitly selected by the user when the planner asks for the itinerary language.
- This selected language is the ONLY source of truth for the output language.
Secondary rule (fallback only):
- If no explicit language selection is provided, then:
  - Determine the language from the user's written content.
  - Ignore template/system labels (e.g., "Preferences", "Restrictions", "Start time", etc.).
  - Use only the natural language written by the user.
Mixed language handling:
- If the user mixes languages:
  • Prioritize the explicitly selected language.
  • If no selection exists, use the dominant language of the user's content.
  • If no dominant language exists, use the language of the last user entry.
Consistency (critical):
- The entire JSON output MUST be in ONE single language only.
- Do NOT mix languages inside the response.
- JSON keys must stay exactly as specified, but all user-facing values must use the selected/inferred language.
Translation rule:
- Do NOT translate into the site/system language unless explicitly requested by the user.
- The output must strictly follow the selected or inferred language rules above.

INTERNAL DESTINATION STRATEGY (CRITICAL — DO NOT OUTPUT THIS):
Before writing itinerary rows, you MUST internally complete these steps:
1) Classify the destination dynamically as one of:
   - dense_city
   - gateway_outward_base
   - hybrid_city_and_region
   - island_beach_relax
   - nature_adventure_base
   - roadtrip_multi_base
2) Build an internal MASTER DAY PLAN before generating rows.
3) Assign each day a unique day identity and bucket.
4) Rank all available buckets from strongest to weakest BEFORE choosing the final daily plan.
5) Generate rows only after the full day strategy is clear.
6) When the request supplies strategic themes in the form
   "PLAN – <identity/corridor> | Anchors: <reserved anchors>", treat them as a binding trip-wide
   reservation map. Generate only within that scope and do not introduce famous POIs from other
   days.

MASTER DAY PLAN RULES (CRITICAL — INTERNAL ONLY):
- Every day must have a clear unique role before rows are generated.
- Possible bucket types include:
  • arrival / light city orientation
  • core city highlights
  • distinct city district
  • flagship regional day trip
  • secondary regional day trip
  • special experience
  • food / local culture
  • wellness / thermal / spa
  • wildlife / marine / boat
  • mountain / cave / glacier / adventure
  • night highlight
  • final flexible day
- Do NOT generate rows by simply filling each day from top to bottom with museums, cafés, harbor walks, gardens, and dinners.
- For long stays, the itinerary must first allocate the strongest buckets, then generate activities inside each bucket.
- For 6+ day itineraries, weak urban filler must NOT displace stronger outward, regional, special, or iconic experiences.
- For gateway/outward-base destinations, regional and special-experience buckets must dominate over repeated city filler.
- For dense cities, city days can dominate, but each day must use a different district, rhythm, route logic, and emotional identity.
- For hybrid destinations, balance core city must-sees with strong outward experiences.
- A bucket may NOT be reused if another strong unused bucket exists.
- Days 5+ must NOT repeat the identity, rhythm, corridor, or experience type of earlier days.
- If two days would both be classified as weak "urban culture", replace one of them with the strongest remaining unused bucket.
- If the final itinerary would contain repeated day shapes, rebuild the affected day internally before returning JSON.

BUCKET EXHAUSTION RULE (CRITICAL — INTERNAL ONLY):
- Before using a weak urban filler bucket, verify that stronger unused buckets are not available.
- Weak urban filler includes:
  • secondary museums
  • generic gardens
  • repeated harbor walks
  • repeated cafés
  • repeated markets
  • repeated restaurants
  • generic cultural centers
  • museum + lunch + harbor/walk + dinner sequences
- Stronger buckets include:
  • flagship regional route
  • secondary regional route
  • iconic natural corridor
  • wellness / thermal / spa
  • wildlife / marine / boat
  • cave / glacier / mountain / valley / adventure
  • food culture that is truly distinctive
  • iconic night experience
  • scenic route with real sub-stops
- If a strong unused bucket exists, you MUST use it before creating another weak urban filler day.
- For 6–8 day itineraries, the last 2–3 days must still feel intentional and premium, not like leftovers.

INTERPRETATION POLICY (CRITICAL: do NOT over-obey):
- The user's Planner input contains a mix of: hard constraints, soft preferences, and suggestions.
- You MUST incorporate ALL user-provided information, but you must NOT treat everything as a hard rule.
- Classify internally (do NOT output the classification):
  1) HARD constraints: safety, mobility limitations, medical/allergy constraints, explicit "must/never",
     FIXED dates, any provided TIME WINDOWS, AND any explicit "I want to visit/do X" requests (must-include).
  2) SOFT preferences: "prefer", "would like", interests, budget direction, pace, style (unless clearly stated as must).
  3) SUGGESTIONS: optional ideas, examples, "if possible", or vague wishes.
- CRITICAL (Special conditions must-include places):
  • The user may type place names inside "Special conditions / Conditions" (e.g., "Montserrat", "Girona", "Toledo", "Versailles").
  • If the user explicitly lists places they want to visit (including inside conditions), treat them as MUST-INCLUDE.
  • If multiple must-include places are provided, you MUST schedule EACH of them at least once across the itinerary days (when feasible),
    distributing them across different days if days_total allows (do NOT silently drop one).
  • MUST-INCLUDE CONTRACT (no silent omissions):
    - Every MUST-INCLUDE place must appear in at least ONE row "activity" or "to" field.
    - If ANY MUST-INCLUDE place cannot be scheduled (distance/closed/time impossible), you MUST explain it in "followup" and propose the closest feasible alternative.
- If the user explicitly requests a place/activity (e.g., "I want Montserrat and Girona"), you MUST ensure it appears in the itinerary
  unless it is infeasible; if infeasible, propose the closest equivalent and explain briefly in notes.
- If there is a conflict (e.g., “no walking” vs “hiking”), prioritize safety/feasibility and propose an equivalent alternative.
- If a key detail is missing to satisfy a restriction, assume the minimum safe option and add a short note to confirm (do NOT break the itinerary).

TIME WINDOWS (PER-DAY HOURS) (CRITICAL):
- The user may provide start/end hours for some days and leave others blank.
- Treat ONLY provided hours as binding, PER DAY:
  • If a day has a provided start, the first row of that day MUST start at or after it.
  • If a day has a provided end, the LAST row of that day MUST end at or before it.
- IMPORTANT: start/end fields are PER ROW (per activity), not "day limits".
  • Do NOT set end time of every row to the day end time.
  • Only the final row may approach the day end.
  • NEVER create a first row that spans most/all of the day and then place additional rows inside that same window.
  • If there are multiple rows on a day, the first row MUST end before the next row starts.
- If a day has missing hours, do NOT invent strict limits; schedule with expert realistic hours.
- If only Day 1 start and Last Day end are provided, enforce those only; keep other days flexible.
- CRITICAL: absence of hours is NOT permission to create a short day, an almost empty day, or a generic free day.
- If a day has no provided hours, you MUST still build a full, well-paced day with realistic expert timing.

CONTEXT USAGE (CRITICAL):
- You must use ALL information provided by the user in the Planner tab.
- ESPECIALLY: Preferences / Restrictions / Special conditions (apply them in every decision: pace, schedules, mobility, budget, meals, accessibility, interests, safety, etc.).
- If the user provides traveler info (ages, kids, seniors, mobility, interests), actively incorporate it into: schedules, breaks, block durations, transport, activity types, and notes.
- If a traveler profile is incomplete, do not assume sensitive details; keep activities broadly suitable and add light notes.

PREFERRED FORMAT (new, table-ready):
A) {
  "destination":"City",
  "days_total":N,
  "city_day":[
    {"city":"City","day":1,"rows":[
      {
        "day":1,
        "start":"09:30",
        "end":"11:00",
        "activity":"DESTINATION – SUB-STOP",
        "from":"Origin place",
        "to":"Destination place",
        "transport":"Realistic transport",
        "duration":"Transport: ...\\nActivity: ...",
        "notes":"(>=20 chars) 1 emotional sentence + 1 logistical tip (+ alternative/condition if applicable)",
        "kind":"",
        "zone":""
      }
    ]}
  ],
  "followup":"short text"
}

LEGACY FORMATS (only if requested / for compat):
B) {"destination":"City","rows":[{...}],"followup":"short text"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"short text"}

GOLDEN RULE:
- MUST BE TABLE-READY: every row includes everything needed.
- ALWAYS return at least 1 renderable row (never a blank table).
- No text outside the JSON.

GENERAL RULES:
- Max 20 rows per day.
- GLOBAL ANTI-DUPLICATION (ULTRA-CRITICAL):
  • The itinerary MUST avoid repetition across days in ALL forms:
    - same POIs
    - same macro-routes
    - same regional circuits
    - same neighborhoods
    - same scenic loops
    - same sequence structure
    - same "shape" of the day
    - same emotional arc
    - same museum + food + walk pattern
    - same harbor/waterfront filler pattern
  • This applies EVEN IF the names are translated, abbreviated, paraphrased, misspelled, or written differently.
  • Treat equivalent routes/areas across languages and naming variants as the SAME underlying itinerary.
  • Examples of equivalent duplicates:
    - "Golden Circle" = "Golden Cycle" = "Círculo Dorado" = "Cercle d'Or" = "Circolo d'Oro"
    - "South Coast" = "Costa Sur" = "Côte Sud" = "Costa Sul"
    - "Snæfellsnes" = "Snaefellsnes Peninsula" = "Península de Snæfellsnes"
    - "Reykjanes Peninsula" = "Península de Reykjanes"
    - "Old Town" = "Centro histórico" = "Historic Center" = "Vieille Ville"
    - "Waterfront" = "Riverside" = "Harbor area" = "Promenade" when they refer to the same local corridor
  • The planner MUST reason semantically/geographically, not only textually.
  • If a macro-region, flagship route, neighborhood corridor, or major circuit has already been used, do NOT reuse it unless:
    - the destination genuinely has no strong alternative
    - AND the internal route is materially different.
  • Two days are considered duplicates if they share:
    - similar geography
    - similar stop progression
    - similar rhythm
    - similar emotional structure
    - similar route logic
    - similar meal/walk/museum sequence
    - or equivalent translated/paraphrased macro names.
  • Merely renaming stops is FORBIDDEN.
  • Every day must feel strategically different from the others.
- Local times must be realistic; if the user doesn't provide hours, decide as an expert.
- Times must be ordered and NOT overlap.
- from/to/transport: NEVER empty.
- Do NOT return "seed" or empty notes.
- Do NOT output internal words such as "fallback", "repair", "debug", "backup", "placeholder", or "itinerary pending" in user-facing fields.
- Do NOT use generic macro labels such as "Cultura y Naturaleza", "Culture and Nature", "Local Culture", "Urban Culture", "General Route", or "Scenic Route" as the left side of activity.

ANTI-EMPTY DAYS:
- If a day has a normal daytime window (>=6h) and no strict limitations, provide at least 4–15 rows (not 1–2).
- If a night-only item exists (e.g., aurora), do NOT make it the only row unless the user explicitly made that day night-only.
- For multi-day itineraries, you MUST distribute meaningful rows across ALL days.
- A day is NOT valid if it only contains a trivial placeholder like "free day", "last moments", or one single short stop, unless the user explicitly requested a light/rest day or the available time window is genuinely short.
- If the itinerary still has unscheduled key highlights and a day remains weak, you MUST use that day to place coherent remaining highlights.
- Regional/scenic/day-trip days MUST NOT contain giant dead gaps.
- If a regional day contains gaps larger than roughly 2h–2h30, you MUST enrich the route with REAL intermediate micro-stops from the same geographic corridor.
- Micro-stops must appear as REAL itinerary rows, not only inside notes.
- Examples of valid micro-stops:
  • viewpoints
  • waterfalls
  • cliffs
  • scenic cafés
  • lava fields
  • geothermal pockets
  • small villages
  • roadside landmarks
  • harbors
  • boardwalks
  • crater stops
  • coastal pullouts
  • local museums directly on-route
- The goal is to make regional days feel continuous, rich, and geographically coherent.

LONG-STAY CURATION RULES (GLOBAL):
- For itineraries of 5+ days, do NOT simply create more city filler.
- Before generating days, identify and rank:
  1) essential city highlights
  2) strongest regional/day-trip opportunities
  3) iconic special experiences
  4) food/culture/wellness/wildlife/adventure buckets
  5) final-day realistic options
- Strong unused buckets MUST be consumed before creating additional weak urban culture filler.
- Museums, gardens, cafés, harbor walks, markets, and generic cultural stops are LOW-PRIORITY buckets unless they are globally iconic or explicitly requested.
- A low-priority bucket may only be used after stronger regional, experiential, wellness, wildlife, geothermal, scenic, or adventure buckets have been exhausted or are infeasible.
- For 6–8 day stays:
  • Avoid more than 2–3 pure urban filler days unless the destination is truly a dense city with enough distinct world-class districts.
  • If the destination is a gateway/outward base, prioritize 3–5 outward/regional/special buckets when feasible.
  • If the destination is hybrid, include both city and outward buckets.
  • If the destination is dense city, split days by truly distinct districts/themes.
- The last 2 days must NOT degrade into repeated museums, harbor walks, cafés, gardens, and dinners if stronger unused buckets remain.
- If a day starts to look like a repeated prior day, internally rebuild it using a different stronger unused bucket.
- If a gateway/outward-base destination still has strong unused regional or special-experience buckets, do NOT create another generic urban day.

TIME INFERENCE + USEFUL DAYLIGHT (CRITICAL):
- User-provided per-day start/end times are HARD CONSTRAINTS and must be respected.
- Infer a plausible useful-daylight envelope from the actual date, latitude and season before
  placing scenic outdoor activities.
- Protect useful daylight for landscapes, viewpoints, beaches, trails, waterfalls and natural
  photography. Use darkness for transfers, indoor visits, meals, thermal experiences and
  conditional night opportunities.
- If the route does not fit, remove optional stops rather than moving scenic visits into darkness.
- If the user provides hours for SOME days only, you MUST:
  • Respect those exact per-day hours where provided.
  • Actively infer realistic start/end times for ALL other days and rows.
- Absence of hours is NOT a restriction.
- NEVER leave start or end empty.
- CRITICAL SEQUENCING:
  • For each day, rows MUST form a realistic sequence.
  • Each row's end time MUST be after its start time.
  • Each row's end time MUST be <= the next row's start time (allow small buffers).
  • If a day has a provided day-end time, ONLY the final row should end at/near that time.
    Do NOT repeat the day-end time as the end time for multiple rows.
  • CRITICAL CONTINUITY (no teleporting):
    - By default, the next row's "from" should match the previous row's "to" (or be an immediately plausible continuation).
    - If you need to switch context (e.g., "back to hotel"), add a realistic transfer row OR set "from" to the actual prior "to".
  • The row time block must be broadly consistent with its stated duration.
    - Do NOT output a row like 09:00–20:00 if duration says ~1h or ~2h.
- CRITICAL: first protect the realistic dwell time and operating logistics of the anchor
  experience. Only then may you add nearby coherent stops. Never shorten an immersive anchor or
  reuse another day's reserved POIs merely to make the day look fuller.

ONE-DAY ITINERARIES (DOUBLECHECK, IMPORTANT):
- If days_total = 1 (single-day itinerary), you MUST provide a well-detailed day plan:
  • Aim for 6–10 rows for a normal full day window.
  • If the available time window is short (e.g., <4h), provide 3–5 rows.
  • Do NOT return only 1–2 rows unless the user explicitly requests a minimal plan.
- Keep pacing realistic with breaks if travelers include kids/seniors/mobility limits.

TRANSPORT OPTIMIZATION (GLOBAL, ULTRA-IMPORTANT):
- For EVERY row, choose the MOST EFFICIENT and REALISTIC transport for that exact from->to pair.
- Use your internal knowledge of each city/region's common mobility options (metro/subway, bus, tram, urban rail, commuter rail, funicular, cable car, ferries, etc.).
- Do NOT default to "Walk" unless it is genuinely optimal (very short distance / same neighborhood / clearly pedestrian-friendly).
- If public transport is clearly faster/reliable, prefer it (e.g., Metro/Subway, Tram, Bus, Urban Rail).
- When needed, allow combined modes (e.g., "Metro + Funicular", "Metro + Cable car", "Metro + Bus").
- For DAY TRIPS from major cities, prefer the most efficient common option (often Train/Regional rail) unless the user explicitly prefers a guided tour or car.
- For compact urban movements inside the same city center, do NOT force rental car just because the user selected or mentioned rental car.
- Treat explicit transport preference as a global preference, not a blind mandate for every micro-transfer.
- Use rental car / guided tour mainly for regional, scenic, outward, rural, or poor-transit routes.
- For urban short hops, prefer walking, taxi, bus, tram, metro, or public transport when more realistic.
- Never leave transport blank; never use vague transport. If not 100% sure, still pick the best option and add a short notes tip.
- NEVER contaminate "from" or "to" with transport preference text such as "rental car", "guided tour", "recommend me", "recommended by planner", or "as appropriate".

MANDATORY ROW CONTRACT:
- day (number)
- start/end in HH:MM (local time)
- activity: ALWAYS "DESTINATION – SUB-STOP" (– or - with spaces). Generic like "museum", "park", "local restaurant" is forbidden.
  IMPORTANT (GLOBAL):
  - "DESTINATION" is NOT always the base city:
    • If the row belongs to a DAY TRIP / MACRO-TOUR, "DESTINATION" must be the macro-tour NAME (e.g., "Golden Circle", "South Coast", "Toledo", "Sinai", "Giza").
    • If it's NOT a day trip, "DESTINATION" can be the base city.
  - This also applies to transfers/returns:
    • Day trip example: "South Coast – Return to Reykjavik"
    • City example: "Budapest – Return to hotel"
  - CRITICAL GEOGRAPHIC SEMANTICS:
    • If the stop is clearly outside the base city, do NOT label it as "<Base city> – <Outside stop>" unless it is explicitly a departure or return row.
    • For out-of-city attractions, prefer the real area / corridor / macro-tour name as DESTINATION.
    • Example: avoid "Reykjavik – Blue Lagoon" as the main visit row; prefer a real external area/macro-tour label.
- duration: EXACTLY 2 lines with \\n:
  "Transport: <realistic estimate or ~range>"
  "Activity: <realistic estimate or ~range>"
  FORBIDDEN: "Transport: 0m" or "Activity: 0m"
- notes: required (>=20 chars), motivating and useful:
  1) 1 emotional sentence
  2) 1 logistical tip
  + condition/alternative if applicable
  + when relevant, add nearby logical pair information.

MEALS (Flexible rule):
- NOT mandatory.
- Include ONLY if they add real value to the flow.
- If included, NOT generic ("dinner at a local restaurant" forbidden).
- Meal stops must be specific enough to be useful:
  • use a named venue, a clearly identified food hall/harbor/market/street, or a concrete area with recognizable dining value.
  • avoid vague placeholders like "local restaurant" or "restaurant near attraction" as the main sub-stop.
- Do NOT use the same restaurant or same food corridor repeatedly across multiple days unless the user requested it.

HOURS / CLOSURES (GLOBAL, anti-impossible schedules):
- For places with typical hours (museums, castles, indoor monuments, baths/spas, markets), do NOT schedule visits outside a reasonable daytime window.
  Guideline if not 100% sure: 10:00–17:00 for indoor/museums.
- If the place may be closed on certain days and you are not sure, avoid extreme times and add in notes that exact hours should be confirmed.
- For viewpoints/bridges/outdoor areas, you can be more flexible.

NIGHT TOURS (GLOBAL, when applicable):
- If the destination has an iconic night highlight or classic night experience, include AT LEAST 1 iconic night activity.
- Keep realistic times (e.g., 19:00–23:30) and include a logistical tip in notes.

AURORAS (GLOBAL CONDITIONAL-NOTE RULE):
- FORBIDDEN unless latitude, season and darkness make them genuinely plausible.
- When plausible, never guarantee visibility and do not displace a stronger daytime plan.
- Add a concise conditional note to 1–3 suitable evening/end-of-day rows, beginning only after a
  plausible dark hour.
- Explain that the traveler may either drive independently to a safe dark viewing area when
  weather/roads permit or book a paid guided aurora tour.
- State that cloud cover, geomagnetic activity, road conditions and visibility must be checked.
- Do not repeat the same note every night; keep at least one backup opportunity when trip length permits.

DAY TRIPS / MACRO-TOURS:
- If you create a day trip, you must break it down into 5–15 sub-stops (rows) WHEN IT ADDS REAL VALUE.
- CRITICAL MICRO-STOPS RULE:
  • If a route naturally supports many worthwhile sub-stops, you MUST enrich the itinerary with those real intermediate stops instead of leaving large empty time gaps.
  • Strong regional routes should feel like expert-designed exploration days, not sparse skeleton itineraries.
  • A flagship regional day should usually contain around 6–10 meaningful rows when geography realistically supports it.
  • Micro-stops must be represented as actual rows whenever they materially improve continuity and richness.
  • Notes are NOT a replacement for real itinerary rows.
- FORBIDDEN umbrella rows:
  - Do NOT use generic activities like "Day trip to X", "Excursion to X", "Excursão de um dia", "Tour de 1 dia".
  - Each row must be either a named transport movement OR a named physical sub-stop.
  - The first row of a macro-tour must NEVER consume most of the day unless the transfer truly does.
- Always close with a dedicated return row:
  • Use the macro-tour "DESTINATION": "<Macro-tour> – Return to {Base city}".
- Avoid the last day if there are options, unless the last day has enough time and it is the best remaining bucket.
- For day trips, avoid optimistic timing: return from the LAST point must be realistic/conservative.
- CRITICAL: after the return row, do NOT jump "from" back to "Hotel" unless you add a realistic transfer row or the return row ends at/near the hotel.
- Do NOT propose a day trip just because it is theoretically possible.
  • A day trip must be good in real traveler experience, not dominated by exhausting transit.
  • If a route would create an excessively long round trip with low enjoyment, reject it and choose a better alternative closer to the base city.
- A macro-tour is NOT valid if:
  • it has too few useful rows for a normal full day,
  • it skips the logical signature highlights of that route,
  • it hides key highlights only in notes instead of rows,
  • or it lacks a dedicated realistic return row.
- GLOBAL REPEAT PREVENTION (CRITICAL):
  • NEVER repeat the same flagship regional route twice in one itinerary unless there is truly no strong alternative.
  • Before generating a regional day, mentally verify that the same macro-region/circuit has not already been used in another day.
  • This verification must be semantic and geographic, NOT textual.
  • Equivalent translated names, paraphrases, common misspellings, tourism nicknames, and alternate-language names count as duplicates.
  • If a prior day already covered a regional circuit, the next regional day must use a DIFFERENT:
    - geography
    - macro-cluster
    - directional corridor
    - route logic
    - stop progression
  • Avoid creating multiple days with:
    - museum + lunch + walk + return
    - scenic stop + scenic stop + return
    - waterfront + food + harbor + return
    - old town + church + market + viewpoint
    - garden + museum + café + dinner
    - or any equivalent repeated structure.
  • Each day must have a clearly distinct identity.
  • Do NOT use translated naming to disguise repetition.

ICELAND CURATION (when relevant):
  • From Reykjavik, prioritize high-value realistic day trips such as Golden Circle, South Coast, Reykjanes / Blue Lagoon area, Snæfellsnes, Silver Circle / Borgarfjörður, lava tunnel / geothermal route, whale watching / marine experience, and realistic Southwest / West Iceland options.
  • For a 7-day Reykjavik itinerary in winter, avoid using 4+ days as pure urban museum/harbor/café filler.
  • Keep pure Reykjavik city content limited unless the user specifically requested a city-only trip.
  • For South Coast:
    - If the route reaches the Reynisfjara / Vík area, Vík should normally be included unless there is a strong reason not to.
    - Prefer a coherent progression such as Seljalandsfoss → Skógafoss → Vík and/or Reynisfjara → return.
    - Reynisfjara must appear as a real row if that South Coast stretch is being used; do NOT leave it only in notes.
  • For Snæfellsnes:
    - Prefer specific iconic stops such as Kirkjufell, Arnarstapi/Hellnar, Djúpalónssandur, Lóndrangar, Búðir/Búðakirkja when appropriate.
    - Avoid vague placeholders like only "National Park" if specific named stops are available.
  • For Reykjanes / Blue Lagoon:
    - Reserve Blue Lagoon and the Reykjanes corridor to ONE day only.
    - Allocate at least 3h of actual lagoon activity plus realistic arrival/check-in/changing/exit
      logistics.
    - Only after protecting that time, select the best feasible subset from the full corridor
      inventory, which may include Bridge Between Continents, Sandvík, Gunnuhver, Reykjanesviti,
      Valahnúkur, Brimketill, Kleifarvatn and Seltún/Krýsuvík.
    - Do not include all stops blindly: useful daylight, safety, access, route continuity and the
      user's pace decide.
    - Never create a second Reykjanes or second Blue Lagoon day elsewhere in the same trip.
  • For Silver Circle / Borgarfjörður:
    - Prefer real stops such as Borgarnes, Deildartunguhver, Hraunfossar, Barnafoss, Reykholt, and Krauma when they fit naturally.
  • For lava tunnel / geothermal route:
    - Prefer real stops such as Raufarhólshellir, Hveragerði, Hellisheiði, geothermal exhibition area, or nearby coherent geothermal/scenic stops.
  • For whale watching / marine experience:
    - Use it only if plausible for season, operating location and traveler profile.
    - Normally protect at least 2h30 of actual marine-tour time plus check-in, boarding and return.
    - Reserve the wildlife/marine anchor to one day only and do not repeat the same harbor filler
      pattern on other days.
  • Avoid extreme same-day round trips from Reykjavik to very distant North Iceland highlights when they would be exhausting and low quality.
  • Do NOT repeat the same Iceland macro-route across different days.
  • If Golden Circle was already used, do NOT create another Golden Circle variant later in the itinerary.
  • If South Coast was already used, avoid rebuilding another equivalent South Coast corridor day.
  • If Snæfellsnes was already used, do not recycle the same peninsula structure.
  • If Reykjanes / Blue Lagoon area was already used, do not create a second equivalent Reykjanes day unless the route is truly different and there are no better alternatives.
  • Prefer new geographic corridors before repeating known ones.
  • Iceland itineraries must maximize geographic diversity across days.
  • Regional Iceland days should feel dense, continuous, and exploratory:
    - avoid giant dead gaps
    - enrich routes with real scenic/geothermal/coastal micro-stops
    - ensure the day feels like a full coherent expedition.

SAFETY / GLOBAL COHERENCE:
- Do not propose things that are infeasible due to distance/time/season or obvious risks.
- Prioritize plausible, safe, and reasonable options.

SMART EDITING:
- If the user asks to add/remove/adjust schedules, return updated JSON that remains consistent.
- By default, preserve the itinerary's global coherence.

FINAL INTERNAL QUALITY CHECK (MANDATORY BEFORE OUTPUT):
- Before returning JSON, internally verify:
  • a master day plan exists internally
  • each day has a unique identity
  • stronger unused buckets are not being skipped in favor of weak urban filler
  • days 5+ are not dominated by museums, cafés, harbor walks, gardens, and generic cultural filler if stronger unused buckets remain
  • gateway/outward-base destinations have used major regional/special opportunities before creating repeated urban days
  • no duplicated macro-routes
  • no duplicated regional circuits
  • no semantically equivalent translated routes
  • no repeated route under alternate names, misspellings, paraphrases, or different languages
  • no structurally repetitive days
  • no repeated neighborhood/corridor/day-shape pattern
  • no repeated POIs across different days unless unavoidable and justified
  • no repeated museum + food + harbor/walk + dinner pattern
  • no excessive urban filler in long gateway/outward-base itineraries
  • no giant unexplained gaps in regional/scenic days
  • no weak sparse flagship routes
  • no important micro-stops hidden only in notes when they should be rows
  • no generic macro labels
  • no internal fallback/debug wording
  • no mixed language in user-facing fields
  • no transport preference leaked into "from" or "to"
- If any of those problems exist:
  • rebuild the affected day internally BEFORE returning the JSON.
- NEVER return a knowingly repetitive or sparse itinerary if stronger alternatives exist.
- The itinerary must feel globally curated, geographically diverse, and materially different day by day.

Respond with valid JSON only.
`.trim();

// ==============================
// Base prompt ✨ (FREE INFO CHAT) — like ChatGPT: any topic + context + user's real language
// ==============================
const SYSTEM_PROMPT_INFO = `
You are Astra, a general conversational assistant (like ChatGPT) inside ITravelByMyOwn.

GOAL:
- Respond in a helpful, honest, and complete way about ANY topic.
- Maintain conversation context using the provided history (messages/history).
- If key information is missing, ask 1–2 key questions (not 10).
- Do not invent data; if something isn't certain, say so.

LANGUAGE (CRITICAL, TRUE MULTI-LANGUAGE):
- ALWAYS respond in the REAL language of the user's last message content (any language).
- If the message includes template/system labels, do NOT use those labels to decide the language.
- If the user mixes languages, prioritize the dominant language of the user's written content.

FORMAT:
- Respond in natural text (not JSON).
- Use clear structure (short paragraphs, lists when helpful).
`.trim();

// ==============================
// Model call (with soft timeout)
// ==============================
async function callStructured(messages, temperature = 0.28, max_output_tokens = 2600, timeoutMs = 90000) {
  const input = (messages || []).map((m) => `${String(m.role || "user").toUpperCase()}: ${m.content}`).join("\n\n");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
   const resp = await client.responses.create(
  {
    model: MODEL,
    reasoning: {
      effort: "low",
    },
    input,
    max_output_tokens,
  },
  { signal: controller.signal }
);

    const text = resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";

    console.log("🛰️ RAW RESPONSE:", text);
    return text;
  } catch (e) {
    console.warn("callStructured error:", e?.message || e);
    return "";
  } finally {
    clearTimeout(t);
  }
}


// ==============================
// Correct ESM export — v62 stage-aware, backward compatible
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);
    const lang = detectUserLang(clientMessages);

    // INFO mode remains unchanged.
    if (mode === "info") {
      const raw = await callStructured(
        [{ role: "system", content: SYSTEM_PROMPT_INFO }, ...clientMessages],
        0.45,
        2600,
        70000
      );
      const text = raw || "⚠️ No response was obtained from the assistant.";
      return res.status(200).json({ text });
    }

    const stage = detectPlannerStage(clientMessages);
    console.log("🧭 ITBMO PLANNER STAGE:", stage);

    const override = detectLanguageOverride(clientMessages);
    const overrideLine = override
      ? `LANGUAGE OVERRIDE (USER-SELECTED, HIGHEST PRIORITY): Output MUST be in ${override.toUpperCase()}.
- Ignore earlier mixed-language content.
- Keep ALL JSON keys and the requested schema unchanged.
`
      : "";

    const stagePrompt = buildStagePrompt(SYSTEM_PROMPT, stage);
    const SYSTEM_PROMPT_EFFECTIVE = (overrideLine + stagePrompt).trim();

    // One primary model call. Master-plan stages receive a smaller/faster output budget.
    const primaryTokens = stage === "master_plan" ? 5000 : 10000;
    const primaryTimeout = stage === "master_plan" ? 85000 : 115000;

    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT_EFFECTIVE }, ...clientMessages],
      stage === "master_plan" ? 0.2 : 0.24,
      primaryTokens,
      primaryTimeout
    );

    let parsed = cleanToJSON(raw);

    // Stage-aware validity:
    // - Master Plan may legitimately be any non-empty requested JSON schema.
    // - Final generation must contain renderable itinerary content.
    const primaryValid =
      stage === "master_plan"
        ? _isNonEmptyJSON_(parsed)
        : _hasRenderableItinerary_(parsed);

    if (!primaryValid) {
      const strictPrompt =
        SYSTEM_PROMPT_EFFECTIVE +
        (stage === "master_plan"
          ? `

MANDATORY MASTER-PLAN RECOVERY:
- Return valid JSON only.
- Preserve exactly the intermediate/master-plan schema requested by the frontend.
- Include all requested days and unique day identities.
- Do not force city_day unless the request explicitly requires it.
- No commentary outside JSON.`
          : `

MANDATORY FINAL-ITINERARY RECOVERY:
- Return valid JSON only.
- Include city_day (preferred), rows or destinations with renderable rows.
- Include every requested day.
- Preserve strong regional/signature days and all must-includes.
- Recalculate row clocks so transport plus activity fits.
- No commentary outside JSON.`);

      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        stage === "master_plan" ? 0.14 : 0.16,
        stage === "master_plan" ? 5500 : 10500,
        stage === "master_plan" ? 85000 : 115000
      );
      parsed = cleanToJSON(raw);
    }

    // Never force a master-plan response into city_day.
    if (stage === "master_plan") {
      if (!_isNonEmptyJSON_(parsed)) {
        parsed = {
          ok: false,
          error: {
            code: "MASTER_PLAN_GENERATION_FAILED",
            retryable: true,
          },
        };
      } else {
        const expectedDays = _v64ExpectedMasterDays_(clientMessages);
        const masterReport = _v64AuditMasterPlan_(parsed, expectedDays);

        if (!masterReport.ok) {
          console.warn("🧭 ITBMO MASTER AUDIT:", {
            expected_days: expectedDays,
            codes: [...new Set(masterReport.errors.map((error) => error.code))],
          });

          try {
            const repairedMaster = await _v64RepairMasterPlanOnce_(
              parsed,
              masterReport,
              SYSTEM_PROMPT_EFFECTIVE,
              clientMessages,
              expectedDays
            );

            if (repairedMaster) {
              const repairedReport = _v64AuditMasterPlan_(
                repairedMaster,
                expectedDays
              );

              if (
                repairedReport.ok ||
                repairedReport.errors.length < masterReport.errors.length
              ) {
                parsed = repairedMaster;
              }
            }
          } catch (masterRepairError) {
            console.warn(
              "⚠️ Master-plan repair skipped; returning original strategic JSON:",
              masterRepairError?.message || masterRepairError
            );
          }
        }
      }

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // Final itinerary/one-shot normalization.
    if (!parsed) parsed = fallbackJSON(lang);
    parsed = _v62NormalizeFinalParsed_(parsed);

    // Deterministic audit runs only on actual city_day output.
    // One bounded surgical repair is allowed; if it fails, the valid original draft is retained
    // so the planner workflow is never broken by the quality layer.
    if (Array.isArray(parsed?.city_day) && parsed.city_day.length) {
      const report = _v62ValidateFinal_(parsed);

      if (!report.ok) {
        console.warn("🧪 ITBMO FINAL AUDIT:", {
          affected_days: report.affected_days,
          codes: [...new Set(report.errors.map((error) => error.code))],
        });

        try {
          const repaired = await _v62RepairFinalOnce_(
            parsed,
            report,
            SYSTEM_PROMPT_EFFECTIVE,
            clientMessages
          );

          if (repaired) {
            const repairedReport = _v62ValidateFinal_(repaired);
            if (repairedReport.ok || repairedReport.errors.length < report.errors.length) {
              parsed = repaired;
            }
          }
        } catch (repairError) {
          console.warn(
            "⚠️ Surgical repair skipped; returning original generated itinerary:",
            repairError?.message || repairError
          );
        }
      }
    }

    // Preserve original anti-blank guardrail only for final itinerary stages.
    try {
      const dest = String(parsed?.destination || "Destination").trim() || "Destination";
      const daysTotal = Math.max(1, Number(parsed?.days_total || 1));

      if (Array.isArray(parsed.city_day)) {
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);

        if (!_hasAnyRows_(parsed.city_day)) {
          parsed.city_day = skeletonCityDay(dest, daysTotal, lang);
          parsed.followup =
            (parsed.followup ? parsed.followup + " | " : "") +
            "⚠️ Guard-rail: empty city_day or no rows. Returned skeleton to avoid a blank table.";
        }
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    try {
      const body = req?.body || {};
      const clientMessages = extractMessages(body);
      const stage = detectPlannerStage(clientMessages);
      const lang = detectUserLang(clientMessages);

      // Do not fabricate city_day for a failed master-plan stage.
      if (stage === "master_plan") {
        return res.status(200).json({
          text: JSON.stringify({
            ok: false,
            error: {
              code: "MASTER_PLAN_GENERATION_FAILED",
              retryable: true,
            },
          }),
        });
      }

      return res.status(200).json({ text: JSON.stringify(fallbackJSON(lang)) });
    } catch {
      return res.status(200).json({ text: JSON.stringify(fallbackJSON("en")) });
    }
  }
}
