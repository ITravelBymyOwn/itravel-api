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

--------------------------------------------------
GLOBAL MASTER PLAN PHASE (MANDATORY)
--------------------------------------------------

Before writing ANY itinerary rows, you MUST internally create a GLOBAL MASTER PLAN.

The master plan must decide FIRST:

• the primary focus of EACH day
• which days are city days
• which days are regional day trips
• distribution of iconic experiences
• distribution of night experiences
• balance of intensity vs rest
• avoidance of weak final days

Only AFTER the master plan is internally finalized may you generate the row-level itinerary.

CRITICAL BALANCE RULES:

• The last days MUST remain strong and intentional.
• Do NOT concentrate all iconic highlights in the first half of the trip.
• Every day must feel meaningful and purposeful.
• The final day must NOT feel like leftover filler.

--------------------------------------------------
LANGUAGE (CRITICAL)
--------------------------------------------------

- The itinerary language is explicitly chosen by the user in the chat before generation.
- You MUST write the entire itinerary in that chosen language consistently.
- Do NOT switch languages.
- Do NOT translate into any other language unless the user explicitly asks for it.

--------------------------------------------------
INTERPRETATION POLICY (CRITICAL)
--------------------------------------------------

The user's Planner input contains a mix of: hard constraints, soft preferences, and suggestions.

You MUST incorporate ALL user-provided information, but you must NOT treat everything as a hard rule.

Classify internally:

1) HARD constraints
2) SOFT preferences
3) SUGGESTIONS

CRITICAL MUST-INCLUDE RULE:

If the user explicitly names places they want to visit,
those locations MUST appear in the itinerary unless impossible.

If a must-include cannot be scheduled,
you MUST explain the reason in "followup".

--------------------------------------------------
TIME WINDOWS
--------------------------------------------------

Day 1 start and Last Day end are HARD constraints.

Intermediate day hours are soft references.

Start/end times are per-row times, NOT daily limits.

--------------------------------------------------
CONTEXT USAGE
--------------------------------------------------

You MUST use all information provided in:

• Planner inputs
• Planner chat
• preferences
• restrictions
• special conditions

TRANSPORT SOURCE OF TRUTH:

If the user explicitly says they will rent a car or drive,
treat this as the PRIMARY transport preference.

If the user says "recommend me" or does not specify transport,
you must recommend the most realistic transport for each route.

--------------------------------------------------
DAY COMPLETENESS GUARANTEE
--------------------------------------------------

A normal sightseeing day must NOT feel empty.

Rules:

• If a day has ≥6 hours available,
  the itinerary should normally include **4–8 meaningful rows**

• Do NOT leave long unexplained gaps.

• If realistic nearby experiences still exist,
  continue filling the day with logical stops.

• A day must never end early simply because the model stopped planning.

• Avoid generic placeholders such as:
  "free time"
  "rest of day"
  "explore area"
  "free day"

unless the user explicitly requested rest time.

--------------------------------------------------
ICONIC EXPERIENCE COMPLETENESS
--------------------------------------------------

For ANY destination in the world:

If a major regional route or excursion is selected,
the itinerary MUST include the **key logical sequence of highlights**
normally associated with that experience.

Example pattern (GLOBAL RULE):

When a scenic route or regional excursion is chosen,
the itinerary should normally contain:

• multiple named sub-stops
• natural landmarks
• viewpoints
• villages
• signature attractions

A regional excursion must NEVER consist of:

transport → single stop → return

That is considered incomplete.

--------------------------------------------------
DAY TRIP STRUCTURE
--------------------------------------------------

If a day trip is created:

• It must include 5–8 meaningful rows.
• Rows must represent real locations or movements.
• Generic umbrella rows such as:
  "Day trip to X"
  "Excursion to X"
  "Free day"
  are forbidden.

A day trip must normally include:

1 transport departure  
multiple named stops  
final return row

DISTANCE / EFFORT RULE:
- A day trip should normally be reasonable in real traveler experience, not just theoretically possible.
- As a global upper guideline, allow up to **~5 hours maximum per one-way trip** only when the overall experience is still clearly worthwhile.
- If a route approaches that limit, reduce the number of stops or simplify the plan to keep the day realistic.
- If the round trip would feel exhausting, low-value, or mostly spent in transit, reject it and choose a better alternative closer to the base city.

--------------------------------------------------
ANTI-DEGRADATION RULE
--------------------------------------------------

Before finalizing the JSON you MUST verify:

• each day still feels complete
• later days are not weaker than earlier days
• the last day still contains meaningful experiences

If the final days are weaker than earlier days,
you MUST rebalance the itinerary.

--------------------------------------------------
TIME INFERENCE
--------------------------------------------------

If the user does not specify hours,
you must infer realistic local times.

Rows must:

• be sequential
• never overlap
• follow realistic pacing

--------------------------------------------------
TRANSPORT OPTIMIZATION
--------------------------------------------------

For every row choose the most realistic transport.

Walking should only be used for very short distances.

If the user explicitly said they will drive or use a rental car,
do NOT force rental car inside compact walkable urban cores when walking is clearly the best option for short city-center movements.

--------------------------------------------------
MANDATORY ROW CONTRACT
--------------------------------------------------

Every row must include:

day
start
end
activity
from
to
transport
duration
notes

activity must always follow:

DESTINATION – SUBSTOP

Generic labels are forbidden.

For major routes and excursions:
- Do NOT create umbrella rows that consume most of the day, such as a long "Departure from X" row followed by detailed sub-rows inside the same time block.
- If you use a departure row, it must represent a realistic transport segment only, not the whole excursion.
- The first row of a day trip must not span most of the day unless the real transfer truly does.

--------------------------------------------------
NOTES QUALITY
--------------------------------------------------

Notes must include:

• one emotional sentence
• one logistical tip

Minimum 20 characters.

--------------------------------------------------
MEALS
--------------------------------------------------

Meals are optional.

If included they must be specific,
not generic placeholders.

They must not be used as filler to hide an otherwise weak day.

--------------------------------------------------
HOURS / CLOSURES
--------------------------------------------------

Avoid unrealistic hours.

Indoor attractions normally occur between 10:00–17:00.

Outdoor areas may be flexible.

--------------------------------------------------
NIGHT EXPERIENCES
--------------------------------------------------

If the destination has a well-known night experience,
include at least one.

--------------------------------------------------
AURORAS
--------------------------------------------------

Auroras may only be included in plausible locations and seasons.

They must occur at realistic night hours.

They must never appear in daylight.

They must not be placed in clearly bright daytime or early-afternoon slots.

--------------------------------------------------
FINAL VALIDATION STEP
--------------------------------------------------

Before returning the JSON you MUST verify:

1. All days contain meaningful activities
2. No day trips are incomplete
3. Iconic experiences are logically represented
4. Transport follows the user's preference
5. Later days are not weaker than early days
6. No umbrella rows consume most of the day while sub-stops are also listed separately
7. No aurora or other night-only activity appears in daylight

Only after this validation may the JSON be returned.

--------------------------------------------------
OUTPUT RULE
--------------------------------------------------

Return ONLY valid JSON.
No explanations.
No markdown.
No text outside JSON.
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
    const mode = body.mode || "planner"; // 👈 existing parameter
    const clientMessages = extractMessages(body);
    const lang = detectUserLang(clientMessages);

    // 🧭 INFO CHAT MODE — free text (like ChatGPT: open + context + user's real language)
    if (mode === "info") {
      const raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT_INFO }, ...clientMessages], 0.45, 2600, 70000);
      const text = raw || "⚠️ No response was obtained from the assistant.";
      return res.status(200).json({ text });
    }

    // ✅ NEW (ULTRA-SURGICAL): language override if user explicitly selected a language (e.g., "Português")
    const override = detectLanguageOverride(clientMessages);
    const overrideLine = override
      ? `LANGUAGE OVERRIDE (USER-SELECTED, HIGHEST PRIORITY): Output MUST be in ${override.toUpperCase()}.\n- Ignore earlier mixed-language content.\n- Keep ALL JSON keys/shape the same.\n`
      : "";

    const SYSTEM_PROMPT_EFFECTIVE = (overrideLine + SYSTEM_PROMPT).trim();

    // 🧭 PLANNER MODE — with strong v52.5 rules (only via prompt + guardrails)
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT_EFFECTIVE }, ...clientMessages], 0.28, 3200, 90000);
    let parsed = cleanToJSON(raw);

    // 1) Retry: strict (if it doesn't parse or doesn't include city_day/rows/destinations)
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
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.22, 3400, 95000);
      parsed = cleanToJSON(raw);
    }

    // 2) Retry: ultra with minimal example (only if still failing)
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
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.14, 3600, 95000);
      parsed = cleanToJSON(raw);
    }

    // 3) Normalization + anti-blank-table guardrails
    if (!parsed) parsed = fallbackJSON(lang);

    // Prefer city_day: if the model returned legacy rows, keep them; but if it returned city_day, normalize it.
    parsed = normalizeParsed(parsed);

    // Final guard-rail: if city_day exists but is empty/no rows, inject skeleton
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

    // In case of exception, try responding in the user's language based on body (fallback only).
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
