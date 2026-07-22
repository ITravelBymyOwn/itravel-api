// /api/chat.js — ITBMO v60 — staged MVP architecture for Webflow + Vercel
// External contract preserved:
//   Request:  { mode, input/history/messages }
//   Response: { text: "<string>" }
// - mode="info" returns conversational free text.
// - planner mode returns JSON serialized inside "text".
// - ESM compatible.
// - Uses OPENAI_MODEL (default gpt-5-mini).
// - No web, maps, weather, prices or live availability.
//
// Recommended Vercel environment variables:
//   OPENAI_API_KEY=...
//   OPENAI_MODEL=gpt-5-mini
// Optional:
//   ITBMO_MAX_REPAIRS=2
//   ITBMO_DAY_CHUNK_SIZE=2
//   ITBMO_TIMEOUT_MS=120000
//   ITBMO_LOG_LEVEL=info

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const MAX_REPAIRS = clampInt(process.env.ITBMO_MAX_REPAIRS, 0, 3, 2);
const DAY_CHUNK_SIZE = clampInt(process.env.ITBMO_DAY_CHUNK_SIZE, 1, 3, 2);
const REQUEST_TIMEOUT_MS = clampInt(process.env.ITBMO_TIMEOUT_MS, 30000, 240000, 120000);
const LOG_LEVEL = String(process.env.ITBMO_LOG_LEVEL || "info").toLowerCase();

const GENERIC_ACTIVITY_PATTERNS = [
  /\b(local|urban|general)\s+(culture|route|experience)\b/i,
  /\b(cultura|rota|ruta)\s+(local|urbana|general)\b/i,
  /\bfree\s+day\b/i,
  /\bd[ií]a\s+libre\b/i,
  /\btempo\s+livre\b/i,
  /\bitinerary\s+pending\b/i,
  /\bfallback\b/i,
  /\bplaceholder\b/i,
];

const CONTAMINATION_PATTERNS = [
  /\brecommend\s*me\b/i,
  /\brecommended\s+by\s+(the\s+)?planner\b/i,
  /\bas\s+appropriate\b/i,
  /\bclose\s+to\b/i,
  /\bin\s+[A-ZÁÉÍÓÚÀÂÃÇÊÔÕÜ][^,]{1,50},\s*recommend\s*me\b/i,
];

const DAY_TRIP_HINTS = [
  "day trip", "excursion", "regional route", "macro route", "road trip",
  "tour", "circle", "coast", "peninsula", "valley", "island", "mountain",
  "viagem de um dia", "excursão", "rota regional", "circuito",
  "excursión", "ruta regional", "circuito", "costa", "península",
];

const RETURN_HINTS = [
  "return", "back to", "regresso", "retorno", "volta", "regreso",
  "hotel", "base city", "cidade base", "ciudad base",
];

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function nowMs() {
  return Date.now();
}

function log(level, event, data = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((levels[level] || 20) < (levels[LOG_LEVEL] || 20)) return;
  const safe = {
    event,
    model: MODEL,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const line = `[ITBMO] ${JSON.stringify(safe)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’'"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeString(value, fallback = "") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function splitIntoChunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniqueBy(items, getKey) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = getKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function extractMessages(body = {}) {
  const { messages, input, history } = body || {};
  if (Array.isArray(messages) && messages.length) {
    return messages
      .filter((m) => m && typeof m === "object")
      .map((m) => ({
        role: ["system", "developer", "assistant", "user"].includes(String(m.role))
          ? String(m.role)
          : "user",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      }));
  }

  const prev = Array.isArray(history)
    ? history
        .filter((m) => m && typeof m === "object")
        .map((m) => ({
          role: ["system", "developer", "assistant", "user"].includes(String(m.role))
            ? String(m.role)
            : "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        }))
    : [];

  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (String(messages[i]?.role || "").toLowerCase() === "user") {
      return String(messages[i]?.content || "");
    }
  }
  return "";
}

function allUserText(messages = []) {
  return messages
    .filter((m) => String(m?.role || "").toLowerCase() === "user")
    .map((m) => String(m?.content || ""))
    .join("\n\n");
}

function detectLanguageOverride(messages = [], body = {}) {
  const structured = safeString(
    body?.language ||
      body?.planner_request?.language ||
      body?.request?.language ||
      body?.metadata?.language
  ).toLowerCase();

  const aliases = {
    en: ["en", "eng", "english", "ingles", "inglés", "anglais"],
    es: ["es", "spa", "spanish", "espanol", "español", "castellano"],
    pt: ["pt", "por", "portuguese", "portugues", "português"],
    fr: ["fr", "fre", "french", "francais", "français"],
    de: ["de", "ger", "german", "deutsch", "aleman", "alemán"],
    it: ["it", "ita", "italian", "italiano"],
  };

  for (const [code, names] of Object.entries(aliases)) {
    if (names.includes(structured)) return code;
  }

  const raw = lastUserText(messages).trim();
  if (!raw) return null;
  const cleaned = normalizeKey(raw);
  const tokens = cleaned.split(" ").filter(Boolean);
  if (cleaned.length > 32 || tokens.length > 3) return null;

  for (const [code, names] of Object.entries(aliases)) {
    const normalizedNames = names.map(normalizeKey);
    if (tokens.some((t) => normalizedNames.includes(t)) || normalizedNames.includes(cleaned)) {
      return code;
    }
  }

  return null;
}

function detectUserLang(messages = []) {
  const text = allUserText(messages);
  if (!text.trim()) return "en";

  const s = text.toLowerCase();
  if (/[¿¡ñ]/.test(text)) return "es";
  if (/[ãõç]/i.test(text)) return "pt";

  const scores = {
    es: (s.match(/\b(el|la|los|las|de|que|para|con|por|una|como|donde|qué|cuál|cómo)\b/g) || []).length,
    en: (s.match(/\b(the|and|for|with|to|from|what|which|how|where|when|please)\b/g) || []).length,
    pt: (s.match(/\b(o|a|os|as|de|que|para|com|sem|onde|qual|quais|obrigado)\b/g) || []).length,
    fr: (s.match(/\b(le|la|les|des|du|et|pour|avec|sans|où|quel|quelle|vous)\b/g) || []).length,
    de: (s.match(/\b(der|die|das|und|für|mit|ohne|wo|was|bitte|danke)\b/g) || []).length,
    it: (s.match(/\b(il|lo|la|gli|della|che|per|con|senza|dove|quale|grazie)\b/g) || []).length,
  };

  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[1] > 0
    ? Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]
    : "en";
}

function getOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts = [];
  for (const item of safeArray(response?.output)) {
    for (const content of safeArray(item?.content)) {
      if (typeof content?.text === "string") parts.push(content.text);
      if (typeof content?.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("").trim();
}

function cleanToJSON(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function makeAbortController(timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(timer) };
}

function classifyOpenAIError(error, stage) {
  const status = Number(error?.status || error?.response?.status || 0);
  const name = String(error?.name || "");
  const message = safeString(error?.message, "Unknown model error");

  if (name === "AbortError" || /aborted|timeout/i.test(message)) {
    return { code: "TIMEOUT", message, retryable: true, stage };
  }
  if (status === 429 || /rate.?limit/i.test(message)) {
    return { code: "RATE_LIMIT", message, retryable: true, stage };
  }
  if (status >= 500) {
    return { code: "MODEL_ERROR", message, retryable: true, stage };
  }
  return { code: "MODEL_ERROR", message, retryable: false, stage };
}

// -----------------------------------------------------------------------------
// OpenAI calls
// -----------------------------------------------------------------------------

async function callText({ instructions, messages, maxOutputTokens = 2500, stage = "info" }) {
  const started = nowMs();
  const { controller, clear } = makeAbortController();

  try {
    const response = await client.responses.create(
      {
        model: MODEL,
        instructions,
        input: messages,
        max_output_tokens: maxOutputTokens,
      },
      { signal: controller.signal }
    );

    const text = getOutputText(response);
    log("info", "model_call", {
      stage,
      ms: nowMs() - started,
      status: response?.status,
      output_chars: text.length,
      usage: response?.usage,
      incomplete_details: response?.incomplete_details || null,
    });

    if (response?.status === "incomplete") {
      const e = new Error("Model output was incomplete.");
      e.itbmo = {
        code: "INCOMPLETE_OUTPUT",
        message: "The model did not finish the response.",
        retryable: true,
        stage,
        incomplete_details: response?.incomplete_details || null,
      };
      throw e;
    }

    if (!text) {
      const e = new Error("Model returned an empty response.");
      e.itbmo = {
        code: "INCOMPLETE_OUTPUT",
        message: "The model returned an empty response.",
        retryable: true,
        stage,
      };
      throw e;
    }

    return text;
  } catch (error) {
    if (!error?.itbmo) error.itbmo = classifyOpenAIError(error, stage);
    log("error", "model_call_failed", {
      stage,
      ms: nowMs() - started,
      error: error.itbmo,
    });
    throw error;
  } finally {
    clear();
  }
}

async function callJSON({
  instructions,
  messages,
  schemaName,
  schema,
  maxOutputTokens = 6000,
  stage,
}) {
  const started = nowMs();
  const { controller, clear } = makeAbortController();

  try {
    const response = await client.responses.create(
      {
        model: MODEL,
        instructions,
        input: messages,
        max_output_tokens: maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema,
          },
        },
      },
      { signal: controller.signal }
    );

    const raw = getOutputText(response);
    log("info", "model_call", {
      stage,
      ms: nowMs() - started,
      status: response?.status,
      output_chars: raw.length,
      usage: response?.usage,
      incomplete_details: response?.incomplete_details || null,
    });

    if (response?.status === "incomplete") {
      const e = new Error("Structured output was incomplete.");
      e.itbmo = {
        code: "INCOMPLETE_OUTPUT",
        message: "The model did not finish the structured response.",
        retryable: true,
        stage,
        incomplete_details: response?.incomplete_details || null,
      };
      throw e;
    }

    const parsed = cleanToJSON(raw);
    if (!parsed) {
      const e = new Error("Structured output could not be parsed.");
      e.itbmo = {
        code: "SCHEMA_ERROR",
        message: "The model response was not valid JSON.",
        retryable: true,
        stage,
      };
      throw e;
    }
    return parsed;
  } catch (error) {
    if (!error?.itbmo) error.itbmo = classifyOpenAIError(error, stage);
    log("error", "model_call_failed", {
      stage,
      ms: nowMs() - started,
      error: error.itbmo,
    });
    throw error;
  } finally {
    clear();
  }
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const STRATEGY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["normalized_request", "candidate_inventory", "master_plan"],
  properties: {
    normalized_request: {
      type: "object",
      additionalProperties: false,
      required: [
        "destination",
        "days_total",
        "language",
        "travelers",
        "constraints",
        "daily_windows",
        "transport_preferences",
      ],
      properties: {
        destination: {
          type: "object",
          additionalProperties: false,
          required: ["country", "base_city", "display_name"],
          properties: {
            country: { type: "string" },
            base_city: { type: "string" },
            display_name: { type: "string" },
          },
        },
        days_total: { type: "integer", minimum: 1, maximum: 30 },
        language: { type: "string" },
        travelers: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "count", "ages", "notes"],
            properties: {
              type: { type: "string" },
              count: { type: "integer", minimum: 0, maximum: 50 },
              ages: { type: "array", items: { type: "integer", minimum: 0, maximum: 120 } },
              notes: { type: "string" },
            },
          },
        },
        constraints: {
          type: "object",
          additionalProperties: false,
          required: ["hard", "soft", "must_include", "must_avoid"],
          properties: {
            hard: { type: "array", items: { type: "string" } },
            soft: { type: "array", items: { type: "string" } },
            must_include: { type: "array", items: { type: "string" } },
            must_avoid: { type: "array", items: { type: "string" } },
          },
        },
        daily_windows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["day", "start", "end"],
            properties: {
              day: { type: "integer", minimum: 1, maximum: 30 },
              start: { type: "string" },
              end: { type: "string" },
            },
          },
        },
        transport_preferences: { type: "array", items: { type: "string" } },
      },
    },
    candidate_inventory: {
      type: "object",
      additionalProperties: false,
      required: ["destination_type", "season", "trip_style", "candidates"],
      properties: {
        destination_type: {
          type: "string",
          enum: [
            "dense_city",
            "gateway_outward_base",
            "hybrid_city_and_region",
            "island_beach_relax",
            "nature_adventure_base",
            "roadtrip_multi_base",
          ],
        },
        season: { type: "string" },
        trip_style: { type: "string" },
        candidates: {
          type: "array",
          minItems: 4,
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "name",
              "type",
              "corridor",
              "estimated_hours",
              "score",
              "must_include",
              "conflicts",
            ],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              type: { type: "string" },
              corridor: { type: "string" },
              estimated_hours: { type: "number", minimum: 0, maximum: 24 },
              score: { type: "integer", minimum: 0, maximum: 100 },
              must_include: { type: "boolean" },
              conflicts: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    master_plan: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "day",
          "identity",
          "bucket_id",
          "region",
          "corridor",
          "intensity",
          "day_type",
          "estimated_start",
          "estimated_end",
          "must_include_targets",
        ],
        properties: {
          day: { type: "integer", minimum: 1, maximum: 30 },
          identity: { type: "string" },
          bucket_id: { type: "string" },
          region: { type: "string" },
          corridor: { type: "string" },
          intensity: { type: "string", enum: ["light", "moderate", "full"] },
          day_type: {
            type: "string",
            enum: [
              "short_arrival",
              "full_urban",
              "regional_excursion",
              "complex_macro_route",
              "early_departure",
              "requested_rest",
            ],
          },
          estimated_start: { type: "string" },
          estimated_end: { type: "string" },
          must_include_targets: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const ROW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "day",
    "start",
    "end",
    "activity",
    "from",
    "to",
    "transport",
    "duration",
    "notes",
    "kind",
    "zone",
  ],
  properties: {
    day: { type: "integer", minimum: 1, maximum: 30 },
    start: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    end: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
    activity: { type: "string", minLength: 5 },
    from: { type: "string", minLength: 1 },
    to: { type: "string", minLength: 1 },
    transport: { type: "string", minLength: 1 },
    duration: { type: "string", minLength: 10 },
    notes: { type: "string", minLength: 20 },
    kind: { type: "string" },
    zone: { type: "string" },
  },
};

const DAY_BLOCKS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["city_day"],
  properties: {
    city_day: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["city", "day", "rows"],
        properties: {
          city: { type: "string", minLength: 1 },
          day: { type: "integer", minimum: 1, maximum: 30 },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: ROW_SCHEMA,
          },
        },
      },
    },
  },
};

const REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["city_day"],
  properties: {
    city_day: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["city", "day", "rows"],
        properties: {
          city: { type: "string", minLength: 1 },
          day: { type: "integer", minimum: 1, maximum: 30 },
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: ROW_SCHEMA,
          },
        },
      },
    },
  },
};

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

const INFO_PROMPT = `
You are Astra, the conversational assistant of ITravelByMyOwn.
Respond naturally and helpfully in the user's selected or dominant language.
Use the full conversation context.
You may answer any lawful topic, not only travel.
Do not claim live access to web, maps, traffic, schedules, prices, weather or availability.
When current confirmation is material, say it should be verified.
`;

const STRATEGY_PROMPT = `
You are Astra, the travel-strategy engine of ITBMO.

MISSION
Convert the user's Planner content into:
1) a normalized request,
2) a radial candidate inventory,
3) a complete Master Day Plan.

Do not generate final itinerary rows in this stage.

PRIORITY ORDER
Safety and hard restrictions > fixed dates and time windows > explicit must-includes >
geographic coherence > traveler fit > user preferences > diversity > descriptive detail.

NORMALIZATION
- Use every relevant detail from the Planner.
- Separate hard constraints, soft preferences, must-includes and must-avoid items.
- Any explicitly requested named place or activity is a must-include, including names written
  inside Special Conditions.
- Never copy interface instructions such as "recommend me", "close to", "as appropriate",
  "recommended by planner", or transport-choice labels into geographic fields.
- Use the explicit output-language selection supplied in the context as the source of truth.

RADIAL EXPLORATION
- Consider the core city, distinct districts, outward corridors, regional day trips, nature,
  culture, gastronomy, wellness, wildlife/marine, iconic night experiences, season fit,
  traveler ages, mobility and realistic transport.
- Rank strong iconic and distinctive buckets before weak filler.
- A candidate score must reflect iconicity, traveler fit, logistics, season and diversity.

MASTER DAY PLAN
- Return exactly days_total day plans, numbered consecutively from 1.
- Give every day a unique identity, bucket and corridor.
- Respect provided day-specific time windows.
- For gateway destinations and long stays, use strong regional/special buckets before adding
  repeated city filler.
- Do not repeat the same region, macro-route, neighborhood, rhythm or emotional shape when
  a strong unused alternative exists.
- Assign every feasible must-include to one or more specific days.
- Arrival/departure and expressly requested rest days may be lighter.
- Keep uncertainty honest because no live web or maps are available.
`;

const DAY_GENERATION_PROMPT = `
You are Astra, the itinerary-production engine of ITBMO.

Generate only the requested day blocks, but use the complete normalized request, candidate
inventory, Master Day Plan and already-generated days as global context.

NON-NEGOTIABLE RULES
- Output only the day blocks requested.
- Use exactly one user-facing language, supplied in the context.
- Preserve all requested days and all assigned must-includes.
- Each day must follow its Master Day Plan identity, region, corridor, intensity and day type.
- Never repeat a POI already used on another day unless the user explicitly requested repetition.
- Never reuse the same macro-route/corridor under a translated, abbreviated or paraphrased name.
- Do not create generic filler when a stronger unused candidate exists.

ROW CONTRACT
- Each row has HH:MM start/end, ordered without overlap.
- activity must be "DESTINATION – SUB-STOP".
- from, to and transport must be concrete and non-empty.
- Never put "recommend me", "close to", "as appropriate", a transport preference or Planner
  instruction inside from/to.
- Continuity: the next row's from should normally match or plausibly continue from the previous
  row's to.
- duration must contain exactly two lines:
  Transport: <estimate>
  Activity: <estimate>
- Duration display: under 1 hour use minutes; 1 hour or more use hours/minutes.
- Never use 0m.
- Notes should normally be 25–55 words, useful and motivating, with a logistical confirmation
  note only when uncertainty is material.
- Indoor attractions should normally be scheduled in plausible daytime hours.
- Meals are optional and must be a named venue or a concrete recognized dining area.

DENSITY TARGETS
- short_arrival: 2–5 rows
- full_urban: 5–9 rows
- regional_excursion: 6–10 rows
- complex_macro_route: 7–12 rows
- early_departure: 1–4 rows
- requested_rest: 2–5 rows
Use the lower end when the available window is short or traveler restrictions demand it.

DAY TRIPS
- Use real corridor sub-stops as rows, not only in notes.
- Avoid giant dead gaps.
- Finish with an explicit return row to the base/hotel unless the trip is multi-base and the
  Master Plan explicitly ends elsewhere.

AURORA
- Include only in a plausible high-latitude season.
- Never guarantee visibility.
- It must be a real night row, not only a note.
- Otherwise use an iconic night experience appropriate to the destination.

OUTPUT BUDGET
Complete coverage has priority over prose. Shorten notes before omitting rows, days,
must-includes, required returns or mandatory fields.
`;

const REPAIR_PROMPT = `
You are Astra, the surgical itinerary-repair engine of ITBMO.

Repair only the days supplied in the repair context.
The validation errors are authoritative.
Return complete replacement blocks for every affected day, not patches and not explanations.

Preserve:
- the normalized request,
- Master Day Plan identity and corridor,
- valid rows that do not need to change,
- assigned must-includes,
- the single selected language,
- continuity with surrounding days.

Correct all reported schema and business-rule errors. Do not introduce new duplicates,
generic activities, time overlaps, missing returns, field contamination or language mixing.
`;

function contextMessage(label, value) {
  return {
    role: "user",
    content: `${label}\n${JSON.stringify(value)}`,
  };
}

// -----------------------------------------------------------------------------
// Normalization and deterministic post-processing
// -----------------------------------------------------------------------------

function parseTime(value) {
  const m = String(value || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatMinutesAsDuration(minutes) {
  const n = Math.max(1, Math.round(Number(minutes) || 1));
  if (n < 60) return `~${n}m`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
}

function inferActivityMinutes(row) {
  const start = parseTime(row?.start);
  const end = parseTime(row?.end);
  if (start == null || end == null || end <= start) return 45;
  return end - start;
}

function extractDurationPart(text, label) {
  const re = new RegExp(`${label}\\s*:\\s*([^\\n|;]+)`, "i");
  return safeString(String(text || "").match(re)?.[1]);
}

function durationTextToMinutes(text) {
  const s = normalizeKey(text);
  if (!s) return null;

  let total = 0;
  const hourMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|hora|horas)/);
  const minuteMatch = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes|minuto|minutos)/);
  if (hourMatch) total += Math.round(Number(hourMatch[1]) * 60);
  if (minuteMatch) total += Number(minuteMatch[1]);

  if (!hourMatch && !minuteMatch) {
    const range = s.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (range) total = Math.round((Number(range[1]) + Number(range[2])) / 2);
    else {
      const single = s.match(/\b(\d+)\b/);
      if (single) total = Number(single[1]);
    }
  }
  return total > 0 ? total : null;
}

function normalizeDuration(row) {
  const raw = String(row?.duration || "");
  const transportRaw = extractDurationPart(raw, "Transport(?:e)?");
  const activityRaw = extractDurationPart(raw, "Activ(?:ity|idade|idad|ité|itaet|ität)");

  const transportMinutes = durationTextToMinutes(transportRaw) || 10;
  const activityMinutes = durationTextToMinutes(activityRaw) || inferActivityMinutes(row);

  return `Transport: ${formatMinutesAsDuration(transportMinutes)}\nActivity: ${formatMinutesAsDuration(activityMinutes)}`;
}

function cleanLocationField(value) {
  let s = normalizeWhitespace(value);
  for (const pattern of CONTAMINATION_PATTERNS) s = s.replace(pattern, "").trim();
  s = s.replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "").trim();
  return s;
}

function normalizeRow(row, blockDay, previousTo = "") {
  const day = Number(row?.day) || Number(blockDay) || 1;
  const start = safeString(row?.start, "09:00");
  const end = safeString(row?.end, "10:00");

  const from = cleanLocationField(row?.from) || cleanLocationField(previousTo) || "Hotel";
  const to = cleanLocationField(row?.to) || safeString(row?.activity).split(/\s+[–-]\s+/).pop() || "Destination";

  return {
    day,
    start,
    end,
    activity: normalizeWhitespace(row?.activity),
    from,
    to,
    transport: normalizeWhitespace(row?.transport),
    duration: normalizeDuration({ ...row, start, end }),
    notes: normalizeWhitespace(row?.notes),
    kind: safeString(row?.kind),
    zone: safeString(row?.zone),
  };
}

function normalizeCityDay(cityDay, destinationFallback = "") {
  const blocks = safeArray(cityDay)
    .map((block, index) => {
      const day = Number(block?.day) || index + 1;
      let previousTo = "";
      const rows = safeArray(block?.rows)
        .map((row) => {
          const normalized = normalizeRow(row, day, previousTo);
          previousTo = normalized.to;
          return normalized;
        })
        .sort((a, b) => (parseTime(a.start) ?? 9999) - (parseTime(b.start) ?? 9999));

      return {
        city: safeString(block?.city || block?.destination, destinationFallback),
        day,
        rows,
      };
    })
    .sort((a, b) => a.day - b.day);

  return uniqueBy(blocks, (b) => String(b.day));
}

function adaptLegacyOutput(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;

  if (Array.isArray(parsed.city_day)) {
    parsed.city_day = normalizeCityDay(parsed.city_day, parsed.destination);
    return parsed;
  }

  if (Array.isArray(parsed.rows)) {
    const grouped = new Map();
    for (const row of parsed.rows) {
      const day = Number(row?.day) || 1;
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day).push(row);
    }
    parsed.city_day = [...grouped.entries()].map(([day, rows]) => ({
      city: safeString(parsed.destination, "Destination"),
      day,
      rows,
    }));
    parsed.city_day = normalizeCityDay(parsed.city_day, parsed.destination);
    parsed.days_total = parsed.days_total || parsed.city_day.length;
    return parsed;
  }

  if (Array.isArray(parsed.destinations)) {
    // Preserve legacy multi-destination shape externally while normalizing nested content.
    parsed.destinations = parsed.destinations.map((d) => {
      const name = safeString(d?.name || d?.destination, "Destination");
      if (Array.isArray(d?.city_day)) {
        return { ...d, city_day: normalizeCityDay(d.city_day, name) };
      }
      if (Array.isArray(d?.rows)) {
        const grouped = new Map();
        for (const row of d.rows) {
          const day = Number(row?.day) || 1;
          if (!grouped.has(day)) grouped.set(day, []);
          grouped.get(day).push(row);
        }
        return {
          ...d,
          city_day: normalizeCityDay(
            [...grouped.entries()].map(([day, rows]) => ({ city: name, day, rows })),
            name
          ),
        };
      }
      return d;
    });
  }

  return parsed;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function makeError(code, details = {}) {
  return { code, ...details };
}

function expectedRowRange(dayType) {
  const ranges = {
    short_arrival: [2, 5],
    full_urban: [5, 9],
    regional_excursion: [6, 10],
    complex_macro_route: [7, 12],
    early_departure: [1, 4],
    requested_rest: [2, 5],
  };
  return ranges[dayType] || [4, 10];
}

function validateItinerary(finalItinerary, strategy) {
  const errors = [];
  const cityDay = safeArray(finalItinerary?.city_day);
  const normalized = strategy?.normalized_request || {};
  const masterPlan = safeArray(strategy?.master_plan);
  const expectedDays = Number(normalized?.days_total || finalItinerary?.days_total || masterPlan.length || 1);

  const dayNumbers = cityDay.map((b) => Number(b?.day)).filter(Number.isFinite);
  const daySet = new Set(dayNumbers);

  for (let day = 1; day <= expectedDays; day += 1) {
    if (!daySet.has(day)) errors.push(makeError("MISSING_DAY", { day }));
  }

  const duplicates = dayNumbers.filter((d, i) => dayNumbers.indexOf(d) !== i);
  for (const day of [...new Set(duplicates)]) {
    errors.push(makeError("DAY_UNIQUENESS", { day }));
  }

  const poiUse = new Map();
  const corridorUse = new Map();

  for (const block of cityDay) {
    const day = Number(block?.day) || 0;
    const rows = safeArray(block?.rows);
    const plan = masterPlan.find((p) => Number(p?.day) === day);
    const [minRows, maxRows] = expectedRowRange(plan?.day_type);

    if (rows.length < minRows || rows.length > Math.min(20, maxRows + 2)) {
      errors.push(
        makeError("ROW_COUNT", {
          day,
          actual: rows.length,
          expected_min: minRows,
          expected_max: maxRows,
        })
      );
    }

    let previousEnd = null;
    let previousTo = "";

    rows.forEach((row, index) => {
      const required = ["start", "end", "activity", "from", "to", "transport", "duration", "notes"];
      for (const field of required) {
        if (!safeString(row?.[field])) {
          errors.push(makeError("REQUIRED_FIELDS", { day, row: index + 1, field }));
        }
      }

      const start = parseTime(row?.start);
      const end = parseTime(row?.end);
      if (start == null || end == null || start >= end) {
        errors.push(makeError("TIME_ORDER", { day, row: index + 1, start: row?.start, end: row?.end }));
      }

      if (previousEnd != null && start != null && start < previousEnd) {
        errors.push(makeError("TIME_OVERLAP", { day, rows: [index, index + 1] }));
      }

      if (index > 0 && previousTo) {
        const fromKey = normalizeKey(row?.from);
        const prevKey = normalizeKey(previousTo);
        const compatible =
          fromKey === prevKey ||
          fromKey.includes(prevKey) ||
          prevKey.includes(fromKey) ||
          /hotel|station|airport|porto|puerto|estacao|estación/i.test(`${fromKey} ${prevKey}`);
        if (!compatible) {
          errors.push(
            makeError("CONTINUITY", {
              day,
              row: index + 1,
              expected_from: previousTo,
              actual_from: row?.from,
            })
          );
        }
      }

      const duration = String(row?.duration || "");
      const durationLines = duration.split("\n").filter(Boolean);
      if (
        durationLines.length !== 2 ||
        !/^Transport\s*:/i.test(durationLines[0]) ||
        !/^Activity\s*:/i.test(durationLines[1]) ||
        /\b0m\b/i.test(duration)
      ) {
        errors.push(makeError("DURATION_FORMAT", { day, row: index + 1 }));
      }

      const contaminated = ["from", "to"].find((field) =>
        CONTAMINATION_PATTERNS.some((p) => p.test(String(row?.[field] || "")))
      );
      if (contaminated) {
        errors.push(makeError("FIELD_CONTAMINATION", { day, row: index + 1, field: contaminated }));
      }

      if (GENERIC_ACTIVITY_PATTERNS.some((p) => p.test(String(row?.activity || "")))) {
        errors.push(makeError("GENERIC_ACTIVITY", { day, row: index + 1, activity: row?.activity }));
      }

      if (!/\s+[–-]\s+/.test(String(row?.activity || ""))) {
        errors.push(makeError("ACTIVITY_FORMAT", { day, row: index + 1, activity: row?.activity }));
      }

      const poiKey = normalizeKey(row?.to);
      if (poiKey && poiKey.length >= 4) {
        if (!poiUse.has(poiKey)) poiUse.set(poiKey, []);
        poiUse.get(poiKey).push({ day, row: index + 1 });
      }

      previousEnd = end;
      previousTo = row?.to;
    });

    const corridorKey = normalizeKey(plan?.corridor || plan?.region || "");
    if (corridorKey) {
      if (!corridorUse.has(corridorKey)) corridorUse.set(corridorKey, []);
      corridorUse.get(corridorKey).push(day);
    }

    const planText = normalizeKey(`${plan?.day_type || ""} ${plan?.identity || ""} ${plan?.bucket_id || ""}`);
    const dayText = normalizeKey(rows.map((r) => `${r.activity} ${r.to}`).join(" "));
    const isDayTrip =
      ["regional_excursion", "complex_macro_route"].includes(plan?.day_type) ||
      DAY_TRIP_HINTS.some((hint) => planText.includes(normalizeKey(hint)));

    if (isDayTrip && !RETURN_HINTS.some((hint) => dayText.includes(normalizeKey(hint)))) {
      errors.push(makeError("RETURN_ROW", { day }));
    }

    const window = safeArray(normalized?.daily_windows).find((w) => Number(w?.day) === day);
    if (window && rows.length) {
      const firstStart = parseTime(rows[0]?.start);
      const lastEnd = parseTime(rows[rows.length - 1]?.end);
      const windowStart = parseTime(window?.start);
      const windowEnd = parseTime(window?.end);

      if (windowStart != null && firstStart != null && firstStart < windowStart) {
        errors.push(makeError("TIME_WINDOW_START", { day, required: window.start, actual: rows[0].start }));
      }
      if (windowEnd != null && lastEnd != null && lastEnd > windowEnd) {
        errors.push(makeError("TIME_WINDOW_END", { day, required: window.end, actual: rows[rows.length - 1].end }));
      }
    }
  }

  for (const [poi, uses] of poiUse.entries()) {
    const distinctDays = [...new Set(uses.map((u) => u.day))];
    if (distinctDays.length > 1) {
      errors.push(makeError("DUPLICATE_POI", { poi, uses }));
    }
  }

  for (const [corridor, days] of corridorUse.entries()) {
    const uniqueDays = [...new Set(days)];
    if (uniqueDays.length > 1 && corridor.length > 3) {
      errors.push(makeError("DUPLICATE_CORRIDOR", { corridor, days: uniqueDays }));
    }
  }

  const searchable = normalizeKey(
    cityDay
      .flatMap((b) => b.rows)
      .map((r) => `${r.activity} ${r.to}`)
      .join(" ")
  );

  for (const must of safeArray(normalized?.constraints?.must_include)) {
    const key = normalizeKey(must);
    if (key && !searchable.includes(key)) {
      errors.push(makeError("MUST_INCLUDE_COVERAGE", { must_include: must }));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    affected_days: getAffectedDays(errors, expectedDays),
  };
}

function getAffectedDays(errors, expectedDays) {
  const days = new Set();
  for (const error of errors) {
    if (Number.isFinite(Number(error?.day))) days.add(Number(error.day));
    for (const d of safeArray(error?.days)) {
      if (Number.isFinite(Number(d))) days.add(Number(d));
    }
    for (const use of safeArray(error?.uses)) {
      if (Number.isFinite(Number(use?.day))) days.add(Number(use.day));
    }
  }

  if (!days.size && errors.length) {
    for (let day = 1; day <= expectedDays; day += 1) days.add(day);
  }

  return [...days].sort((a, b) => a - b);
}

// -----------------------------------------------------------------------------
// Planner stages
// -----------------------------------------------------------------------------

function plannerSourcePayload(body, messages, language) {
  return {
    explicit_language: language,
    planner_request: body?.planner_request || body?.request || null,
    raw_user_content: allUserText(messages),
  };
}

async function buildStrategy(body, messages, language) {
  const payload = plannerSourcePayload(body, messages, language);
  return callJSON({
    instructions: STRATEGY_PROMPT,
    messages: [contextMessage("PLANNER SOURCE", payload)],
    schemaName: "itbmo_strategy",
    schema: STRATEGY_SCHEMA,
    maxOutputTokens: 6500,
    stage: "strategy",
  });
}

async function generateDayChunk(strategy, requestedDays, generatedDays) {
  const requestedPlans = safeArray(strategy?.master_plan).filter((plan) =>
    requestedDays.includes(Number(plan?.day))
  );

  const context = {
    normalized_request: strategy.normalized_request,
    candidate_inventory: strategy.candidate_inventory,
    complete_master_plan: strategy.master_plan,
    requested_day_plans: requestedPlans,
    already_generated_days: generatedDays,
  };

  return callJSON({
    instructions: DAY_GENERATION_PROMPT,
    messages: [contextMessage("GENERATION CONTEXT", context)],
    schemaName: "itbmo_day_blocks",
    schema: DAY_BLOCKS_SCHEMA,
    maxOutputTokens: requestedDays.length === 1 ? 5000 : 8500,
    stage: `day_generation_${requestedDays.join("_")}`,
  });
}

function assembleItinerary(strategy, blocks) {
  const destination = safeString(
    strategy?.normalized_request?.destination?.display_name ||
      strategy?.normalized_request?.destination?.base_city,
    "Destination"
  );
  const daysTotal = Number(strategy?.normalized_request?.days_total) || safeArray(blocks).length;

  return {
    destination,
    days_total: daysTotal,
    city_day: normalizeCityDay(blocks, destination),
    followup: "",
  };
}

async function repairAffectedDays(strategy, itinerary, report, attempt) {
  const affected = report.affected_days;
  const affectedBlocks = itinerary.city_day.filter((block) => affected.includes(Number(block.day)));
  const surrounding = itinerary.city_day.filter((block) => !affected.includes(Number(block.day)));

  const repairContext = {
    attempt,
    normalized_request: strategy.normalized_request,
    candidate_inventory: strategy.candidate_inventory,
    complete_master_plan: strategy.master_plan,
    validation_errors: report.errors,
    affected_days_current_blocks: affectedBlocks,
    valid_surrounding_days: surrounding,
  };

  return callJSON({
    instructions: REPAIR_PROMPT,
    messages: [contextMessage("REPAIR CONTEXT", repairContext)],
    schemaName: "itbmo_repaired_blocks",
    schema: REPAIR_SCHEMA,
    maxOutputTokens: Math.min(12000, 4000 + affected.length * 3000),
    stage: `repair_${attempt}`,
  });
}

function mergeRepairedBlocks(itinerary, repaired) {
  const replacement = new Map(
    safeArray(repaired?.city_day).map((block) => [Number(block?.day), block])
  );

  const allDays = new Set([
    ...itinerary.city_day.map((b) => Number(b.day)),
    ...replacement.keys(),
  ]);

  const merged = [...allDays]
    .sort((a, b) => a - b)
    .map((day) => replacement.get(day) || itinerary.city_day.find((b) => Number(b.day) === day))
    .filter(Boolean);

  return {
    ...itinerary,
    city_day: normalizeCityDay(merged, itinerary.destination),
  };
}

async function runPlanner(body, messages, language) {
  const started = nowMs();

  const strategy = await buildStrategy(body, messages, language);
  const expectedDays = Number(strategy?.normalized_request?.days_total || strategy?.master_plan?.length || 1);

  // Ensure the explicit language remains authoritative even if normalization drifted.
  strategy.normalized_request.language = language;

  const dayNumbers = Array.from({ length: expectedDays }, (_, i) => i + 1);
  const chunks = splitIntoChunks(dayNumbers, DAY_CHUNK_SIZE);

  const generatedBlocks = [];
  for (const chunk of chunks) {
    const generated = await generateDayChunk(strategy, chunk, generatedBlocks);
    const normalized = normalizeCityDay(
      generated?.city_day,
      strategy?.normalized_request?.destination?.display_name
    );
    generatedBlocks.push(...normalized);
  }

  let itinerary = assembleItinerary(strategy, generatedBlocks);
  let report = validateItinerary(itinerary, strategy);

  for (let attempt = 1; !report.ok && attempt <= MAX_REPAIRS; attempt += 1) {
    log("warn", "validation_failed", {
      attempt,
      error_count: report.errors.length,
      affected_days: report.affected_days,
      codes: [...new Set(report.errors.map((e) => e.code))],
    });

    const repaired = await repairAffectedDays(strategy, itinerary, report, attempt);
    itinerary = mergeRepairedBlocks(itinerary, repaired);
    report = validateItinerary(itinerary, strategy);
  }

  if (!report.ok) {
    const error = new Error("The itinerary could not satisfy all deterministic validations.");
    error.itbmo = {
      code: "BUSINESS_VALIDATION_ERROR",
      message: "No fue posible completar el itinerario con la calidad requerida.",
      retryable: true,
      stage: "validation",
      affected_days: report.affected_days,
      validation_errors: report.errors,
    };
    throw error;
  }

  log("info", "planner_completed", {
    ms: nowMs() - started,
    days_total: itinerary.days_total,
    rows_total: itinerary.city_day.reduce((sum, day) => sum + day.rows.length, 0),
    repairs_used: MAX_REPAIRS,
  });

  return itinerary;
}

// -----------------------------------------------------------------------------
// HTTP responses and compatibility
// -----------------------------------------------------------------------------

function localizedErrorMessage(lang, code) {
  const messages = {
    es: {
      TIMEOUT: "La generación tardó más de lo permitido. Inténtalo nuevamente.",
      RATE_LIMIT: "El servicio está temporalmente ocupado. Inténtalo nuevamente en unos momentos.",
      INCOMPLETE_OUTPUT: "No fue posible completar todos los días del itinerario.",
      SCHEMA_ERROR: "La respuesta no tuvo la estructura necesaria.",
      BUSINESS_VALIDATION_ERROR: "No fue posible completar el itinerario con la calidad requerida.",
      MODEL_ERROR: "No fue posible generar el itinerario en este momento.",
    },
    pt: {
      TIMEOUT: "A geração demorou mais do que o permitido. Tente novamente.",
      RATE_LIMIT: "O serviço está temporariamente ocupado. Tente novamente em alguns instantes.",
      INCOMPLETE_OUTPUT: "Não foi possível completar todos os dias do itinerário.",
      SCHEMA_ERROR: "A resposta não apresentou a estrutura necessária.",
      BUSINESS_VALIDATION_ERROR: "Não foi possível concluir o itinerário com a qualidade necessária.",
      MODEL_ERROR: "Não foi possível gerar o itinerário neste momento.",
    },
    en: {
      TIMEOUT: "Generation took longer than allowed. Please try again.",
      RATE_LIMIT: "The service is temporarily busy. Please try again shortly.",
      INCOMPLETE_OUTPUT: "The itinerary could not be completed for every requested day.",
      SCHEMA_ERROR: "The response did not have the required structure.",
      BUSINESS_VALIDATION_ERROR: "The itinerary could not be completed at the required quality.",
      MODEL_ERROR: "The itinerary could not be generated at this time.",
    },
  };
  const bundle = messages[lang] || messages.en;
  return bundle[code] || bundle.MODEL_ERROR;
}

function publicErrorPayload(error, lang) {
  const detail = error?.itbmo || classifyOpenAIError(error, "unknown");
  return {
    ok: false,
    error: {
      code: detail.code || "MODEL_ERROR",
      message: localizedErrorMessage(lang, detail.code),
      retryable: Boolean(detail.retryable),
      stage: detail.stage || "unknown",
      affected_days: safeArray(detail.affected_days),
    },
  };
}

function setCors(req, res) {
  const origin = req.headers?.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function isPlannerMode(mode) {
  const normalized = normalizeKey(mode || "planner");
  return !["info", "chat", "assistant", "conversation"].includes(normalized);
}

// -----------------------------------------------------------------------------
// Vercel handler
// -----------------------------------------------------------------------------

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({
      text: JSON.stringify({
        ok: false,
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "Use POST.",
          retryable: false,
          stage: "request",
          affected_days: [],
        },
      }),
    });
  }

  const body = req.body || {};
  const messages = extractMessages(body);
  const language =
    detectLanguageOverride(messages, body) ||
    detectUserLang(messages);

  try {
    if (!process.env.OPENAI_API_KEY) {
      const e = new Error("OPENAI_API_KEY is not configured.");
      e.itbmo = {
        code: "MODEL_ERROR",
        message: "OPENAI_API_KEY is not configured.",
        retryable: false,
        stage: "configuration",
      };
      throw e;
    }

    if (!isPlannerMode(body.mode)) {
      const text = await callText({
        instructions: `${INFO_PROMPT}\nThe required response language is: ${language}.`,
        messages,
        maxOutputTokens: 3000,
        stage: "info",
      });
      return res.status(200).json({ text });
    }

    const itinerary = await runPlanner(body, messages, language);
    const compatible = adaptLegacyOutput(itinerary);

    // External contract intentionally unchanged.
    return res.status(200).json({ text: JSON.stringify(compatible) });
  } catch (error) {
    const payload = publicErrorPayload(error, language);
    log("error", "request_failed", {
      mode: body?.mode || "planner",
      error: error?.itbmo || error?.message,
    });

    // Preserve the external {text:"<string>"} contract.
    // No fictitious rows or "itinerary pending" placeholders are inserted.
    return res.status(200).json({ text: JSON.stringify(payload) });
  }
}
