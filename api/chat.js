// /api/chat.js — v31.0 (ESM compatible en Vercel) — hardening a partir de v30
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Helpers (conserva v30 + utilidades seguras)
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Parser tolerante (queda como respaldo; la ruta principal usa JSON Schema)
function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      let cleaned = raw.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/,"").replace(/```$/,"").trim();
      }
      const first = cleaned.indexOf("{");
      const last = cleaned.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        cleaned = cleaned.slice(first, last + 1);
      }
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "08:30",
        end: "19:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// utilidades seguras
const safeStr = (v) => (typeof v === "string" ? v : "");
const toLower = (s) => safeStr(s).toLowerCase();
const stripAccents = (s) =>
  safeStr(s).normalize("NFD").replace(/\p{Diacritic}/gu, "");

// Acceso uniforme a rows para los dos formatos soportados
function getRows(parsed) {
  try {
    if (!parsed || typeof parsed !== "object") return [];
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed?.destinations?.[0]?.rows))
      return parsed.destinations[0].rows;
    return [];
  } catch { return []; }
}
function setRows(parsed, rows) {
  try {
    if (!parsed || typeof parsed !== "object" || !Array.isArray(rows)) return;
    if (Array.isArray(parsed.rows)) parsed.rows = rows;
    else if (Array.isArray(parsed?.destinations?.[0]?.rows)) parsed.destinations[0].rows = rows;
  } catch { /* no-op */ }
}
function hasRows(parsed) {
  const r = getRows(parsed);
  return Array.isArray(r) && r.length > 0;
}

// ==============================
// Prompt base (v30) + nota auroras (guía, no imprescindible)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas realistas (o 08:30–19:00 si no se indica nada).
- La respuesta debe poder renderizarse directamente en una UI web.
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido y narrativo; notas de 1–2 líneas con emoción y sentido del lugar.
- Varía el vocabulario; evita repetir la misma nota.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes con el contexto; horas ordenadas sin solapes.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide cambios, responde con el itinerario actualizado.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).

🔭 AURORAS (si corresponde por latitud/temporada)
- Puedes incluir noches de caza de auroras NO consecutivas (18:00–01:00), transporte "Vehículo alquilado o Tour guiado" y nota breve.
`.trim();

// ==============================
// JSON Schema (fuerza salida válida del modelo)
// ==============================
const RowSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    day: { type: "integer", minimum: 1 },
    start: { type: "string" },
    end: { type: "string" },
    activity: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    transport: { type: "string" },
    duration: { type: "string" },
    notes: { type: "string" }
  },
  required: ["day","start","end","activity","from","to","transport","duration","notes"]
};

const PlannerSchema = {
  name: "itinerary_schema",
  schema: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          destination: { type: "string" },
          rows: { type: "array", items: RowSchema, minItems: 1 },
          followup: { type: "string" }
        },
        required: ["destination","rows"]
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          destinations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                rows: { type: "array", items: RowSchema, minItems: 1 }
              },
              required: ["name","rows"]
            }
          },
          followup: { type: "string" }
        },
        required: ["destinations"]
      }
    ]
  },
  strict: true
};

// ==============================
// Llamada al modelo — ahora FORZAMOS JSON por esquema
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const input = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input,
    response_format: { type: "json_schema", json_schema: PlannerSchema },
    max_output_tokens: 2200
  });

  // Ruta principal: tomar el JSON ya estructurado del Responses API
  const c0 = resp?.output?.[0]?.content?.[0];
  const asJson =
    c0?.input_json ?? c0?.json ?? null;

  if (asJson && typeof asJson === "object") return asJson;

  // Respaldo ultra-defensivo: si por algún motivo viene texto, lo parseamos
  const text =
    resp?.output_text?.trim() ||
    c0?.type === "output_text" ? c0?.text?.trim() : "" ||
    "";
  const parsed = cleanToJSON(text);
  return parsed;
}

// ==============================
// Post-proceso defensivo (sin throw)
// ==============================
const AURORA_CITIES = new Set([
  "reykjavik","reykjavík","tromso","tromsø","rovaniemi","abisko","fairbanks",
  "yellowknife","kiruna","alta","akureyri","murmansk","svalbard","ivalo","honningsvag","honningvag"
]);

const AURORA_NOTE =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. **Regreso según tour. Puedes ir con tour guiado o por tu cuenta; si conduces, infórmate sobre seguridad invernal y nieve nocturna.**";

function auroraNightsFor(totalDays) {
  if (!Number.isFinite(totalDays) || totalDays <= 0) return 1;
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 3;
  return 4;
}
function cityKeyOf(parsed) {
  const raw = parsed?.destination ?? parsed?.destinations?.[0]?.name ?? "";
  return stripAccents(toLower(raw));
}
function injectAurorasIfNeeded(parsed) {
  try {
    if (!parsed) return parsed;
    const key = cityKeyOf(parsed);
    if (!key || !AURORA_CITIES.has(key)) return parsed;

    const rows = getRows(parsed);
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    // Evitar duplicados
    const already = rows.some(r => toLower(r?.activity).includes("aurora") || toLower(r?.notes).includes("aurora"));
    if (already) return parsed;

    const maxDay = rows.reduce((m, r) => {
      const d = Number(r?.day ?? 1);
      return Number.isFinite(d) && d > m ? d : m;
    }, 1);

    const target = auroraNightsFor(maxDay);
    const chosen = [];
    for (let d = 1; d <= maxDay && chosen.length < target; d += 2) chosen.push(d);

    chosen.forEach(dayNum => {
      rows.push({
        day: dayNum,
        start: "18:00",
        end: "01:00",
        activity: "Caza de auroras boreales",
        from: "Hotel",
        to: "Puntos de observación (variable)",
        transport: "Vehículo alquilado o Tour guiado",
        duration: "≈7h",
        notes: AURORA_NOTE
      });
    });

    // Reordenar suavemente por día y hora
    const ordered = [...rows].sort((a,b) => {
      const da = Number(a?.day ?? 1), db = Number(b?.day ?? 1);
      if (da !== db) return da - db;
      return safeStr(a?.start).localeCompare(safeStr(b?.start));
    });
    setRows(parsed, ordered);
    return parsed;
  } catch { return parsed; }
}
function fixTransportAfterReturn(parsed) {
  try {
    const rows = getRows(parsed);
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    let returned = new Map();
    const out = rows.map(r => ({ ...r }));

    out.forEach(r => {
      const day = Number(r?.day ?? 1);
      const act = stripAccents(toLower(r?.activity));
      if (act.startsWith("regreso")) {
        returned.set(day, true);
      } else if (returned.get(day)) {
        const tr = stripAccents(toLower(r?.transport));
        if (tr.includes("vehiculo alquilado")) r.transport = "A pie o taxi local";
      }
    });

    setRows(parsed, out);
    return parsed;
  } catch { return parsed; }
}

// ==============================
// Handler (misma interfaz que v30, pero imposible romper)
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO — texto libre
    if (mode === "info") {
      try {
        const raw = await client.responses.create({
          model: "gpt-4o-mini",
          input: clientMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
          max_output_tokens: 800
        });
        const text =
          raw?.output_text?.trim() ||
          raw?.output?.[0]?.content?.[0]?.text?.trim() ||
          "⚠️ No se obtuvo respuesta del asistente.";
        return res.status(200).json({ text });
      } catch (e) {
        console.error("❌ info mode error:", e);
        return res.status(200).json({ text: "⚠️ No se obtuvo respuesta del asistente." });
      }
    }

    // MODO PLANNER — siempre con JSON Schema
    let parsed = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], 0.4);

    // Reintentos estrechos (nunca lanzan)
    if (!(parsed && hasRows(parsed))) {
      parsed = await callStructured(
        [{ role: "system", content: SYSTEM_PROMPT + "\nOBLIGATORIO: Devuelve al menos 1 fila en \"rows\". Nada de meta." }, ...clientMessages],
        0.25
      );
    }
    if (!(parsed && hasRows(parsed))) {
      const ultra = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      parsed = await callStructured([{ role: "system", content: ultra }, ...clientMessages], 0.1);
    }

    // Post-proceso defensivo
    if (parsed && hasRows(parsed)) {
      parsed = injectAurorasIfNeeded(parsed);
      parsed = fixTransportAfterReturn(parsed);
    }

    // Garantía final: NUNCA devolvemos null
    if (!parsed || !hasRows(parsed)) parsed = fallbackJSON();

    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error (global):", err);
    // Nunca rompemos el front: 200 con fallback
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
