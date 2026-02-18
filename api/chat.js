// /api/chat.js — v58 (surgically adjusted per v52.5 rules) — ESM compatible on Vercel
// ✅ Keeps v58 interface: receives {mode, input/history/messages} and returns { text: "<string>" }.
// ✅ Does NOT break "info" mode: returns free text.
// ✅ Adjusts ONLY the planner prompt + parse/guardrails to enforce strong rules (prefer city_day, 2-line duration, auroras, macro-tours, etc.).
// ✅ SURGICAL ADJUSTMENT (new): "info" fully open (any topic) + planner/info respond in the REAL language of the user's content (any language).
// ✅ SURGICAL ADJUSTMENT (new): Info Chat "like ChatGPT": keeps context using messages/history and responds conversationally.
// ✅ SURGICAL ADJUSTMENT (new): Planner: forces use of ALL info in the Planner tab, especially Preferences/Restrictions/Special conditions + Travelers (if provided).

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

// Simple multi-language detection (surgical): ONLY for fallback/guardrails when the model doesn't respond.
// Note: does NOT affect normal content (the model decides language via prompt).
function detectUserLang(messages = []) {
  const t = _lastUserText_(messages).trim();
  if (!t) return "es";

  const s = t.toLowerCase();

  // Strong Spanish signals
  if (/[¿¡ñáéíóúü]/i.test(t)) return "es";
  const esHits = (s.match(/\b(el|la|los|las|de|que|y|para|con|por|una|un|como|donde|qué|cuál|cuáles|cómo)\b/g) || []).length;

  // Strong English signals
  const enHits = (s.match(/\b(the|and|for|with|to|from|what|which|how|where|when|please)\b/g) || []).length;

  // Strong French signals
  const frHits = (s.match(/\b(le|la|les|des|de|du|et|pour|avec|sans|où|quoi|quel|quelle|quels|quelles|s\'il|vous)\b/g) || []).length;

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
  const topLang = String(top?.[0] || "es");
  const topScore = Number(top?.[1] || 0);

  // If there are no clear signals, keep default ES (for your current fallback)
  if (!topScore) return "es";
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

function fallbackJSON(lang = "es") {
  const L = String(lang || "").toLowerCase();
  const isES = L === "es";
  const isEN = L === "en";
  // For other languages: fallback in English (surgical; we don't invent translations here)
  const useEN = !isES;

  return {
    destination: isES ? "Unknown" : "Unknown",
    city_day: [
      {
        city: isES ? "Unknown" : "Unknown",
        day: 1,
        rows: [
          {
            day: 1,
            start: "09:30",
            end: "11:00",
            activity: isES ? "Unknown – Base itinerary (fallback)" : "Unknown – Base itinerary (fallback)",
            from: "Hotel",
            to: isES ? "Center" : "Center",
            transport: isES ? "Walk or local transport (depending on location)" : "Walk or local transport (depending on location)",
            duration: isES
              ? "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat"
              : "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat",
            notes: isES
              ? "⚠️ I couldn't generate the itinerary. Check your API key/deployment and try again."
              : "⚠️ I couldn't generate the itinerary. Check your API key/deployment and try again.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: isES
      ? "⚠️ Local fallback: check your Vercel config or API key."
      : "⚠️ Local fallback: check your Vercel config or API key.",
  };
}

// Guard-rail: avoids a blank table if the model fails in planner
function skeletonCityDay(destination = "Destination", daysTotal = 1, lang = "es") {
  const L = String(lang || "").toLowerCase();
  const isES = L === "es";
  // For other languages: skeleton in English (surgical)
  const useEN = !isES;

  const city =
    String(destination || (isES ? "Destination" : "Destination")).trim() || (isES ? "Destination" : "Destination");
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
          activity: isES
            ? `${city} – Retry generation (itinerary pending)`
            : `${city} – Retry generation (itinerary pending)`,
          from: "Hotel",
          to: isES ? "Center" : "Center",
          transport: isES
            ? "Walk or local transport (depending on location)"
            : "Walk or local transport (depending on location)",
          duration: isES
            ? "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat"
            : "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat",
          notes: isES
            ? "⚠️ No valid itinerary was produced in this attempt. Retry or adjust conditions; when it works, you’ll see the final plan here."
            : "⚠️ No valid itinerary was produced in this attempt. Retry or adjust conditions; when it works, you’ll see the final plan here.",
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

  // if it comes in a single line without line breaks but has both labels, try forcing split with common separators
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

LANGUAGE (CRITICAL, TRUE MULTI-LANGUAGE):
- ALWAYS respond in the REAL language in which the user wrote their information (any language).
- In Planner, the user's message may include template/system labels (for example: "Preferences", "Restrictions", "Start time", etc.).
  Those labels must NOT determine the output language.
- Determine the target language from the content written by the user (their phrases, restrictions, tastes, conditions, etc.) and use it throughout the JSON.
- If the user mixes languages:
  • Prioritize the dominant language of the user's written content.
  • If there is no clear dominant language, use the language of the user's last paragraph/entry.
- Do NOT translate into the site/system language unless the user explicitly asks for translation.

CONTEXT USAGE (CRITICAL):
- You must use ALL information provided by the user in the Planner tab.
- ESPECIALLY: Preferences / Restrictions / Special conditions (apply them in every decision: pace, schedules, mobility, budget, meals, accessibility, interests, safety, etc.).
- If the user provides traveler info (ages, kids, seniors, mobility, interests), actively incorporate it into: schedules, breaks, block durations, transport, activity types, and notes.
- If there is a conflict between preferences (for example, “no walking” but “hiking tour”), prioritize safety/feasibility and offer an equivalent alternative.
- If a critical detail is missing to satisfy a restriction, assume the minimum and reflect the condition in notes (e.g., "Confirm hours/tickets") without breaking the itinerary.

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
- Local times must be realistic; if the user doesn't provide hours, decide as an expert.
- Times must be ordered and NOT overlap.
- from/to/transport: NEVER empty.
- Do NOT return "seed" or empty notes.

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
- duration: EXACTLY 2 lines with \\n:
  "Transport: <realistic estimate or ~range>"
  "Activity: <realistic estimate or ~range>"
  FORBIDDEN: "Transport: 0m" or "Activity: 0m"
- notes: required (>=20 chars), motivating and useful:
  1) 1 emotional sentence (Admire/Discover/Feel…)
  2) 1 logistical tip (best time, reservations, tickets, view, etc.)
  + condition/alternative if applicable
  + (when relevant) add "Related: <nearby spot/logical pair>" to avoid missing key paired highlights
    • Example: "Buda Castle" -> Related: "Fisherman’s Bastion"

MEALS (Flexible rule):
- NOT mandatory.
- Include ONLY if they add real value to the flow.
- If included, NOT generic ("dinner at a local restaurant" forbidden).

HOURS / CLOSURES (GLOBAL, anti-impossible schedules):
- For places with typical hours (museums, castles, indoor monuments, baths/spas, markets), do NOT schedule visits outside a reasonable daytime window.
  Guideline if not 100% sure: 10:00–17:00 for indoor/museums.
- If the place may be closed on certain days (e.g., Mondays) and you are not sure, avoid extreme times and add in notes: "Exact hours to confirm (may be closed some days)".
- For viewpoints/bridges/outdoor areas, you can be more flexible.

NIGHT TOURS (GLOBAL, when applicable):
- If the destination has an iconic night highlight or classic night experience, include AT LEAST 1 iconic night activity:
  • Examples: "Danube – Night cruise (Parliament lights)" / "Nile – Cruise with show" / panoramic night viewpoint.
- Keep realistic times (e.g., 19:00–23:30) and include a logistical tip in notes.

AURORAS (Flexible rule + strong negative):
- ONLY suggest auroras if they are plausible by latitude/season.
  Guideline: typically seen at higher latitudes (approx. 60–75°) in common auroral zones.
- If the destination is NOT high latitude or NOT a typical auroral zone, do NOT suggest them (e.g., Budapest / Cairo / Madrid / Rome / etc.).
- If plausible: avoid consecutive days if possible; avoid the last day; typical local night hours.
- Notes must include: "valid:" + (weather/cloudiness) + a nearby low-cost alternative.

DAY TRIPS / MACRO-TOURS:
- If you create a day trip, you must break it down into 5–8 sub-stops (rows).
- Always close with a dedicated return row:
  • Use the macro-tour "DESTINATION": "<Macro-tour> – Return to {Base city}".
- Avoid the last day if there are options.
- For day trips, avoid optimistic timing: return from the LAST point must be realistic/conservative.

SAFETY / GLOBAL COHERENCE:
- Do not propose things that are infeasible due to distance/time/season or obvious risks.
- Prioritize plausible, safe, and reasonable options.

SMART EDITING:
- If the user asks to add/remove/adjust schedules, return updated JSON that remains consistent.
- By default, preserve the itinerary's global coherence.

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
      const raw = await callStructured(
        [{ role: "system", content: SYSTEM_PROMPT_INFO }, ...clientMessages],
        0.45,
        2600,
        70000
      );
      const text = raw || "⚠️ No response was obtained from the assistant.";
      return res.status(200).json({ text });
    }

    // 🧭 PLANNER MODE — with strong v52.5 rules (only via prompt + guardrails)
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], 0.28, 3200, 90000);
    let parsed = cleanToJSON(raw);

    // 1) Retry: strict (if it doesn't parse or doesn't include city_day/rows/destinations)
    const hasSome = parsed && (Array.isArray(parsed.city_day) || Array.isArray(parsed.rows) || Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `

MANDATORY:
- Respond with valid JSON only.
- Must include city_day (preferred) or rows (legacy) with at least 1 row.
- No meta or text outside.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.22, 3400, 95000);
      parsed = cleanToJSON(raw);
    }

    // 2) Retry: ultra with minimal example (only if still failing)
    const stillBad = !parsed || (!Array.isArray(parsed.city_day) && !Array.isArray(parsed.rows) && !Array.isArray(parsed.destinations));

    if (stillBad) {
      const ultraPrompt =
        SYSTEM_PROMPT +
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
      return res.status(200).json({ text: JSON.stringify(fallbackJSON("es")) });
    }
  }
}
