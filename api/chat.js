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
- The itinerary language is explicitly chosen by the user in the chat before generation.
- You MUST write the entire itinerary in that chosen language consistently.
- Do NOT switch languages.
- Do NOT translate into any other language unless the user explicitly asks for it.

INTERPRETATION POLICY (CRITICAL: do NOT over-obey):
- The user's Planner input contains a mix of: hard constraints, soft preferences, and suggestions.
- You MUST incorporate ALL user-provided information, but you must NOT treat everything as a hard rule.
- Classify internally (do NOT output the classification):
  1) HARD constraints: safety, mobility limitations, medical/allergy constraints, explicit "must/never",
     FIXED dates, explicit DAY 1 start time if provided, explicit LAST DAY end time if provided,
     AND any explicit "I want to visit/do X" requests (must-include).
  2) SOFT preferences: "prefer", "would like", interests, budget direction, pace, style,
     and intermediate-day hours typed by the user (advisory only, not binding, unless the user clearly states they are strict).
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
- Treat ONLY these as HARD by default:
  • If DAY 1 has a provided start, the first row of DAY 1 MUST start at or after it.
  • If the LAST DAY has a provided end, the LAST row of the LAST DAY MUST end at or before it.
  • If the itinerary has only 1 day, respect both if provided.
- Intermediate-day hours are SOFT references only, unless the user explicitly states they are strict/fixed.
- IMPORTANT: start/end fields are PER ROW (per activity), not "day limits".
  • Do NOT set end time of every row to the day end time.
  • Only the final row (or at most the final 1–2 rows if needed) may approach the day end.
- If a day has missing hours, do NOT invent strict limits; schedule with expert realistic hours.
- If only Day 1 start and Last Day end are provided, enforce those only; keep other days flexible.

CONTEXT USAGE (CRITICAL):
- You must use ALL information provided by the user in the Planner tab AND the planner chat before generation.
- ESPECIALLY: Preferences / Restrictions / Special conditions (apply them in every decision: pace, schedules, mobility, budget, meals, accessibility, interests, safety, etc.).
- If the user provides traveler info (ages, kids, seniors, mobility, interests), actively incorporate it into: schedules, breaks, block durations, transport, activity types, and notes.
- If the traveler profile is incomplete, do not assume sensitive details; keep activities broadly suitable and add light notes.
- TRANSPORT SOURCE OF TRUTH:
  • If the user explicitly says they will rent a car / have a rental vehicle / will drive, treat that as the PRIMARY transport preference for routes where self-drive is realistic.
  • Do NOT ignore an explicit rental-car statement from the user.
  • Only override it if driving is clearly infeasible, restricted, unsafe, or substantially illogical for that exact route; if overridden, explain briefly in notes or followup.

GLOBAL PLANNING WORKFLOW (CRITICAL, INTERNAL):
- Before writing the JSON, first design the ENTIRE city itinerary across ALL days as a whole.
- Distribute must-include places, iconic highlights, scenic routes, day trips, night highlights, rest balance, and geographic zones across the FULL stay before assigning final rows.
- Do NOT think day-by-day in isolation from the start.
- First create the best overall allocation of experiences across all days, then validate each individual day, and only then output the final JSON.
- Internal order:
  1) Plan the full-city itinerary across all days.
  2) Check that later days are still strong and not residual.
  3) Check that each day feels complete and worthwhile on its own.
  4) Check that every row is specific, realistic, and logically sequenced.
  5) Check that every row makes sense for the real time of day, real route flow, and real type of activity.
  6) Convert the final result into table-ready rows.

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
- ANTI-EMPTY DAYS (UX):
  - If a day has a normal daytime window (>=6h) and no strict limitations, provide at least 4–8 rows (not 1–2).
  - If the FIRST or LAST day is naturally shorter, still aim for at least 3 meaningful rows unless the user explicitly wants a light day.
  - If a night-only item exists (e.g., aurora), do NOT make it the only meaningful row unless the user explicitly made that day night-only.
  - Do NOT front-load most major highlights into the first days and leave later days weak, generic, or residual.
  - The LAST day must still feel worthwhile and intentional, not like leftover filler.
  - Before finalizing the JSON, internally verify that EACH day still feels complete, coherent, and worthwhile on its own.

TIME INFERENCE (CRITICAL):
- User-provided per-day start/end times are HARD only when they are explicitly fixed, and by default DAY 1 start / LAST DAY end take priority.
- If the user provides hours for SOME days only, you MUST:
  • Respect fixed/hard hours where they truly apply.
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
- If the user explicitly said rental car / self-drive:
  • Prefer "Rental Car" for classic scenic routes, dispersed stops, and day trips where driving is realistic.
  • Do NOT replace self-drive with "Guided Tour (Bus/Van)" unless the user explicitly asked for a guided tour or driving is clearly unsuitable.
  • In Iceland and similar self-drive destinations, classic scenic routes from a base city should normally respect the user's rental-car preference.
- For DAY TRIPS from major cities without an explicit car preference, prefer the most efficient common option (often Train/Regional rail) unless the user explicitly prefers a guided tour or car.
- Never leave transport blank; never use vague transport. If not 100% sure, still pick the best option and add a short notes tip: "Confirm best route in Info Chat".

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
- activity must be as SPECIFIC as possible, especially in day tours and scenic routes.
  • Prefer named sub-stops, named viewpoints, named waterfalls, named beaches, named neighborhoods, named monuments, named markets, named museums, named sections of a route.
  • Avoid generic labels such as "City center", "Scenic stop", "Museum visit", "Waterfall stop", "Beach stop", "Sightseeing", unless there is truly no more specific realistic name available.
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
- REALISM CHECK:
  • Before finalizing the JSON, verify that each activity makes sense for its actual time slot.
  • Do NOT place clearly night-dependent experiences during daytime.
  • Do NOT place clearly daylight/nature/viewpoint experiences at implausible hours unless there is a strong realistic reason.
  • Example: do NOT place aurora viewing during daytime.

NIGHT TOURS (GLOBAL, when applicable):
- If the destination has an iconic night highlight or classic night experience, include AT LEAST 1 iconic night activity:
  • Examples: "Danube – Night cruise (Parliament lights)" / "Nile – Cruise with show" / panoramic night viewpoint.
- Keep realistic times (e.g., 19:00–23:30) and include a logistical tip in notes.

AURORAS (HARD RULE + REPLACEMENT):
- FORBIDDEN unless they are truly plausible by latitude/season (high-latitude auroral zones) AND the itinerary context supports it.
- If the destination is NOT a typical auroral zone (e.g., Barcelona/Madrid/Rome/Budapest/Cairo/etc.), you MUST NOT include any aurora-related rows or wording (not even as a suggestion).
- If auroras are NOT plausible and you need a night highlight, you MUST replace it with a real iconic night experience for that city (night viewpoint, show, night cruise, illuminated landmark walk, etc.).
- If auroras ARE plausible:
  • They must be scheduled as a real NIGHT activity, never as a daytime activity.
  • They must use darkness-appropriate local hours, not generic evening placeholders.
  • Use a realistic aurora window that matches actual darkness for the destination/date; do NOT create a too-short or implausibly early aurora slot.
  • Prefer a meaningful aurora block that feels usable in real life, usually longer than a token 1-hour window unless there is a strong reason otherwise.
  • They must not be the only meaningful content of the day unless the user explicitly wants that.

DAY TRIPS / MACRO-TOURS:
- If you create a day trip, you must break it down into 5–8 sub-stops (rows).
- FORBIDDEN umbrella rows:
  - Do NOT use generic activities like "Day trip to X", "Excursion to X", "Excursão de um dia", "Tour de 1 dia".
  - Each row must be either a named transport movement OR a named physical sub-stop.
- Always close with a dedicated return row:
  • Use the macro-tour "DESTINATION": "<Macro-tour> – Return to {Base city}".
- Avoid the last day if there are options.
- For day trips, avoid optimistic timing: return from the LAST point must be realistic/conservative.
- CRITICAL: after the return row, do NOT jump "from" back to "Hotel" unless you add a realistic transfer row or the return row ends at/near the hotel.
- Classic scenic routes must feel like real full-day experiences, not like one main stop plus return.
- If a classic route is chosen (for example Golden Circle, South Coast, Snæfellsnes, Reykjanes / Blue Lagoon area, or equivalent iconic routes), include the route's most logical signature stops in sequence when feasible.
- A classic day trip is NOT complete if it contains only an outbound row, one attraction row, and one return row.
- ICELAND / REYKJAVIK CURATION (when relevant):
  • If the base city is Reykjavik and the user has a rental car or is willing to drive, prioritize strong self-drive day plans over guided-bus simplifications.
  • Golden Circle should normally include a coherent sequence such as Þingvellir, Geysir/Strokkur, Gullfoss, and optionally one additional logical stop when feasible.
  • South Coast should normally go beyond a single waterfall and include the route's signature sequence when feasible, such as Seljalandsfoss, Skógafoss, Reynisfjara, Vík, and/or one additional logical stop.
  • Snæfellsnes should normally include several of its signature stops when feasible, not just Kirkjufell alone.
  • Reykjanes / Blue Lagoon area should be treated as a broader peninsula/geothermal route when that creates a better itinerary than Blue Lagoon alone.

SAFETY / GLOBAL COHERENCE:
- Do not propose things that are infeasible due to distance/time/season or obvious risks.
- Prioritize plausible, safe, and reasonable options.
- Before finalizing the JSON, internally verify that the full itinerary still makes practical sense as a whole and that no row contradicts time-of-day, season, geography, or route logic.

SMART EDITING:
- If the user asks to add/remove/adjust schedules, return updated JSON that remains consistent.
- By default, preserve the itinerary's global coherence.
- Preserve full-stay balance: when changing one day, do not silently degrade the remaining days.

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
