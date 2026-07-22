// /api/chat.js — v59 WOW MVP Planner Engine — ESM compatible on Vercel
// ✅ Keeps v58 interface: receives {mode, input/history/messages} and returns { text: "<string>" }.
// ✅ Does NOT break "info" mode: returns free text.
// ✅ Preserves the v58 public contract while adding a multi-stage planning engine, seasonal intelligence, journey arc, validation and targeted repair.
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
// Planner Engine v2 — deterministic helpers
// ==============================
const PLANNER_ENGINE_VERSION = "v59-wow-mvp";

function _safeString_(value) {
  return typeof value === "string" ? value.trim() : "";
}

function _normalizeKey_(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _parseHHMM_(value) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function _extractJSONCandidate_(raw = "") {
  const parsed = cleanToJSON(raw);
  if (parsed && typeof parsed === "object") return parsed;
  return null;
}

function _compactMessages_(messages = [], maxChars = 24000) {
  const normalized = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      role: ["system", "assistant", "user"].includes(String(m.role || "").toLowerCase())
        ? String(m.role).toLowerCase()
        : "user",
      content: String(m.content || ""),
    }));

  let total = 0;
  const out = [];
  for (let i = normalized.length - 1; i >= 0; i--) {
    const m = normalized[i];
    const remaining = Math.max(0, maxChars - total);
    if (!remaining) break;
    const content = m.content.length > remaining ? m.content.slice(-remaining) : m.content;
    out.unshift({ ...m, content });
    total += content.length;
  }
  return out;
}

function _destinationFromParsed_(parsed, fallback = "Destination") {
  return (
    _safeString_(parsed?.destination) ||
    _safeString_(parsed?.city_day?.[0]?.city) ||
    _safeString_(parsed?.destinations?.[0]?.name) ||
    fallback
  );
}

function _flattenCityDayRows_(parsed) {
  if (Array.isArray(parsed?.city_day)) {
    return parsed.city_day.flatMap((block) =>
      (Array.isArray(block?.rows) ? block.rows : []).map((row) => ({
        ...row,
        __blockDay: Number(block?.day) || Number(row?.day) || 0,
        __city: block?.city || parsed?.destination || "",
      }))
    );
  }
  if (Array.isArray(parsed?.rows)) return parsed.rows.map((row) => ({ ...row, __blockDay: Number(row?.day) || 0 }));
  return [];
}

function validateItinerary(parsed, expectedDays = 0) {
  const issues = [];
  const warnings = [];

  if (!parsed || typeof parsed !== "object") {
    return { valid: false, score: 0, issues: ["Response is not a JSON object."], warnings };
  }

  if (!Array.isArray(parsed.city_day) || !parsed.city_day.length) {
    issues.push("Missing non-empty city_day array.");
    return { valid: false, score: 10, issues, warnings };
  }

  const blocks = [...parsed.city_day].sort((a, b) => Number(a?.day || 0) - Number(b?.day || 0));
  const dayNumbers = blocks.map((b) => Number(b?.day)).filter(Number.isFinite);
  const uniqueDays = new Set(dayNumbers);

  if (expectedDays > 0 && uniqueDays.size !== expectedDays) {
    issues.push(`Expected ${expectedDays} itinerary days but received ${uniqueDays.size}.`);
  }

  const seenActivities = new Map();
  let rowCount = 0;

  for (const block of blocks) {
    const day = Number(block?.day) || 0;
    const rows = Array.isArray(block?.rows) ? block.rows : [];
    rowCount += rows.length;

    if (!rows.length) {
      issues.push(`Day ${day || "?"} has no rows.`);
      continue;
    }

    if (rows.length < 3) warnings.push(`Day ${day} is sparse with only ${rows.length} rows.`);
    if (rows.length > 20) issues.push(`Day ${day} exceeds 20 rows.`);

    let previousEnd = null;
    let previousTo = "";

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const label = `Day ${day}, row ${i + 1}`;
      const required = ["start", "end", "activity", "from", "to", "transport", "duration", "notes"];
      for (const field of required) {
        if (!_safeString_(row[field])) issues.push(`${label}: missing ${field}.`);
      }

      const start = _parseHHMM_(row.start);
      const end = _parseHHMM_(row.end);
      if (start == null || end == null) {
        issues.push(`${label}: invalid HH:MM time.`);
      } else {
        if (end <= start) issues.push(`${label}: end time is not after start time.`);
        if (previousEnd != null && start < previousEnd) issues.push(`${label}: overlaps the previous row.`);
        previousEnd = Math.max(previousEnd ?? -1, end);
      }

      const duration = String(row.duration || "");
      const durationLines = duration.split("\n").map((x) => x.trim()).filter(Boolean);
      if (
        durationLines.length !== 2 ||
        !/^Transport\s*:/i.test(durationLines[0]) ||
        !/^Activity\s*:/i.test(durationLines[1])
      ) {
        issues.push(`${label}: duration must contain exactly Transport and Activity lines.`);
      }

      if (_safeString_(row.notes).length < 20) issues.push(`${label}: notes are shorter than 20 characters.`);
      if (!_safeString_(row.activity).includes(" – ") && !_safeString_(row.activity).includes(" - ")) {
        warnings.push(`${label}: activity does not clearly follow DESTINATION – SUB-STOP.`);
      }

      if (i > 0 && previousTo) {
        const fromKey = _normalizeKey_(row.from);
        const previousToKey = _normalizeKey_(previousTo);
        if (fromKey && previousToKey && fromKey !== previousToKey) {
          warnings.push(`${label}: possible continuity gap from '${previousTo}' to '${row.from}'.`);
        }
      }
      previousTo = row.to;

      const activityKey = _normalizeKey_(row.activity)
        .replace(/\b(return|return to|regreso|retorno|retour|ritorno|ruckkehr)\b/g, "")
        .trim();
      if (activityKey.length >= 8) {
        const prior = seenActivities.get(activityKey);
        if (prior && prior.day !== day) {
          warnings.push(`${label}: possible repeated activity also used on day ${prior.day}.`);
        } else if (!prior) {
          seenActivities.set(activityKey, { day, row: i + 1 });
        }
      }
    }
  }

  if (!rowCount) issues.push("The itinerary contains no renderable rows.");

  let score = 100;
  score -= Math.min(70, issues.length * 8);
  score -= Math.min(25, warnings.length * 2);
  score = Math.max(0, score);

  return {
    valid: issues.length === 0,
    score,
    issues: issues.slice(0, 40),
    warnings: warnings.slice(0, 40),
  };
}

function _inferExpectedDays_(messages = [], parsed = null) {
  const parsedDays = Number(parsed?.days_total);
  if (Number.isFinite(parsedDays) && parsedDays > 0) return Math.min(30, Math.floor(parsedDays));

  const text = (messages || []).map((m) => String(m?.content || "")).join("\n");
  const patterns = [
    /days[_\s-]*total\s*[:=]\s*(\d{1,2})/i,
    /(?:total\s+)?(?:days|dias|días|jours|tage|giorni)\s*[:=]?\s*(\d{1,2})/i,
    /(\d{1,2})\s*(?:days|dias|días|jours|tage|giorni)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return Math.min(30, Math.max(1, Number(m[1])));
  }
  return 0;
}

function buildStrategyPrompt(languageOverride = null) {
  const languageRule = languageOverride
    ? `All user-facing strategy labels must be in ${languageOverride.toUpperCase()}.`
    : "Use the language selected by the user; otherwise use the dominant language of the user's natural content.";

  return `
You are the internal Travel Strategy Architect for ITravelByMyOwn.
You do NOT write the final itinerary. You create a compact, high-value planning blueprint that another model call will execute.
You have no live web access, so use stable general travel knowledge and explicitly avoid pretending to know live closures, road status, prices, or availability.

${languageRule}

Return EXCLUSIVELY valid JSON with this exact top-level shape:
{
  "destination_profile": {
    "destination": "",
    "destination_type": "dense_city|gateway_outward_base|hybrid_city_and_region|island_beach_relax|nature_adventure_base|roadtrip_multi_base",
    "trip_length": 0,
    "season_context": "",
    "seasonal_opportunities": [""],
    "seasonal_risks": [""],
    "traveler_fit": [""]
  },
  "hard_constraints": [""],
  "soft_preferences": [""],
  "must_include": [""],
  "experience_inventory": [
    {
      "experience": "",
      "category": "city|regional|nature|culture|food|wellness|wildlife|adventure|night|arrival|departure",
      "strength": 1,
      "season_fit": 1,
      "traveler_fit": 1,
      "geographic_cluster": "",
      "why_it_matters": ""
    }
  ],
  "journey_arc": {
    "opening_emotion": "",
    "middle_emotions": [""],
    "closing_emotion": "",
    "narrative": ""
  },
  "master_day_plan": [
    {
      "day": 1,
      "identity": "",
      "emotion": "",
      "bucket": "",
      "geographic_cluster": "",
      "anchor_experience": "",
      "supporting_experiences": [""],
      "pace": "light|balanced|intense",
      "seasonal_logic": "",
      "why_this_day_now": ""
    }
  ],
  "anti_repetition": {
    "reserved_clusters": [""],
    "experience_types_to_avoid_repeating": [""],
    "day_shapes": [""]
  },
  "execution_notes": [""]
}

STRATEGY QUALITY RULES:
- Build the complete master day plan before finishing.
- Every day must have a distinct identity, geographic logic, emotional role, and experience mix.
- Treat explicit requested places as must-includes unless impossible.
- Use seasonality as a design input, not as decorative advice.
- Create a narrative progression: arrival/orientation, discovery, immersion, peak experiences, recovery or contrast, and a satisfying farewell.
- Prefer strong, iconic and distinctive experiences before filler.
- For gateway destinations, use outward/regional experiences before repeating urban content.
- Detect semantic experience repetition, not only duplicate place names.
- Do not invent precise live facts. When exact hours, weather, closures, availability, or road conditions matter, tell the executor to add a confirmation note.
- Keep the blueprint compact enough to be injected into the final generation prompt.
`.trim();
}

const WOW_EXECUTION_LAYER = `
WOW MVP EXECUTION LAYER (CRITICAL — PRESERVE ALL EXISTING RULES):
- You will receive an INTERNAL PLANNING BLUEPRINT produced before this call.
- Treat that blueprint as the day-level architecture, but reconcile it with the user's hard constraints and all rules in this prompt.
- Do not output the blueprint. Output only the final itinerary JSON.

SEASONAL INTELLIGENCE:
- Plan the destination for the actual travel season, not as a generic destination.
- Use stable seasonal knowledge to influence daylight use, pacing, indoor/outdoor balance, heat/cold exposure, photography moments, wildlife plausibility, night activities and transport conservatism.
- Never pretend to know live weather, live road status, current closures, current prices or availability.
- When those details matter, add a concise note to verify them closer to the date.

JOURNEY ARC:
- The trip must feel intentionally designed from arrival to farewell.
- Each day must have a clear emotional role and a reason for appearing at that point in the journey.
- Alternate intensity and experience types where appropriate so the trip has rhythm, contrast and recovery.
- Day titles are not a separate JSON field; express the identity through the day's selected activities, sequence and notes.

MOMENT-BASED DESIGN:
- Do not merely state where to go. In notes, explain why that stop belongs at that moment of the day or trip.
- Examples of valid logic: best use of morning energy, atmospheric evening light, recovery after an intense regional day, convenient geographic pairing, or a memorable closing experience.

EXPERIENCE DIVERSITY:
- Detect repeated experiences even when POI names differ.
- Repeated waterfront strolls, churches, viewpoints, food halls, museums, old towns, markets or thermal experiences can still feel repetitive.
- Preserve only the strongest version of a repeated experience type unless the second is genuinely different in purpose, setting and emotional effect.

PREMIUM FINAL DAYS:
- The final days must not feel like leftovers.
- Reserve at least one meaningful, distinctive or emotionally satisfying experience for the closing phase of trips of 5+ days.
`;

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

TIME INFERENCE (CRITICAL):
- User-provided per-day start/end times are HARD CONSTRAINTS and must be respected.
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
- CRITICAL: if an anchor activity (spa, lagoon, museum, viewpoint area, market, beach, etc.) occupies only part of the day and there is still a useful remaining time window, you MUST complete that day with nearby coherent real stops unless the user explicitly wanted a short/light day.

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

AURORAS (HARD RULE + REPLACEMENT):
- FORBIDDEN unless they are truly plausible by latitude/season (high-latitude auroral zones) AND the itinerary context supports it.
- If the destination is NOT a typical auroral zone, you MUST NOT include any aurora-related rows or wording.
- If auroras are NOT plausible and you need a night highlight, replace it with a real iconic night experience for that city.
- When auroras ARE plausible:
  • Aurora viewing is a NIGHT activity.
  • If you include auroras, they MUST appear as REAL rows with nighttime schedule, realistic transport, and plausible viewing area.
  • Auroras are NOT valid if they appear only in notes, suggestions, dinner rows, or followup text.
  • Aurora rows should usually be 1–3 opportunities total depending on trip length and season.
  • Do NOT add the same aurora note to every day.
  • Avoid consecutive days if there is room elsewhere.
  • Do not leave the only aurora attempt for the very last possible day unless truly necessary.

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
    - If Blue Lagoon is included and the available day still has a useful remaining window, prefer integrating it with coherent Reykjanes Peninsula stops instead of leaving the day half-empty.
    - Plausible complements may include geothermal/coastal/scenic stops in the same corridor when they fit naturally and safely.
    - Do NOT treat Blue Lagoon as a full standalone day unless the user's constraints, timing, pace, or recovery preference clearly justify it.
    - The main Blue Lagoon visit row should use a real external area / corridor label, not the Reykjavik city label, unless it is explicitly the departure/return row.
  • For Silver Circle / Borgarfjörður:
    - Prefer real stops such as Borgarnes, Deildartunguhver, Hraunfossar, Barnafoss, Reykholt, and Krauma when they fit naturally.
  • For lava tunnel / geothermal route:
    - Prefer real stops such as Raufarhólshellir, Hveragerði, Hellisheiði, geothermal exhibition area, or nearby coherent geothermal/scenic stops.
  • For whale watching / marine experience:
    - Use it only if plausible for the season and traveler profile; pair it with a distinct harbor/food/culture block only once, not repeated across many days.
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

${WOW_EXECUTION_LAYER}

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
// Model calls (Responses API + soft timeout)
// ==============================
async function callModel({
  instructions = "",
  messages = [],
  max_output_tokens = 2600,
  timeoutMs = 90000,
  reasoningEffort = "low",
  label = "model",
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const compactMessages = _compactMessages_(messages);
    const resp = await client.responses.create(
      {
        model: MODEL,
        instructions: String(instructions || ""),
        input: compactMessages,
        reasoning: { effort: reasoningEffort },
        max_output_tokens,
      },
      { signal: controller.signal }
    );

    const text = String(resp?.output_text || "").trim();
    const incomplete = resp?.status === "incomplete";

    console.log(`🛰️ ${label} RESPONSE:`, {
      status: resp?.status,
      incomplete_details: resp?.incomplete_details || null,
      chars: text.length,
      preview: text.slice(0, 600),
    });

    return {
      text,
      status: resp?.status || "unknown",
      incomplete,
      incomplete_details: resp?.incomplete_details || null,
    };
  } catch (e) {
    const aborted = e?.name === "AbortError" || controller.signal.aborted;
    console.warn(`${label} error:`, aborted ? "Request timed out/aborted" : e?.message || e);
    return { text: "", status: aborted ? "timeout" : "error", incomplete: false, error: e };
  } finally {
    clearTimeout(timer);
  }
}

async function buildPlanningBlueprint(clientMessages, languageOverride) {
  const result = await callModel({
    instructions: buildStrategyPrompt(languageOverride),
    messages: clientMessages,
    max_output_tokens: 4200,
    timeoutMs: 90000,
    reasoningEffort: "medium",
    label: "STRATEGY",
  });

  const blueprint = _extractJSONCandidate_(result.text);
  if (!blueprint) {
    console.warn("Strategy blueprint was unavailable; final generation will continue with the full planner prompt only.");
    return null;
  }
  return blueprint;
}

function buildFinalPlannerInstructions(systemPrompt, blueprint) {
  const blueprintText = blueprint ? JSON.stringify(blueprint) : "null";
  return `${systemPrompt}

INTERNAL PLANNING BLUEPRINT (DO NOT OUTPUT, DO NOT MENTION):
${blueprintText}

BLUEPRINT EXECUTION CONTRACT:
- Use the master_day_plan as the default day architecture.
- Preserve every hard constraint and must-include from the user even if the blueprint missed one.
- Improve the blueprint when a specific itinerary rule in the main prompt requires it.
- Return only the final table-ready JSON.`;
}

async function repairItinerary({ systemPrompt, clientMessages, parsed, validation, expectedDays }) {
  const repairInstructions = `${systemPrompt}

TARGETED REPAIR MODE:
You are repairing an already-generated itinerary, not creating an unrelated replacement.
Return the COMPLETE corrected itinerary JSON, preserving all good content and changing only what is necessary.
Resolve every listed validation issue and the most important warnings.
Do not discuss the repair. Do not output markdown. Do not omit any day.
Expected number of days: ${expectedDays || "use the user's request"}.

VALIDATION REPORT:
${JSON.stringify(validation)}

CURRENT ITINERARY TO REPAIR:
${JSON.stringify(parsed)}`;

  const result = await callModel({
    instructions: repairInstructions,
    messages: clientMessages,
    max_output_tokens: 12000,
    timeoutMs: 120000,
    reasoningEffort: "medium",
    label: "REPAIR",
  });

  const repaired = normalizeParsed(_extractJSONCandidate_(result.text));
  return repaired;
}

// ==============================
// Correct ESM export
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

    // 🧭 INFO CHAT MODE — same public behavior, proper system hierarchy
    if (mode === "info") {
      const result = await callModel({
        instructions: SYSTEM_PROMPT_INFO,
        messages: clientMessages,
        max_output_tokens: 3200,
        timeoutMs: 70000,
        reasoningEffort: "low",
        label: "INFO",
      });
      const text = result.text || "⚠️ No response was obtained from the assistant.";
      return res.status(200).json({ text });
    }

    const override = detectLanguageOverride(clientMessages);
    const overrideLine = override
      ? `LANGUAGE OVERRIDE (USER-SELECTED, HIGHEST PRIORITY): Output MUST be in ${override.toUpperCase()}.\n- Ignore earlier mixed-language content.\n- Keep ALL JSON keys/shape the same.\n`
      : "";

    const SYSTEM_PROMPT_EFFECTIVE = (overrideLine + SYSTEM_PROMPT).trim();

    // Stage 1: strategy architecture (no user-visible output)
    const blueprint = await buildPlanningBlueprint(clientMessages, override);

    // Stage 2: full itinerary generation using the architecture
    const finalInstructions = buildFinalPlannerInstructions(SYSTEM_PROMPT_EFFECTIVE, blueprint);
    let generation = await callModel({
      instructions: finalInstructions,
      messages: clientMessages,
      max_output_tokens: 12000,
      timeoutMs: 120000,
      reasoningEffort: "medium",
      label: "PLANNER",
    });

    let parsed = normalizeParsed(_extractJSONCandidate_(generation.text));

    // Parse retry: strict JSON recovery, while retaining the same blueprint and user request
    const hasSome =
      parsed && (Array.isArray(parsed.city_day) || Array.isArray(parsed.rows) || Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictInstructions = `${finalInstructions}

STRICT JSON RECOVERY:
- The prior attempt was missing or invalid.
- Return valid JSON only.
- Include city_day with at least one renderable row for every requested day.
- No text outside JSON.`;

      generation = await callModel({
        instructions: strictInstructions,
        messages: clientMessages,
        max_output_tokens: 12000,
        timeoutMs: 120000,
        reasoningEffort: "medium",
        label: "PLANNER_RETRY",
      });
      parsed = normalizeParsed(_extractJSONCandidate_(generation.text));
    }

    if (!parsed) parsed = fallbackJSON(lang);
    parsed = normalizeParsed(parsed);

    // Convert legacy rows into city_day when possible, preserving frontend compatibility
    if (!Array.isArray(parsed.city_day) && Array.isArray(parsed.rows)) {
      const destination = _destinationFromParsed_(parsed);
      const grouped = new Map();
      for (const row of parsed.rows) {
        const day = Math.max(1, Number(row?.day) || 1);
        if (!grouped.has(day)) grouped.set(day, []);
        grouped.get(day).push(row);
      }
      parsed.city_day = [...grouped.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, rows]) => ({ city: destination, day, rows }));
    }

    const expectedDays = _inferExpectedDays_(clientMessages, parsed);
    let validation = validateItinerary(parsed, expectedDays);

    // Stage 3: one targeted repair only when it materially improves reliability
    const shouldRepair =
      !validation.valid ||
      validation.score < 82 ||
      validation.warnings.some((w) => /sparse|repeated activity|overlap|continuity gap/i.test(w));

    if (shouldRepair && Array.isArray(parsed?.city_day) && _hasAnyRows_(parsed.city_day)) {
      const repaired = await repairItinerary({
        systemPrompt: finalInstructions,
        clientMessages,
        parsed,
        validation,
        expectedDays,
      });

      if (repaired && Array.isArray(repaired.city_day) && _hasAnyRows_(repaired.city_day)) {
        const repairedValidation = validateItinerary(repaired, expectedDays);
        if (repairedValidation.score >= validation.score || !validation.valid) {
          parsed = repaired;
          validation = repairedValidation;
        }
      }
    }

    // Final anti-blank-table guardrail — same external contract as v58
    try {
      const dest = _destinationFromParsed_(parsed);
      const daysTotal = Math.max(1, Number(parsed?.days_total || expectedDays || 1));

      if (!Array.isArray(parsed.city_day)) parsed.city_day = [];
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);

      if (!_hasAnyRows_(parsed.city_day)) {
        parsed.city_day = skeletonCityDay(dest, daysTotal, lang);
        parsed.followup =
          (parsed.followup ? parsed.followup + " | " : "") +
          "⚠️ No valid itinerary was produced in this attempt. Please retry.";
      }
    } catch {}

    // Keep diagnostics server-side only; never alter the frontend JSON contract
    console.log("✅ ITBMO PLANNER COMPLETE:", {
      engine: PLANNER_ENGINE_VERSION,
      model: MODEL,
      blueprint: Boolean(blueprint),
      validationScore: validation?.score,
      issues: validation?.issues?.length || 0,
      warnings: validation?.warnings?.length || 0,
      days: parsed?.city_day?.length || 0,
      rows: _flattenCityDayRows_(parsed).length,
    });

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    try {
      const body = req?.body || {};
      const clientMessages = extractMessages(body);
      const lang = detectUserLang(clientMessages);
      return res.status(200).json({ text: JSON.stringify(fallbackJSON(lang)) });
    } catch {
      return res.status(200).json({ text: JSON.stringify(fallbackJSON("en")) });
    }
  }
}
