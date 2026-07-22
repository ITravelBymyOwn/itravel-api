// /api/chat.js — v58 (surgically adjusted per v52.5 rules) — ESM compatible on Vercel
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
// Deterministic validation + surgical repair (v59)
// ==============================
const MAX_REPAIR_ATTEMPTS = Math.max(
  0,
  Math.min(2, Number.parseInt(process.env.ITBMO_MAX_REPAIRS || "2", 10) || 2)
);

function _normKey_(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _parseTime_(value = "") {
  const m = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function _cleanPlannerLeak_(value = "") {
  return String(value || "")
    .replace(/\bclose\s+to\b/gi, "")
    .replace(/\brecommend\s*me\b/gi, "")
    .replace(/\brecommended\s+by\s+(the\s+)?planner\b/gi, "")
    .replace(/\bas\s+appropriate\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "")
    .trim();
}

function _durationToMinutes_(value = "") {
  const s = _normKey_(value);
  if (!s) return null;

  let total = 0;
  const h = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|hora|horas)/);
  const m = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes|minuto|minutos)/);

  if (h) total += Math.round(Number(h[1]) * 60);
  if (m) total += Number(m[1]);

  if (!h && !m) {
    const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range) total = Math.round((Number(range[1]) + Number(range[2])) / 2);
  }

  return total > 0 ? total : null;
}

function _formatDuration_(minutes) {
  const n = Math.max(1, Math.round(Number(minutes) || 1));
  if (n < 60) return `~${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
}

function _extractDurationPart_(duration = "", labels = []) {
  const source = String(duration || "");
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*:\\s*([^\\n|;]+)`, "i");
    const match = source.match(re);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function _normalizeDurationV59_(row = {}) {
  const raw = String(row?.duration || "");
  const transportRaw = _extractDurationPart_(raw, ["Transport", "Transporte"]);
  const activityRaw = _extractDurationPart_(raw, [
    "Activity",
    "Atividade",
    "Actividad",
    "Activité",
    "Aktivität",
    "Attività",
  ]);

  const start = _parseTime_(row?.start);
  const end = _parseTime_(row?.end);
  const blockMinutes = start != null && end != null && end > start ? end - start : 60;

  const transportMinutes = _durationToMinutes_(transportRaw) || 10;
  const activityMinutes = _durationToMinutes_(activityRaw) || Math.max(15, blockMinutes - transportMinutes);

  return `Transport: ${_formatDuration_(transportMinutes)}\nActivity: ${_formatDuration_(activityMinutes)}`;
}

function _normalizeRowV59_(row = {}, blockDay = 1, previousTo = "") {
  const from = _cleanPlannerLeak_(row?.from) || _cleanPlannerLeak_(previousTo) || "Hotel";
  const activity = String(row?.activity || "").replace(/\s+/g, " ").trim();
  const inferredTo = activity.split(/\s+[–-]\s+/).pop() || "Destination";
  const to = _cleanPlannerLeak_(row?.to) || _cleanPlannerLeak_(inferredTo);

  return {
    ...row,
    day: Number(row?.day) || Number(blockDay) || 1,
    start: String(row?.start || "").trim(),
    end: String(row?.end || "").trim(),
    activity,
    from,
    to,
    transport: String(row?.transport || "").replace(/\s+/g, " ").trim(),
    duration: _normalizeDurationV59_(row),
    notes: String(row?.notes || "").replace(/\s+/g, " ").trim(),
    kind: row?.kind ?? "",
    zone: row?.zone ?? "",
  };
}

function _normalizeCityDayV59_(city_day, destinationFallback = "") {
  const uniqueDays = new Map();

  for (const [idx, block] of (Array.isArray(city_day) ? city_day : []).entries()) {
    const day = Number(block?.day) || idx + 1;
    let previousTo = "";
    const rows = (Array.isArray(block?.rows) ? block.rows : [])
      .map((row) => {
        const normalized = _normalizeRowV59_(row, day, previousTo);
        previousTo = normalized.to;
        return normalized;
      })
      .sort((a, b) => (_parseTime_(a.start) ?? 9999) - (_parseTime_(b.start) ?? 9999));

    uniqueDays.set(day, {
      city: String(block?.city || block?.destination || destinationFallback || "").trim(),
      day,
      rows,
    });
  }

  return [...uniqueDays.values()].sort((a, b) => a.day - b.day);
}

function _normalizeParsedV59_(parsed) {
  parsed = normalizeParsed(parsed);
  if (!parsed || typeof parsed !== "object") return parsed;

  if (Array.isArray(parsed.city_day)) {
    parsed.city_day = _normalizeCityDayV59_(parsed.city_day, parsed.destination);
  }

  if (Array.isArray(parsed.rows)) {
    parsed.rows = parsed.rows.map((row) => _normalizeRowV59_(row, row?.day || 1, ""));
  }

  if (Array.isArray(parsed.destinations)) {
    parsed.destinations = parsed.destinations.map((destination) => {
      const name = destination?.name || destination?.destination || "";
      return {
        ...destination,
        rows: Array.isArray(destination?.rows)
          ? destination.rows.map((row) => _normalizeRowV59_(row, row?.day || 1, ""))
          : destination?.rows,
        city_day: Array.isArray(destination?.city_day)
          ? _normalizeCityDayV59_(destination.city_day, name)
          : destination?.city_day,
      };
    });
  }

  return parsed;
}

function _rowRangeForDay_(block = {}) {
  const rows = Array.isArray(block?.rows) ? block.rows : [];
  if (!rows.length) return { min: 1, max: 20 };

  const first = _parseTime_(rows[0]?.start);
  const last = _parseTime_(rows[rows.length - 1]?.end);
  const span = first != null && last != null && last > first ? last - first : null;

  if (span != null && span < 240) return { min: 2, max: 6 };
  if (span != null && span < 360) return { min: 3, max: 8 };
  return { min: 4, max: 15 };
}

function _isLikelyDayTrip_(block = {}) {
  const text = _normKey_(
    (Array.isArray(block?.rows) ? block.rows : [])
      .map((r) => `${r?.activity || ""} ${r?.to || ""} ${r?.notes || ""}`)
      .join(" ")
  );

  return [
    "day trip",
    "excursion",
    "excursao",
    "excursión",
    "regional",
    "circle",
    "circuito",
    "coast",
    "costa",
    "peninsula",
    "península",
    "toledo",
    "girona",
    "montserrat",
  ].some((hint) => text.includes(_normKey_(hint)));
}

function _hasReturnRow_(block = {}) {
  const rows = Array.isArray(block?.rows) ? block.rows : [];
  const lastRows = rows.slice(-2);
  const text = _normKey_(
    lastRows.map((r) => `${r?.activity || ""} ${r?.to || ""} ${r?.notes || ""}`).join(" ")
  );

  return [
    "return",
    "back to",
    "regresso",
    "retorno",
    "regreso",
    "volta",
    "hotel",
  ].some((hint) => text.includes(_normKey_(hint)));
}

function _validateCityDayV59_(parsed) {
  const errors = [];
  const cityDay = Array.isArray(parsed?.city_day) ? parsed.city_day : [];
  const expectedDays = Math.max(1, Number(parsed?.days_total || cityDay.length || 1));

  const dayNumbers = cityDay.map((b) => Number(b?.day)).filter(Number.isFinite);
  const uniqueDayNumbers = new Set(dayNumbers);

  for (let d = 1; d <= expectedDays; d++) {
    if (!uniqueDayNumbers.has(d)) errors.push({ code: "MISSING_DAY", day: d });
  }

  for (const d of new Set(dayNumbers.filter((day, idx) => dayNumbers.indexOf(day) !== idx))) {
    errors.push({ code: "DAY_UNIQUENESS", day: d });
  }

  const poiMap = new Map();

  for (const block of cityDay) {
    const day = Number(block?.day) || 0;
    const rows = Array.isArray(block?.rows) ? block.rows : [];
    const range = _rowRangeForDay_(block);

    if (rows.length < range.min || rows.length > range.max) {
      errors.push({
        code: "ROW_COUNT",
        day,
        actual: rows.length,
        expected_min: range.min,
        expected_max: range.max,
      });
    }

    let previousEnd = null;
    let previousTo = "";

    rows.forEach((row, index) => {
      const rowNumber = index + 1;

      for (const field of ["start", "end", "activity", "from", "to", "transport", "duration", "notes"]) {
        if (!String(row?.[field] || "").trim()) {
          errors.push({ code: "REQUIRED_FIELDS", day, row: rowNumber, field });
        }
      }

      const start = _parseTime_(row?.start);
      const end = _parseTime_(row?.end);

      if (start == null || end == null || start >= end) {
        errors.push({
          code: "TIME_ORDER",
          day,
          row: rowNumber,
          start: row?.start,
          end: row?.end,
        });
      }

      if (previousEnd != null && start != null && start < previousEnd) {
        errors.push({ code: "TIME_OVERLAP", day, rows: [index, rowNumber] });
      }

      if (index > 0 && previousTo) {
        const currentFrom = _normKey_(row?.from);
        const priorTo = _normKey_(previousTo);
        const compatible =
          currentFrom === priorTo ||
          currentFrom.includes(priorTo) ||
          priorTo.includes(currentFrom) ||
          /hotel|station|estacion|estacao|airport|aeroporto|aeropuerto/.test(
            `${currentFrom} ${priorTo}`
          );

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

      const durationLines = String(row?.duration || "").split("\n").filter(Boolean);
      if (
        durationLines.length !== 2 ||
        !/^Transport\s*:/i.test(durationLines[0]) ||
        !/^Activity\s*:/i.test(durationLines[1]) ||
        /\b0m\b/i.test(String(row?.duration || ""))
      ) {
        errors.push({ code: "DURATION_FORMAT", day, row: rowNumber });
      }

      if (
        /\b(close\s+to|recommend\s*me|recommended\s+by\s+planner|as\s+appropriate)\b/i.test(
          `${row?.from || ""} ${row?.to || ""}`
        )
      ) {
        errors.push({ code: "FIELD_CONTAMINATION", day, row: rowNumber });
      }

      if (!/\s+[–-]\s+/.test(String(row?.activity || ""))) {
        errors.push({ code: "ACTIVITY_FORMAT", day, row: rowNumber });
      }

      if (
        /\b(fallback|repair|debug|placeholder|itinerary pending|free day|dia libre|día libre|tempo livre)\b/i.test(
          String(row?.activity || "")
        )
      ) {
        errors.push({ code: "GENERIC_ACTIVITY", day, row: rowNumber });
      }

      const poi = _normKey_(row?.to);
      if (poi && poi.length >= 5) {
        if (!poiMap.has(poi)) poiMap.set(poi, []);
        poiMap.get(poi).push({ day, row: rowNumber });
      }

      previousEnd = end;
      previousTo = row?.to || "";
    });

    if (_isLikelyDayTrip_(block) && !_hasReturnRow_(block)) {
      errors.push({ code: "RETURN_ROW", day });
    }
  }

  for (const [poi, uses] of poiMap.entries()) {
    const distinctDays = [...new Set(uses.map((u) => u.day))];
    if (distinctDays.length > 1) {
      errors.push({ code: "DUPLICATE_POI", poi, uses });
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

function _mergeRepairedDays_(current, repaired) {
  if (!Array.isArray(current?.city_day) || !Array.isArray(repaired?.city_day)) return current;

  const replacements = new Map(
    repaired.city_day.map((block) => [Number(block?.day), block])
  );

  const merged = current.city_day.map(
    (block) => replacements.get(Number(block?.day)) || block
  );

  for (const [day, block] of replacements.entries()) {
    if (!merged.some((existing) => Number(existing?.day) === day)) merged.push(block);
  }

  return {
    ...current,
    city_day: _normalizeCityDayV59_(merged, current?.destination || ""),
    followup: repaired?.followup ?? current?.followup ?? "",
  };
}

function _publicPlannerError_(lang = "en", code = "GENERATION_ERROR") {
  const messages = {
    es: "No fue posible completar el itinerario con la calidad requerida. Inténtalo nuevamente.",
    pt: "Não foi possível concluir o itinerário com a qualidade necessária. Tente novamente.",
    fr: "Impossible de terminer l’itinéraire avec la qualité requise. Veuillez réessayer.",
    de: "Die Reiseroute konnte nicht in der erforderlichen Qualität erstellt werden. Bitte versuchen Sie es erneut.",
    it: "Non è stato possibile completare l’itinerario con la qualità richiesta. Riprova.",
    en: "The itinerary could not be completed at the required quality. Please try again.",
  };

  return {
    ok: false,
    error: {
      code,
      message: messages[lang] || messages.en,
      retryable: true,
      stage: "planner_validation",
    },
  };
}

// ==============================
// Model call — real roles + explicit status/usage
// ==============================
async function callStructured(messages, temperature = 0.28, max_output_tokens = 2600, timeoutMs = 90000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const systemMessages = (messages || []).filter(
    (m) => String(m?.role || "").toLowerCase() === "system"
  );
  const nonSystemMessages = (messages || []).filter(
    (m) => String(m?.role || "").toLowerCase() !== "system"
  );

  const instructions = systemMessages
    .map((m) => String(m?.content || ""))
    .filter(Boolean)
    .join("\n\n");

  const input = nonSystemMessages.map((m) => ({
    role: ["user", "assistant", "developer"].includes(String(m?.role || "").toLowerCase())
      ? String(m.role).toLowerCase()
      : "user",
    content: String(m?.content || ""),
  }));

  try {
    const resp = await client.responses.create(
      {
        model: MODEL,
        instructions,
        reasoning: { effort: "low" },
        input,
        max_output_tokens,
      },
      { signal: controller.signal }
    );

    const text =
      resp?.output_text?.trim() ||
      resp?.output?.[0]?.content?.[0]?.text?.trim() ||
      "";

    console.log("🛰️ MODEL STATUS:", {
      status: resp?.status,
      incomplete_details: resp?.incomplete_details || null,
      usage: resp?.usage || null,
      output_chars: text.length,
    });

    if (resp?.status === "incomplete") {
      const error = new Error("INCOMPLETE_OUTPUT");
      error.code = "INCOMPLETE_OUTPUT";
      error.details = resp?.incomplete_details || null;
      throw error;
    }

    if (!text) {
      const error = new Error("EMPTY_MODEL_OUTPUT");
      error.code = "EMPTY_MODEL_OUTPUT";
      throw error;
    }

    return text;
  } catch (e) {
    console.warn("callStructured error:", e?.message || e);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function _repairPlannerOutput_(
  currentParsed,
  validationReport,
  systemPromptEffective,
  clientMessages,
  attempt
) {
  const affectedDays = validationReport?.affected_days?.length
    ? validationReport.affected_days
    : (currentParsed?.city_day || []).map((block) => Number(block?.day)).filter(Number.isFinite);

  const affectedBlocks = Array.isArray(currentParsed?.city_day)
    ? currentParsed.city_day.filter((block) => affectedDays.includes(Number(block?.day)))
    : [];

  const validSurroundingDays = Array.isArray(currentParsed?.city_day)
    ? currentParsed.city_day.filter((block) => !affectedDays.includes(Number(block?.day)))
    : [];

  const repairPrompt = `
${systemPromptEffective}

SURGICAL REPAIR MODE — ATTEMPT ${attempt}:
- Do NOT regenerate valid days.
- Return a valid JSON object containing ONLY:
  {
    "destination":"same destination",
    "days_total":same number,
    "city_day":[complete replacement blocks only for affected days],
    "followup":""
  }
- Each returned affected day must be complete and table-ready.
- Fix every listed validation error.
- Preserve the selected language.
- Preserve must-includes, day identity, geography and valid content.
- Do not introduce new duplicated POIs, field contamination, overlaps, missing returns or generic filler.
- No text outside JSON.
`.trim();

  const repairContext = {
    validation_errors: validationReport?.errors || [],
    affected_days: affectedDays,
    affected_day_blocks: affectedBlocks,
    valid_surrounding_days: validSurroundingDays,
  };

  const repairMessages = [
    { role: "system", content: repairPrompt },
    ...clientMessages,
    {
      role: "user",
      content: `REPAIR CONTEXT:\n${JSON.stringify(repairContext)}`,
    },
  ];

  const raw = await callStructured(repairMessages, 0.12, 9000, 120000);
  const parsed = cleanToJSON(raw);
  return parsed ? _normalizeParsedV59_(parsed) : null;
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

    // INFO mode remains externally unchanged.
    if (mode === "info") {
      try {
        const raw = await callStructured(
          [{ role: "system", content: SYSTEM_PROMPT_INFO }, ...clientMessages],
          0.45,
          2600,
          70000
        );
        return res.status(200).json({ text: raw });
      } catch {
        return res.status(200).json({
          text:
            lang === "es"
              ? "⚠️ No se obtuvo respuesta del asistente."
              : lang === "pt"
                ? "⚠️ Não foi obtida uma resposta do assistente."
                : "⚠️ No response was obtained from the assistant.",
        });
      }
    }

    const override = detectLanguageOverride(clientMessages);
    const overrideLine = override
      ? `LANGUAGE OVERRIDE (USER-SELECTED, HIGHEST PRIORITY): Output MUST be in ${override.toUpperCase()}.\n- Ignore earlier mixed-language content.\n- Keep ALL JSON keys/shape the same.\n`
      : "";

    const SYSTEM_PROMPT_EFFECTIVE = (overrideLine + SYSTEM_PROMPT).trim();

    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT_EFFECTIVE }, ...clientMessages],
      0.28,
      10000,
      120000
    );
    let parsed = cleanToJSON(raw);

    const hasSome =
      parsed &&
      (Array.isArray(parsed.city_day) ||
        Array.isArray(parsed.rows) ||
        Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictPrompt = `${SYSTEM_PROMPT_EFFECTIVE}

MANDATORY RECOVERY:
- Return valid JSON only.
- Include city_day (preferred), rows, or destinations with renderable rows.
- Complete all requested days.
- No meta commentary or text outside JSON.
- Under token pressure, shorten notes before omitting rows or days.`;

      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.18,
        11000,
        120000
      );
      parsed = cleanToJSON(raw);
    }

    if (!parsed) {
      return res
        .status(200)
        .json({ text: JSON.stringify(_publicPlannerError_(lang, "SCHEMA_ERROR")) });
    }

    parsed = _normalizeParsedV59_(parsed);

    // Apply deterministic validation and repair only to the preferred city_day format.
    // Legacy rows/destinations remain compatible and are returned normalized.
    if (Array.isArray(parsed.city_day)) {
      let report = _validateCityDayV59_(parsed);

      for (
        let attempt = 1;
        !report.ok && attempt <= MAX_REPAIR_ATTEMPTS;
        attempt++
      ) {
        console.warn("🧪 VALIDATION REPORT:", {
          attempt,
          affected_days: report.affected_days,
          codes: [...new Set(report.errors.map((error) => error.code))],
        });

        const repaired = await _repairPlannerOutput_(
          parsed,
          report,
          SYSTEM_PROMPT_EFFECTIVE,
          clientMessages,
          attempt
        );

        if (!repaired?.city_day?.length) break;

        parsed = _mergeRepairedDays_(parsed, repaired);
        parsed = _normalizeParsedV59_(parsed);
        report = _validateCityDayV59_(parsed);
      }

      if (!report.ok) {
        console.error("❌ FINAL BUSINESS VALIDATION ERROR:", report);
        return res.status(200).json({
          text: JSON.stringify(
            _publicPlannerError_(lang, "BUSINESS_VALIDATION_ERROR")
          ),
        });
      }
    }

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    try {
      const body = req?.body || {};
      const clientMessages = extractMessages(body);
      const lang = detectUserLang(clientMessages);
      const code = err?.code === "INCOMPLETE_OUTPUT" ? "INCOMPLETE_OUTPUT" : "MODEL_ERROR";
      return res
        .status(200)
        .json({ text: JSON.stringify(_publicPlannerError_(lang, code)) });
    } catch {
      return res
        .status(200)
        .json({ text: JSON.stringify(_publicPlannerError_("en", "MODEL_ERROR")) });
    }
  }
}
