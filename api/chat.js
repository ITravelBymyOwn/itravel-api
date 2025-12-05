// /api/chat.js — v30.1 (ESM compatible en Vercel · cambio QUIRÚRGICO)
// - Mantiene la estructura de v30.0
// - Refuerza SYSTEM_PROMPT con reglas de Auroras y “Destino→Sub-paradas”
// - Mejora cleanToJSON para capturar ```json ...```
// - Añade reintento estricto con JSON nativo vía chat.completions (response_format: json_object)
// - Mantiene contrato de salida { text: JSON.stringify(parsed) } para no romper el planner

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

// ⬇️ Mejorado: intenta también extraer bloque ```json ... ```
function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  // 1) Intento directo
  try {
    return JSON.parse(raw);
  } catch {}
  // 2) Bloque ```json ... ```
  try {
    const m = raw.match(/```json\s*([\s\S]*?)```/i);
    if (m && m[1]) return JSON.parse(m[1]);
  } catch {}
  // 3) Recorte tolerante hasta primer { o [
  try {
    const start = Math.min(
      ...[raw.indexOf("{"), raw.indexOf("[")].filter((i) => i >= 0)
    );
    const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      const cleaned = raw.slice(start, end + 1);
      return JSON.parse(cleaned);
    }
  } catch {}
  return null;
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

// ==============================
// Prompt base mejorado ✨ (quirúrgico)
// ==============================

// Nota exacta requerida para Auroras (con negrita desde “La hora…”)
const AURORA_NOTE_TEXT =
  'Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. **La hora de regreso al hotel dependerá del tour de auroras que se tome. Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche, investiga acerca de la seguridad en la época de tu visita).**';

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
  "transport": "Transporte realista (A pie, Metro, Tren, Bus, Taxi, Vehículo alquilado, Tour guiado, Ferry, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve (1–2 líneas)",
  "_crossDay": false   // true solo si cruza medianoche
}

🌌 AURORAS (si la ciudad/latitud y la temporada lo permiten)
- Ventana fija: inicio ≥ "18:00" y fin ≈ "00:30"–"01:00". Permite cruce de día; marca "_crossDay": true cuando aplique.
- Duración: si no hay dato exacto, usa "Depende del tour".
- Transporte: fuera de ciudad = "Tour guiado o Vehículo propio". Dentro de ciudad (o tras “Regreso a <Ciudad>”) usa A pie/Taxi/Transporte público.
- Distribución determinística (evita la última noche y noches consecutivas cuando sea posible):
  • Estancias 1–5 días → noches 1 y 3
  • Estancias 1–7 días → noches 1, 3 y 5
  • Estancias 1–10 días → noches 1, 3, 5 y 7
  • Estancias 1–15 días → noches 1, 3, 5, 7, 9 y 11
- Nota OBLIGATORIA, EXACTA (primera oración normal; el resto en **negrita**):
  "${AURORA_NOTE_TEXT}"
- Estética: si admites campo extra, añade "noteClass": "note-sm" (opcional).

🧭 “DESTINO → SUB-PARADAS” (para tours/excursiones/rutas/día completo fuera de ciudad)
- Divide la jornada en 3–6 sub-paradas (mín. 3; ideal 5–6; máx. 8 si el día es muy completo).
- Estructura recomendada:
  1) Salida desde la ciudad base (30–60 min; "Vehículo alquilado o Tour guiado").
  2–6) Sub-paradas (45–120 min cada una; A pie o Tour guiado dentro del sitio).
  7) Pausa gastronómica/cultural (60–90 min).
  8) "Regreso a <Ciudad>" (≈1–3 h; "Vehículo alquilado o Tour guiado").
- Criterios: orden geográfico realista, horas crecientes, buffers ≥15 min, variedad, duración diurna total 8–11 h (≈08:00–18:30).
- Siempre cerrar el bloque con "Regreso a <Ciudad>" ANTES de cenas/nocturnas.
- Tras “Regreso a <Ciudad>”, NO heredar "Vehículo alquilado o Tour guiado" en nuevas actividades urbanas.

🚆 TRANSPORTE Y CIERRES
- Entre puntos foráneos: "Vehículo alquilado o Tour guiado".
- En ciudad o tras "Regreso a <Ciudad>": A pie / Transporte público / Taxi.
- Si la última actividad es auroras → NO añadir “Regreso a hotel” (se sobreentiende en la nota).
- Si NO es aurora al final → añade "Regreso a hotel" (30–45m; Taxi/A pie).

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Notas motivadoras, sin párrafos largos.
- Evita duplicados multi-día y solapes de horas.
- Si faltan datos, reparte mañana/mediodía/tarde de forma coherente.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No texto fuera del JSON.
- No repitas notas idénticas.
`.trim();

// ==============================
// Llamadas al modelo
// ==============================
async function callStructured(messages, temperature = 0.35) {
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

  // console.log("🛰️ RAW RESPONSE:", text);
  return text;
}

// 🔒 Reintento estricto pidiendo JSON nativo
async function callStructuredJSON(messages, temperature = 0.2) {
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    messages,
    response_format: { type: "json_object" },
    max_tokens: 1800,
  });
  const text = completion?.choices?.[0]?.message?.content?.trim() || "";
  return text;
}

// ==============================
// Exportación ESM correcta
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner"; // se mantiene soporte de "info"
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — texto libre (sin JSON)
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original (con reintentos seguros)
    const msgsBase = [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages];

    // Intento 1: estilo original (responses)
    let raw = await callStructured(msgsBase, 0.35);
    let parsed = cleanToJSON(raw);

    // Intento 2: si no parsea, exigir JSON nativo
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      raw = await callStructuredJSON(msgsBase, 0.2);
      parsed = cleanToJSON(raw);
    }

    // Intento 3: prompt aún más estricto + ejemplo mínimo válido
    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const ultra = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.
Ejemplo válido mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}
`;
      const ultraMsgs = [{ role: "system", content: ultra }, ...clientMessages];
      raw = await callStructuredJSON(ultraMsgs, 0.15);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
