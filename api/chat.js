// /api/chat.js — v30.1 (ESM compatible en Vercel) — cirugía mínima sobre v30
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Helpers (v30 + parser más robusto y utilidades de post-proceso)
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Parser tolerante (mejora clave para evitar fallback por formato extraño)
function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      let cleaned = raw.trim();

      // Quitar fences ```json ... ```
      if (/^```/m.test(cleaned)) {
        cleaned = cleaned
          .replace(/^```[a-zA-Z]*\s*/m, "")
          .replace(/```$/m, "")
          .trim();
      }

      // Recortar a primer { y último }
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
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// Utilidades seguras (no rompen si el modelo varía)
const safeStr = (v) => (typeof v === "string" ? v : "");
const toLower = (s) => safeStr(s).toLowerCase();
const stripAccents = (s) =>
  safeStr(s).normalize("NFD").replace(/\p{Diacritic}/gu, "");

// Acceso uniforme a rows (soporta ambos formatos permitidos)
function getRows(parsed) {
  try {
    if (!parsed || typeof parsed !== "object") return [];
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed?.destinations?.[0]?.rows))
      return parsed.destinations[0].rows;
    return [];
  } catch {
    return [];
  }
}
function setRows(parsed, rows) {
  try {
    if (!parsed || !Array.isArray(rows)) return;
    if (Array.isArray(parsed.rows)) parsed.rows = rows;
    else if (Array.isArray(parsed?.destinations?.[0]?.rows))
      parsed.destinations[0].rows = rows;
  } catch {
    /* no-op */
  }
}
function hasRows(parsed) {
  const rows = getRows(parsed);
  return Array.isArray(rows) && rows.length > 0;
}

// ==========================================
// Reglas pedidas — Auroras + transporte post-regreso
// ==========================================
const AURORA_CITIES = new Set([
  "reykjavik",
  "reykjavík",
  "tromso",
  "tromsø",
  "rovaniemi",
  "abisko",
  "fairbanks",
  "yellowknife",
  "kiruna",
  "alta",
  "akureyri",
  "murmansk",
  "svalbard",
  "ivalo",
  "honningsvag",
  "honningvag",
]);

const AURORA_NOTE_COMPACT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. **Regreso según tour. Puedes ir con tour o por tu cuenta; si conduces, infórmate sobre seguridad invernal.**";

function cityKeyOf(parsed) {
  const raw =
    parsed?.destination ??
    parsed?.destinations?.[0]?.name ??
    "";
  return stripAccents(toLower(raw));
}

function auroraNightsFor(totalDays) {
  if (!Number.isFinite(totalDays) || totalDays <= 0) return 1;
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 3;
  return 4;
}

function injectAurorasIfNeeded(parsed) {
  try {
    if (!parsed) return parsed;
    const key = cityKeyOf(parsed);
    if (!key || !AURORA_CITIES.has(key)) return parsed;

    const rows = getRows(parsed);
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    // Si ya hay auroras, no duplicar
    const already = rows.some(
      (r) =>
        toLower(r?.activity).includes("aurora") ||
        toLower(r?.notes).includes("aurora")
    );
    if (already) return parsed;

    const maxDay = rows.reduce((m, r) => {
      const d = Number(r?.day ?? 1);
      return Number.isFinite(d) && d > m ? d : m;
      }, 1);

    const target = auroraNightsFor(maxDay);

    // Distribución no consecutiva: 1,3,5,... mientras haya días
    const chosen = [];
    for (let d = 1; d <= maxDay && chosen.length < target; d += 2) {
      chosen.push(d);
    }

    chosen.forEach((dayNum) => {
      rows.push({
        day: dayNum,
        start: "18:00",
        end: "01:00",
        activity: "Caza de auroras boreales",
        from: "Hotel",
        to: "Puntos de observación (variable)",
        transport: "Vehículo alquilado o Tour guiado",
        duration: "≈7h",
        notes: AURORA_NOTE_COMPACT,
      });
    });

    // Reordenar por día y hora
    const ordered = [...rows].sort((a, b) => {
      const da = Number(a?.day ?? 1),
        db = Number(b?.day ?? 1);
      if (da !== db) return da - db;
      return safeStr(a?.start).localeCompare(safeStr(b?.start));
    });

    setRows(parsed, ordered);
    return parsed;
  } catch {
    return parsed;
  }
}

// Regla: tras “Regreso a X”, las actividades del mismo día NO deben seguir con
// “Vehículo alquilado o Tour guiado”; se normaliza a sugerencia local.
function fixTransportAfterReturn(parsed) {
  try {
    const rows = getRows(parsed);
    if (!Array.isArray(rows) || rows.length === 0) return parsed;

    let returned = new Map(); // day -> true si ya hubo “Regreso …”
    const out = rows.map((r) => ({ ...r }));

    out.forEach((r) => {
      const day = Number(r?.day ?? 1);
      const act = stripAccents(toLower(r?.activity || ""));

      if (act.startsWith("regreso")) {
        returned.set(day, true);
      } else if (returned.get(day)) {
        const tr = stripAccents(toLower(r?.transport || ""));
        if (tr.includes("vehiculo alquilado") || tr.includes("tour guiado")) {
          r.transport = "A pie o taxi local";
        }
      }
    });

    setRows(parsed, out);
    return parsed;
  } catch {
    return parsed;
  }
}

// ==============================
// Prompt base (tus reglas v30 + mención breve de auroras)
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
- Tono cálido, entusiasta y narrativo.
- Notas de 1–2 líneas; varía el vocabulario; evita repeticiones.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes con el contexto; horas ordenadas sin solapes.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide cambios, responde con el itinerario JSON actualizado.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).

🔭 AURORAS (si aplica por latitud/temporada)
- Puedes incluir noches de caza de auroras (18:00–01:00) con transporte
  "Vehículo alquilado o Tour guiado" y una nota breve, evitando noches consecutivas.
`.trim();

// ==============================
// Llamada al modelo (misma mecánica v30, pero tolerante)
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2200,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text?.slice?.(0, 500));
  return text;
}

// ==============================
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO — texto libre (sin JSON)
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER — igual a v30 pero con parsing endurecido + post-proceso
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = cleanToJSON(raw);

    if (!(parsed && hasRows(parsed))) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `\nOBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = cleanToJSON(raw);
    }

    if (!(parsed && hasRows(parsed))) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `\nEjemplo válido:\n{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.1
      );
      parsed = cleanToJSON(raw);
    }

    // —— Post-proceso defensivo (no lanza errores) ——
    if (parsed && hasRows(parsed)) {
      parsed = injectAurorasIfNeeded(parsed);
      parsed = fixTransportAfterReturn(parsed);
    }

    // Garantía final: nunca devolvemos null
    if (!parsed || !hasRows(parsed)) parsed = fallbackJSON();

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Nunca rompemos el front: 200 con fallback
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
