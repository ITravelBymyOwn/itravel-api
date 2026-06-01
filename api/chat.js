// /api/chat.js — v58.1 (surgical global planner blueprint + master day plan)
// ✅ Keeps v58 interface: receives {mode, input/history/messages} and returns { text: "<string>" }.
// ✅ Does NOT break "info" mode: returns free text.
// ✅ Adds GLOBAL planner pre-step: destination profile + master day plan.
// ✅ Adds soft quality validation + one retry before returning.
// ✅ Does NOT change frontend contract.
// ✅ Keeps city_day preferred format.
// ✅ Keeps language override behavior.
// ✅ Increases planner output token budget for multi-day rich itineraries.

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

function detectLanguageOverride(messages = []) {
  const raw = _lastUserText_(messages);
  const t = String(raw || "").trim();
  if (!t) return null;

  const noAccents = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const cleaned = noAccents.replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const tokens = cleaned.split(" ").filter(Boolean);
  const joined = cleaned;

  if (joined.length > 28 && tokens.length > 2) return null;

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
    if (val.length >= 3 && candidate.startsWith(val)) return true;
    if (candidate.length >= 3 && val.startsWith(candidate)) return true;
    return false;
  };

  if (tokens.length === 1) {
    const w = tokens[0];
    for (const entry of map) {
      for (const n of entry.names) {
        if (isMatch(w, n)) return entry.code;
      }
    }
    return null;
  }

  if (tokens.length === 2) {
    for (const entry of map) {
      for (const n of entry.names) {
        if (isMatch(tokens[0], n) || isMatch(tokens[1], n)) return entry.code;
      }
    }
  }

  return null;
}

function detectUserLang(messages = []) {
  const t = _lastUserText_(messages).trim();
  if (!t) return "en";

  const s = t.toLowerCase();

  if (/[¿¡ñáéíóúü]/i.test(t)) return "es";

  const esHits = (s.match(/\b(el|la|los|las|de|que|y|para|con|por|una|un|como|donde|qué|cuál|cuáles|cómo)\b/g) || []).length;
  const enHits = (s.match(/\b(the|and|for|with|to|from|what|which|how|where|when|please)\b/g) || []).length;
  const frHits = (s.match(/\b(le|la|les|des|de|du|et|pour|avec|sans|où|quoi|quel|quelle|quels|quelles|s\'il|vous)\b/g) || []).length;
  const itHits = (s.match(/\b(il|lo|la|i|gli|le|di|che|e|per|con|senza|dove|cosa|quale|quali|grazie)\b/g) || []).length;
  const deHits = (s.match(/\b(der|die|das|und|für|mit|ohne|wo|was|welche|welcher|bitte|danke)\b/g) || []).length;
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

  if (!topScore) return "en";
  return topLang;
}

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

function skeletonCityDay(destination = "Destination", daysTotal = 1, lang = "en") {
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

  if (/Transport\s*:/i.test(s) && /Activity\s*:/i.test(s) && s.includes(",")) {
    return s.replace(/\s*,\s*Activity\s*:/i, "\nActivity:");
  }

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
    if (Array.isArray(parsed.city_day)) {
      const dest = String(parsed?.destination || "").trim();
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
    }

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
// v58.1 Global quality helpers
// ==============================
function _asciiKey_(txt = "") {
  return String(txt || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _safeStringify_(obj, max = 12000) {
  try {
    const s = JSON.stringify(obj, null, 2);
    if (s.length <= max) return s;
    return s.slice(0, max) + "\n...[truncated]";
  } catch {
    return "";
  }
}

function _collectPlannerRows_(parsed = {}) {
  const rows = [];

  try {
    if (Array.isArray(parsed?.city_day)) {
      parsed.city_day.forEach((b) => {
        (Array.isArray(b?.rows) ? b.rows : []).forEach((r) => rows.push({ ...r, day: Number(r?.day || b?.day || 1) }));
      });
    }

    if (!rows.length && Array.isArray(parsed?.rows)) {
      parsed.rows.forEach((r) => rows.push({ ...r, day: Number(r?.day || 1) }));
    }

    if (!rows.length && Array.isArray(parsed?.destinations)) {
      parsed.destinations.forEach((d) => {
        if (Array.isArray(d?.city_day)) {
          d.city_day.forEach((b) => {
            (Array.isArray(b?.rows) ? b.rows : []).forEach((r) => rows.push({ ...r, day: Number(r?.day || b?.day || 1) }));
          });
        } else if (Array.isArray(d?.rows)) {
          d.rows.forEach((r) => rows.push({ ...r, day: Number(r?.day || 1) }));
        }
      });
    }
  } catch {}

  return rows;
}

function _extractActivityLeft_(activity = "") {
  const s = String(activity || "");
  const parts = s.split(/\s+[–-]\s+/);
  return String(parts?.[0] || s || "").trim();
}

function _extractActivityRight_(activity = "") {
  const s = String(activity || "");
  const parts = s.split(/\s+[–-]\s+/);
  return String(parts?.slice(1).join(" - ") || s || "").trim();
}

function _rowText_(r = {}) {
  return `${r?.activity || ""} ${r?.from || ""} ${r?.to || ""} ${r?.notes || ""}`;
}

function _isReturnOrHotelRow_(r = {}) {
  const t = _asciiKey_(_rowText_(r));
  return /\b(return|regreso|retorno|volver|back|hotel|alojamiento)\b/.test(t);
}

function _isAuroraRow_(r = {}) {
  const t = _asciiKey_(_rowText_(r));
  return /\b(aurora|auroras|northern lights|boreal)\b/.test(t);
}

function _poiKey_(r = {}) {
  if (!r || _isReturnOrHotelRow_(r) || _isAuroraRow_(r)) return "";
  const right = _extractActivityRight_(r?.activity || "");
  const to = String(r?.to || "");
  let key = _asciiKey_(right || to || r?.activity || "");

  key = key
    .replace(/\b(restaurante|restaurant|local|cafe|café|almuerzo|lunch|cena|dinner|comida|food|stop|parada)\b/g, "")
    .replace(/\b(en|in|at|de|del|la|el|the|a|an|por|para)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!key || key.length < 3) return "";
  return key;
}

function _dayPattern_(rows = []) {
  const tokens = [];

  (rows || []).forEach((r) => {
    if (_isAuroraRow_(r) || _isReturnOrHotelRow_(r)) return;

    const t = _asciiKey_(_rowText_(r));

    if (/\b(museum|museo|gallery|galeria|exhibition|exposicion|art|arte|saga|history|historia)\b/.test(t)) tokens.push("museum");
    else if (/\b(harbor|harbour|puerto|waterfront|promenade|malecon|old harbour|old harbor)\b/.test(t)) tokens.push("harbor");
    else if (/\b(lunch|almuerzo|dinner|cena|restaurant|restaurante|cafe|café|market|mercado|food)\b/.test(t)) tokens.push("food");
    else if (/\b(garden|jardin|jardín|park|parque|sculpture|escultura)\b/.test(t)) tokens.push("garden");
    else if (/\b(waterfall|cascada|beach|playa|glacier|glaciar|geyser|geysir|volcano|volcan|crater|crater|lagoon|laguna|peninsula|peninsula|coast|costa|circle|circulo|route|ruta|valley|valle|lava|cave|cueva)\b/.test(t)) tokens.push("regional");
    else if (/\b(church|iglesia|cathedral|catedral|temple|templo|landmark|monument|monumento|viewpoint|mirador)\b/.test(t)) tokens.push("landmark");
    else if (/\b(walk|paseo|stroll|centro|center|downtown|old town|historic)\b/.test(t)) tokens.push("walk");
    else tokens.push("other");
  });

  return tokens.join(">");
}

function _genericMacroIssue_(r = {}) {
  const left = _asciiKey_(_extractActivityLeft_(r?.activity || ""));
  return /\b(cultura y naturaleza|culture and nature|local culture|urban culture|general|scenic regional route|local culture and food route)\b/.test(left);
}

function _qualityScan_(parsed = {}) {
  const issues = [];
  const repairDays = new Set();
  const rows = _collectPlannerRows_(parsed);
  const daysTotal = Math.max(
    Number(parsed?.days_total || 0),
    ...rows.map((r) => Number(r?.day || 0)),
    Array.isArray(parsed?.city_day) ? parsed.city_day.length : 0,
    1
  );

  const byDay = {};
  rows.forEach((r) => {
    const d = Number(r?.day || 1);
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(r);
  });

  for (let d = 1; d <= daysTotal; d++) {
    const dayRows = byDay[d] || [];
    const nonAurora = dayRows.filter((r) => !_isAuroraRow_(r));
    if (!dayRows.length || nonAurora.length < 2) {
      issues.push(`Day ${d} has too few usable rows.`);
      repairDays.add(d);
    }
  }

  const poiMap = {};
  rows.forEach((r) => {
    const key = _poiKey_(r);
    if (!key) return;
    if (!poiMap[key]) poiMap[key] = new Set();
    poiMap[key].add(Number(r?.day || 1));
  });

  Object.entries(poiMap).forEach(([key, daySet]) => {
    if (daySet.size >= 2) {
      issues.push(`Repeated POI/concept across days: ${key} on days ${[...daySet].join(", ")}.`);
      [...daySet].slice(1).forEach((d) => repairDays.add(d));
    }
  });

  const patternMap = {};
  Object.keys(byDay).forEach((day) => {
    const d = Number(day);
    const pattern = _dayPattern_(byDay[d] || []);
    if (!pattern || pattern.length < 5) return;
    if (!patternMap[pattern]) patternMap[pattern] = [];
    patternMap[pattern].push(d);
  });

  Object.entries(patternMap).forEach(([pattern, days]) => {
    if (days.length >= 2) {
      issues.push(`Repeated day structure "${pattern}" on days ${days.join(", ")}.`);
      days.slice(1).forEach((d) => repairDays.add(d));
    }
  });

  rows.forEach((r) => {
    if (_genericMacroIssue_(r)) {
      const d = Number(r?.day || 1);
      issues.push(`Generic macro label detected on day ${d}: ${r?.activity || ""}.`);
      repairDays.add(d);
    }

    const combined = _asciiKey_(`${r?.from || ""} ${r?.to || ""}`);
    if (/\brental car\b/.test(combined) || /\brecommend me\b/.test(combined) || /\brecommended by planner\b/.test(combined)) {
      const d = Number(r?.day || 1);
      issues.push(`Transport preference leaked into from/to on day ${d}.`);
      repairDays.add(d);
    }
  });

  if (daysTotal >= 6) {
    let urbanLikeDays = 0;
    Object.keys(byDay).forEach((day) => {
      const pattern = _dayPattern_(byDay[day] || []);
      const regionalCount = (pattern.match(/regional/g) || []).length;
      const museumFoodHarbor =
        /museum/.test(pattern) &&
        (/food/.test(pattern) || /harbor/.test(pattern) || /walk/.test(pattern) || /garden/.test(pattern));

      if (regionalCount === 0 && museumFoodHarbor) urbanLikeDays++;
    });

    if (urbanLikeDays >= 4) {
      issues.push(`Too many urban-filler days for a long itinerary: ${urbanLikeDays}.`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    repairDays: [...repairDays].sort((a, b) => a - b),
  };
}

function _plannerBlueprintPrompt_(languageLine = "") {
  return `
You are Astra's GLOBAL itinerary architect.

Return ONLY valid JSON.

Your task is NOT to generate itinerary rows yet.
Your task is to create a destination profile and a master day plan that will later control row generation.

${languageLine || ""}

OUTPUT SHAPE:
{
  "destination":"City or destination",
  "days_total": number,
  "destination_profile":{
    "destination_type":"dense_city | gateway_outward_base | hybrid | island_beach_relax | roadtrip_multi_base | nature_adventure_base",
    "city_weight": number,
    "outward_weight": number,
    "special_experience_weight": number,
    "pace":"light | balanced | active",
    "reasoning_summary":"short internal-style summary but user-safe"
  },
  "core_city_buckets":[
    {"bucket":"name","priority":1,"notes":"why it matters"}
  ],
  "regional_buckets":[
    {"bucket":"name","priority":1,"notes":"why it matters"}
  ],
  "special_experience_buckets":[
    {"bucket":"name","priority":1,"notes":"why it matters"}
  ],
  "master_day_plan":[
    {
      "day":1,
      "day_identity":"short unique identity",
      "bucket":"specific bucket to use",
      "bucket_type":"city_core | regional_day_trip | special_experience | food_culture | recovery_light | transfer_arrival_departure | night_experience",
      "must_include":[],
      "avoid":[],
      "notes":"short generation instruction"
    }
  ],
  "global_avoid_repetition_rules":[
    "short rule"
  ]
}

GLOBAL RULES:
- This must work for ANY city in the world.
- Dynamically classify the destination:
  dense_city, gateway_outward_base, hybrid, island_beach_relax, roadtrip_multi_base, or nature_adventure_base.
- For long stays, avoid filling extra days with weak urban filler if stronger regional/special buckets exist.
- The master_day_plan MUST assign a distinct identity to every day.
- Do NOT repeat the same bucket, route, corridor, neighborhood pattern, or day shape.
- If destination is a gateway/outward base, outward/regional/special buckets must dominate.
- If destination is a dense city, city districts can dominate, but day identities must still be meaningfully different.
- Respect user language selection, dates, hours, hotel/base, transport preference, pace, travelers, restrictions, and must-includes.
- If start time of Day 1 is late, Day 1 should normally be a lighter city/arrival rhythm, not a major distant day trip.
- If last day has early end, use a realistic final-day bucket.
- Do not hardcode only one destination; reason globally.
`.trim();
}

function _buildBlueprintContractBlock_(blueprint = null) {
  if (!blueprint || typeof blueprint !== "object") return "";

  return `
PRECOMPUTED DESTINATION BLUEPRINT + MASTER DAY PLAN (HIGHEST PRIORITY AFTER USER HARD CONSTRAINTS):
You MUST follow this blueprint when generating the itinerary rows.
Do NOT ignore it.
Do NOT collapse multiple day identities into repeated city filler.
Do NOT create days outside their assigned bucket unless impossible; if impossible, choose the closest stronger unused bucket.

${_safeStringify_(blueprint, 14000)}

MASTER DAY PLAN CONTRACT:
- Every day MUST follow its assigned "bucket" and "day_identity".
- Every day must feel materially different from the others.
- Do NOT repeat POIs, neighborhoods, regional corridors, route logic, or day shape.
- If a day is assigned "regional_day_trip", generate real sub-stops and close with a return row.
- If a day is assigned "city_core", use true city imperdibles and avoid weak filler.
- If a day is assigned "special_experience", make that special experience the spine of the day.
- If the itinerary is in Spanish, Portuguese, French, Italian, German, etc., ALL user-facing fields must use that language.
`.trim();
}

// ==============================
// Improved base prompt ✨ (PLANNER)
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
Translation rule:
- Do NOT translate into the site/system language unless explicitly requested by the user.
- The output must strictly follow the selected or inferred language rules above.

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
  • Only the final row (or at most the final 1–2 rows if needed) may approach the day end.
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
  • This applies EVEN IF the names are translated, abbreviated, paraphrased, misspelled, or written differently.
  • Treat equivalent routes/areas across languages and naming variants as the SAME underlying itinerary.
  • Every day must feel strategically different from the others.
- Local times must be realistic; if the user doesn't provide hours, decide as an expert.
- Times must be ordered and NOT overlap.
- from/to/transport: NEVER empty.
- Do NOT return "seed" or empty notes.
- ANTI-EMPTY DAYS:
  - If a day has a normal daytime window (>=6h) and no strict limitations, provide at least 4–15 rows (not 1–2).
  - If a night-only item exists (e.g., aurora), do NOT make it the only row unless the user explicitly made that day night-only.
  - For multi-day itineraries, you MUST distribute meaningful rows across ALL days.
  - A day is NOT valid if it only contains a trivial placeholder like "free day", "last moments", or one single short stop, unless the user explicitly requested a light/rest day or the available time window is genuinely short.
  - If the itinerary still has unscheduled key highlights and a day remains weak, you MUST use that day to place coherent remaining highlights.
  - Regional/scenic/day-trip days MUST NOT contain giant dead gaps.
  - If a regional day contains gaps larger than roughly 2h–2h30, you MUST enrich the route with REAL intermediate micro-stops from the same geographic corridor.
  - Micro-stops must appear as REAL itinerary rows, not only inside notes.

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
  • CRITICAL CONTINUITY (no teleporting):
    - By default, the next row's "from" should match the previous row's "to" (or be an immediately plausible continuation).
    - If you need to switch context, add a realistic transfer row OR set "from" to the actual prior "to".
  • The row time block must be broadly consistent with its stated duration.
- CRITICAL: if an anchor activity occupies only part of the day and there is still a useful remaining time window, you MUST complete that day with nearby coherent real stops unless the user explicitly wanted a short/light day.

ONE-DAY ITINERARIES (DOUBLECHECK, IMPORTANT):
- If days_total = 1, provide a well-detailed day plan:
  • Aim for 6–10 rows for a normal full day window.
  • If the available time window is short, provide 3–5 rows.
  • Do NOT return only 1–2 rows unless the user explicitly requests a minimal plan.

TRANSPORT OPTIMIZATION (GLOBAL, ULTRA-IMPORTANT):
- For EVERY row, choose the MOST EFFICIENT and REALISTIC transport for that exact from->to pair.
- Use internal knowledge of each city/region's mobility options.
- Do NOT default to "Walk" unless genuinely optimal.
- If public transport is clearly faster/reliable, prefer it.
- For DAY TRIPS from major cities, prefer the most efficient common option unless the user explicitly prefers a guided tour or car.
- Never leave transport blank; never use vague transport.
- NEVER contaminate "from" or "to" fields with transport preference text such as "rental car", "recommend me", or "guided tour".

MANDATORY ROW CONTRACT:
- day (number)
- start/end in HH:MM (local time)
- activity: ALWAYS "DESTINATION – SUB-STOP" (– or - with spaces). Generic like "museum", "park", "local restaurant" is forbidden.
  IMPORTANT (GLOBAL):
  - "DESTINATION" is NOT always the base city:
    • If the row belongs to a DAY TRIP / MACRO-TOUR, "DESTINATION" must be the macro-tour NAME.
    • If it's NOT a day trip, "DESTINATION" can be the base city.
  - This also applies to transfers/returns:
    • Day trip example: "South Coast – Return to Reykjavik"
    • City example: "Budapest – Return to hotel"
  - CRITICAL GEOGRAPHIC SEMANTICS:
    • If the stop is clearly outside the base city, do NOT label it as "<Base city> – <Outside stop>" unless it is explicitly a departure or return row.
- duration: EXACTLY 2 lines with \\n:
  "Transport: <realistic estimate or ~range>"
  "Activity: <realistic estimate or ~range>"
  FORBIDDEN: "Transport: 0m" or "Activity: 0m"
- notes: required (>=20 chars), motivating and useful.

MEALS (Flexible rule):
- NOT mandatory.
- Include ONLY if they add real value to the flow.
- If included, NOT generic.
- Meal stops must be specific enough to be useful.

HOURS / CLOSURES (GLOBAL, anti-impossible schedules):
- For places with typical hours, do NOT schedule visits outside a reasonable daytime window.
- Guideline if not 100% sure: 10:00–17:00 for indoor/museums.
- For viewpoints/bridges/outdoor areas, you can be more flexible.

NIGHT TOURS (GLOBAL, when applicable):
- If the destination has an iconic night highlight or classic night experience, include AT LEAST 1 iconic night activity.

AURORAS (HARD RULE + REPLACEMENT):
- FORBIDDEN unless truly plausible by latitude/season.
- If auroras are NOT plausible and you need a night highlight, replace with a real iconic night experience.
- When auroras ARE plausible:
  • Aurora viewing is a NIGHT activity.
  • If included, they MUST appear as at least one REAL row with nighttime schedule.
  • Auroras should usually be 1–2 rows total.
  • Add practical note about cloud cover / forecast / flexibility.
  • Avoid consecutive days if there is room elsewhere.

DAY TRIPS / MACRO-TOURS:
- If you create a day trip, break it down into 5–15 sub-stops WHEN IT ADDS REAL VALUE.
- Strong regional routes should feel like expert-designed exploration days.
- Always close with a dedicated return row:
  • Use the macro-tour "DESTINATION": "<Macro-tour> – Return to {Base city}".
- Avoid the last day if there are options.
- For day trips, avoid optimistic timing.
- A macro-tour is NOT valid if:
  • it has too few useful rows,
  • it skips logical signature highlights,
  • it hides key highlights only in notes,
  • or it lacks a dedicated realistic return row.
- NEVER repeat the same flagship regional route twice in one itinerary unless there is truly no strong alternative.
- Each day must have a clearly distinct identity.

ICELAND CURATION (when relevant):
  • From Reykjavik, prioritize high-value realistic day trips such as Golden Circle, South Coast, Reykjanes / Blue Lagoon area, Snæfellsnes, and other realistic Southwest / West Iceland options.
  • For South Coast:
    - If the route reaches the Reynisfjara / Vík area, Vík should normally be included unless there is a strong reason not to.
    - Reynisfjara must appear as a real row if that South Coast stretch is being used; do NOT leave it only in notes.
  • For Snæfellsnes:
    - Prefer specific iconic stops such as Kirkjufell, Arnarstapi/Hellnar, Djúpalónssandur, Lóndrangar, Búðir/Búðakirkja when appropriate.
  • For Reykjanes / Blue Lagoon:
    - If Blue Lagoon is included and the available day still has a useful remaining window, prefer integrating it with coherent Reykjanes Peninsula stops instead of leaving the day half-empty.
  • Avoid extreme same-day round trips from Reykjavik to very distant North Iceland highlights.
  • Do NOT repeat the same Iceland macro-route across different days.
  • Iceland itineraries must maximize geographic diversity across days.

SAFETY / GLOBAL COHERENCE:
- Do not propose things that are infeasible due to distance/time/season or obvious risks.
- Prioritize plausible, safe, and reasonable options.

SMART EDITING:
- If the user asks to add/remove/adjust schedules, return updated JSON that remains consistent.
- By default, preserve the itinerary's global coherence.

FINAL INTERNAL QUALITY CHECK (MANDATORY BEFORE OUTPUT):
- Before returning JSON, internally verify:
  • no duplicated macro-routes
  • no duplicated regional circuits
  • no semantically equivalent translated routes
  • no repeated route under alternate names
  • no structurally repetitive days
  • no repeated neighborhood/corridor/day-shape pattern
  • no giant unexplained gaps in regional/scenic days
  • no weak sparse flagship routes
  • no important micro-stops hidden only in notes
  • no generic macro labels such as "Cultura y Naturaleza", "Culture and Nature", "Local Culture", or "Urban Culture"
  • no internal fallback/debug wording in user-facing fields
- If any of those problems exist:
  • rebuild the affected day internally BEFORE returning JSON.
- NEVER return a knowingly repetitive or sparse itinerary if stronger alternatives exist.

Respond with valid JSON only.
`.trim();

// ==============================
// Base prompt ✨ (FREE INFO CHAT)
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
// Model call
// ==============================
async function callStructured(messages, temperature = 0.28, max_output_tokens = 2600, timeoutMs = 90000) {
  const input = (messages || []).map((m) => `${String(m.role || "user").toUpperCase()}: ${m.content}`).join("\n\n");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await client.responses.create(
      {
        model: "gpt-4o-mini",
        temperature,
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

    if (mode === "info") {
      const raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT_INFO }, ...clientMessages], 0.45, 2600, 70000);
      const text = raw || "⚠️ No response was obtained from the assistant.";
      return res.status(200).json({ text });
    }

    const override = detectLanguageOverride(clientMessages);
    const overrideLine = override
      ? `LANGUAGE OVERRIDE (USER-SELECTED, HIGHEST PRIORITY): Output MUST be in ${override.toUpperCase()}.\n- Ignore earlier mixed-language content.\n- Keep ALL JSON keys/shape the same.\n`
      : "";

    let blueprint = null;

    try {
      const blueprintRaw = await callStructured(
        [
          { role: "system", content: _plannerBlueprintPrompt_(overrideLine) },
          ...clientMessages,
        ],
        0.18,
        1800,
        45000
      );

      const parsedBlueprint = cleanToJSON(blueprintRaw);

      if (
        parsedBlueprint &&
        Array.isArray(parsedBlueprint?.master_day_plan) &&
        parsedBlueprint.master_day_plan.length
      ) {
        blueprint = parsedBlueprint;
        console.log("🧭 BLUEPRINT:", JSON.stringify(blueprint));
      }
    } catch (bpErr) {
      console.warn("Blueprint step failed; continuing without blueprint:", bpErr?.message || bpErr);
      blueprint = null;
    }

    const blueprintBlock = _buildBlueprintContractBlock_(blueprint);
    const SYSTEM_PROMPT_EFFECTIVE = (overrideLine + SYSTEM_PROMPT + (blueprintBlock ? "\n\n" + blueprintBlock : "")).trim();

    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT_EFFECTIVE }, ...clientMessages], 0.24, 6200, 110000);
    let parsed = cleanToJSON(raw);

    const hasSome =
      parsed && (Array.isArray(parsed.city_day) || Array.isArray(parsed.rows) || Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictPrompt =
        SYSTEM_PROMPT_EFFECTIVE +
        `

MANDATORY:
- Respond with valid JSON only.
- Must include city_day (preferred) or rows (legacy) with at least 1 row.
- No meta or text outside.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.18, 6800, 115000);
      parsed = cleanToJSON(raw);
    }

    const stillBad =
      !parsed || (!Array.isArray(parsed.city_day) && !Array.isArray(parsed.rows) && !Array.isArray(parsed.destinations));

    if (stillBad) {
      const ultraPrompt =
        SYSTEM_PROMPT_EFFECTIVE +
        `

Minimal valid example (DO NOT copy it literally; format guide only):
{
  "destination":"CITY",
  "days_total":1,
  "city_day":[{"city":"CITY","day":1,"rows":[
    {"day":1,"start":"09:30","end":"11:00","activity":"CITY – Iconic spot","from":"Hotel","to":"Center","transport":"Walk","duration":"Transport: ~10m\\nActivity: ~90m","notes":"Discover a landmark corner and arrive early to avoid lines. Tip: bring water and check hours.","kind":"","zone":""}
  ]}],
  "followup":""
}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.12, 7000, 115000);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON(lang);

    parsed = normalizeParsed(parsed);

    try {
      const scan = _qualityScan_(parsed);

      if (!scan.ok && scan.issues.length) {
        console.warn("🧪 QUALITY ISSUES:", scan);

        const qualityRetryPrompt =
          SYSTEM_PROMPT_EFFECTIVE +
          `

QUALITY REPAIR RETRY (CRITICAL):
The previous JSON was valid but failed deterministic quality checks.
You must regenerate the itinerary JSON, not explain.

Detected issues:
${scan.issues.map((x) => `- ${x}`).join("\n")}

Repair days to focus on:
${JSON.stringify(scan.repairDays)}

Rules:
- Keep the same output JSON contract.
- Follow the master day plan if provided.
- Do NOT repeat POIs, harbor/waterfront corridors, museums, restaurants, neighborhoods, regional routes, or day patterns.
- Do NOT use generic macro labels.
- Do NOT leak transport preference text into from/to.
- Do NOT output fallback/debug/internal repair wording.
- If long stay and destination has strong outward/special buckets, use those before extra urban filler.
- Preserve language consistency.

Previous flawed itinerary summary:
${_safeStringify_(parsed, 18000)}
`.trim();

        const retryRaw = await callStructured([{ role: "system", content: qualityRetryPrompt }, ...clientMessages], 0.18, 7000, 115000);
        const retryParsedRaw = cleanToJSON(retryRaw);

        if (retryParsedRaw) {
          const retryParsed = normalizeParsed(retryParsedRaw);
          const retryScan = _qualityScan_(retryParsed);

          const originalIssueCount = scan.issues.length;
          const retryIssueCount = retryScan.issues.length;

          if (
            (Array.isArray(retryParsed?.city_day) || Array.isArray(retryParsed?.rows) || Array.isArray(retryParsed?.destinations)) &&
            retryIssueCount <= originalIssueCount
          ) {
            parsed = retryParsed;
            console.log("✅ QUALITY RETRY ACCEPTED:", retryScan);
          } else {
            console.warn("⚠️ QUALITY RETRY REJECTED; keeping original parsed itinerary:", retryScan);
          }
        }
      }
    } catch (qErr) {
      console.warn("Quality scan/retry failed; continuing with parsed itinerary:", qErr?.message || qErr);
    }

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
      const lang = detectUserLang(clientMessages);
      return res.status(200).json({ text: JSON.stringify(fallbackJSON(lang)) });
    } catch {
      return res.status(200).json({ text: JSON.stringify(fallbackJSON("en")) });
    }
  }
}
