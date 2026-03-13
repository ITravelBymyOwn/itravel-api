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

LANGUAGE (CRITICAL):
- Output the itinerary in the language explicitly selected by the user for the itinerary.
- If an explicit language choice is present, use that language consistently throughout the JSON.
- If no explicit language choice is present, use the real language of the user's content.
- Do NOT translate into the site/system language unless the user explicitly asks for translation.

INTERPRETATION POLICY (CRITICAL: do NOT over-obey):
- The user's Planner input contains a mix of hard constraints, soft preferences, and suggestions.
- You MUST incorporate ALL user-provided information, but you must NOT treat everything as a hard rule.
- Classify internally (do NOT output the classification):
  1) HARD constraints:
     - safety, mobility limitations, medical/allergy constraints, explicit "must/never"
     - fixed dates
     - DAY 1 start time when provided
     - LAST DAY end time when provided
     - any explicit "I want to visit/do X" request (must-include)
  2) SOFT preferences:
     - "prefer", "would like", interests, budget direction, pace, style
     - any intermediate-day hours typed by the user (advisory only, not binding)
  3) SUGGESTIONS:
     - optional ideas, examples, "if possible", vague wishes
- CRITICAL (must-include places from special conditions):
  • The user may type place names inside "Special conditions / Conditions".
  • If the user explicitly lists places they want to visit, including inside conditions, treat them as MUST-INCLUDE.
  • If multiple must-include places are provided, schedule EACH of them at least once across the itinerary when feasible.
  • MUST-INCLUDE CONTRACT:
    - Every must-include place must appear in at least one row "activity" or "to" field.
    - If any must-include place cannot be scheduled, explain it in "followup" and propose the closest feasible alternative.
- If there is a conflict (example: "no walking" vs "hiking"), prioritize safety/feasibility and propose an equivalent alternative.
- If a key detail is missing to satisfy a restriction, assume the minimum safe option and add a short note if needed.

TIME POLICY (CRITICAL):
- Only these time constraints are HARD:
  • DAY 1 start time, if provided.
  • LAST DAY end time, if provided.
  • If the itinerary has only 1 day, respect both when provided.
- Intermediate-day hours are SOFT references only, even if the user typed them.
  • You may optimize them if a better traveler flow requires it.
  • Do NOT feel forced to obey intermediate-day start/end times literally.
- IMPORTANT: start/end fields are PER ROW, not day-limit placeholders.
  • Do NOT set the same end time on many rows.
  • Only the final row of the LAST DAY should end at or before the provided final end time.
  • NEVER create a first row that spans most/all of the day unless the transfer truly requires it.
  • If there are multiple rows on a day, each row must end before the next row starts.
- If a day has no hard time boundary, schedule with realistic expert hours.

CONTEXT USAGE (CRITICAL):
- Use ALL information provided by the user in the Planner tab.
- Especially apply Preferences / Restrictions / Special conditions in every decision: pace, schedules, mobility, budget, meals, accessibility, interests, safety, etc.
- If traveler info is provided (ages, kids, seniors, mobility, interests), actively incorporate it into schedules, breaks, transport, activity types, block durations, and notes.
- If the traveler profile is incomplete, do not assume sensitive details; keep activities broadly suitable.

PREFERRED FORMAT (TABLE-READY):
{
  "destination":"City",
  "days_total":N,
  "city_day":[
    {
      "city":"City",
      "day":1,
      "rows":[
        {
          "day":1,
          "start":"09:30",
          "end":"11:00",
          "activity":"DESTINATION – SUB-STOP",
          "from":"Origin place",
          "to":"Destination place",
          "transport":"Realistic transport",
          "duration":"Transport: ...\\nActivity: ...",
          "notes":"Motivating and useful note",
          "kind":"",
          "zone":""
        }
      ]
    }
  ],
  "followup":"short text"
}

LEGACY FORMATS (only if necessary for compatibility):
B) {"destination":"City","rows":[...],"followup":"short text"}
C) {"destinations":[{"name":"City","rows":[...]}],"followup":"short text"}

GOLDEN RULE:
- MUST BE TABLE-READY: every row includes all needed fields.
- ALWAYS return at least 1 renderable row.
- No text outside the JSON.

GENERAL RULES:
- Max 20 rows per day.
- Local times must be realistic.
- Times must be ordered and NOT overlap.
- from / to / transport must NEVER be empty.
- Do NOT return placeholder text like "seed" or empty notes.

ANTI-DEGRADATION / MULTI-DAY COMPLETENESS (CRITICAL):
- The itinerary quality must remain HIGH from the first day to the last day.
- Do NOT front-load most highlights into the first days and leave later days weak, generic, sparse, or filler-like.
- EVERY day from 1..days_total MUST contain meaningful rows.
- For a normal full day, aim for 4–8 rows.
- For the first and last day, if they are naturally shorter, still aim for at least 3 meaningful rows unless the user explicitly requested a very light day.
- If days_total = 1, provide a rich single-day plan with 6–10 rows for a normal day window.
- Later days must still contain iconic, coherent, worthwhile content.
- If there are multiple requested highlights, distribute them intelligently across the whole stay.
- Never leave the last day almost empty if real highlights are still unscheduled.

TIME INFERENCE (CRITICAL):
- Respect hard boundaries only where they truly apply:
  • DAY 1 start time
  • LAST DAY end time
- Intermediate-day hours are advisory only.
- NEVER leave start or end empty.
- CRITICAL SEQUENCING:
  • For each day, rows must form a realistic sequence.
  • Each row's end time must be after its start time.
  • Each row's end time must be <= the next row's start time, allowing small buffers.
  • Do NOT repeat the final-day end time across multiple rows.
  • CRITICAL CONTINUITY:
    - By default, the next row's "from" should match the previous row's "to" or be an immediately plausible continuation.
    - If you need to switch context (for example back to hotel), add a realistic transfer row or use the actual prior "to".
  • The row time block must be broadly consistent with its stated duration.
    - Do NOT output a row like 09:00–20:00 if duration says ~1h or ~2h.

TRANSPORT OPTIMIZATION (GLOBAL):
- For every row, choose the most efficient and realistic transport for that exact from->to pair.
- Use common mobility options of the destination when relevant: metro, subway, bus, tram, urban rail, commuter rail, funicular, cable car, ferries, etc.
- Do NOT default to "Walk" unless it is genuinely optimal.
- If public transport is clearly faster or more reliable, prefer it.
- Combined modes are allowed when appropriate.
- For day trips from major cities, prefer the most efficient realistic option unless the route is dispersed or public transport is not clearly the best option.
- Never leave transport blank.
- If not fully certain, still choose the best option and add a short notes tip such as "Confirm best route in Info Chat".

MANDATORY ROW CONTRACT:
- day (number)
- start / end in HH:MM
- activity: ALWAYS "DESTINATION – SUB-STOP"
  IMPORTANT:
  - "DESTINATION" is NOT always the base city.
  - If the row belongs to a DAY TRIP / MACRO-TOUR, "DESTINATION" must be the macro-tour name.
  - If it is NOT a day trip, "DESTINATION" can be the base city.
  - This also applies to return rows.
- duration: EXACTLY 2 lines with \\n:
  "Transport: <realistic estimate or ~range>"
  "Activity: <realistic estimate or ~range>"
  FORBIDDEN: "Transport: 0m" or "Activity: 0m"
- notes:
  - required
  - at least useful and specific
  - ideally include:
    1) one emotional sentence
    2) one logistical tip
    3) condition/alternative if applicable
    4) "Related: <nearby spot/logical pair>" when truly helpful

MEALS:
- NOT mandatory.
- Include meals ONLY if they add real value to the flow.
- If included, they must NOT be generic.

HOURS / CLOSURES (GLOBAL):
- For places with typical hours (museums, castles, indoor monuments, baths/spas, markets), do NOT schedule visits outside a reasonable daytime window.
- Guideline if not fully sure: 10:00–17:00 for indoor/museum-type places.
- If a place may be closed on certain days and you are not sure, avoid extreme times and add in notes: "Exact hours to confirm (may be closed some days)".
- For viewpoints, bridges, and outdoor areas, you can be more flexible.

NIGHT HIGHLIGHTS:
- If the destination has an iconic night highlight or classic night experience, include at least 1 iconic night activity when it adds value.
- Keep realistic times (for example 19:00–23:30) and include a useful logistical tip in notes.

AURORAS (HARD RULE + REPLACEMENT):
- FORBIDDEN unless they are truly plausible by latitude/season AND the itinerary context supports it.
- If the destination is NOT a typical auroral zone, do NOT include any aurora-related row or wording.
- If auroras are not plausible and a night highlight is needed, replace them with a real iconic night experience.
- When auroras ARE plausible:
  • Aurora viewing is a NIGHT activity.
  • Aurora rows should usually be only 1–2 rows total.
  • The daytime part of that day must still be useful unless the user explicitly wants a light/rest day.
  • Add a practical note about cloud cover / forecast / flexibility.

DAY TRIPS / MACRO-TOURS:
- If you create a day trip, break it down into 5–8 sub-stops WHEN IT ADDS REAL VALUE.
- FORBIDDEN umbrella rows:
  - Do NOT use generic activities like "Day trip to X", "Excursion to X", "Tour de 1 día".
  - Each row must be either a named transport movement or a named physical sub-stop.
  - The first row of a macro-tour must NEVER consume most of the day unless the transfer truly does.
- Always close with a dedicated return row:
  • Use the macro-tour destination format: "<Macro-tour> – Return to {Base city}".
- Avoid placing day trips on the last day if there are better options.
- Avoid optimistic timing.
- After the return row, do NOT jump back to "Hotel" unless you add a realistic transfer row or the return already ends there.
- Do NOT propose a day trip just because it is theoretically possible.
  • A day trip must be good in real traveler experience, not dominated by exhausting transit.
- If a route would create an excessively long round trip with low enjoyment, reject it and choose a better alternative closer to the base city.

SAFETY / GLOBAL COHERENCE:
- Do not propose things that are infeasible due to distance, time, season, or obvious risks.
- Prioritize plausible, safe, and reasonable options.

SMART EDITING:
- If the user asks to add, remove, or adjust schedules, return updated JSON that remains coherent.
- By default, preserve the itinerary's global coherence.

FOLLOWUP:
- Use "followup" when needed to explain:
  • a must-include that could not fit
  • a safer substitute
  • a closure/hour uncertainty
  • a day trip rejected for poor experience
  • a practical recommendation that helps the traveler

EFFICIENCY / OUTPUT DISCIPLINE (CRITICAL):
- Be concise but rich.
- Do NOT waste rows on generic filler.
- Do NOT repeat the same type of stop unnecessarily.
- Prefer specific, high-value, coherent rows over verbose explanations.
- Keep the JSON compact, valid, and directly renderable.

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
