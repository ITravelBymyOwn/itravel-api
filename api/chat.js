// /api/chat.js — v37.0 (ESM · Vercel compatible)
// Objetivo: simplificar y reforzar reglas globales para AURORAS y “Destino → Sub-paradas”
// Mantiene compatibilidad con el planner (formatos A/B/C/D), sin cambiar nombres/contratos.

import OpenAI from "openai";

export const config = {
  runtime: "edge", // puedes quitar esta línea si prefieres Node.js runtime estándar
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ==============================
   Helpers básicos (compatibles con versiones previas)
================================= */
function extractMessages(body = {}) {
  // Prioriza "messages"; si no, arma con history + input para compatibilidad
  const { messages, input, history } = body || {};
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      // Extrae el primer bloque JSON válido incluso si vienen “prefijos/sufijos”
      const cleaned = raw.replace(/^[^\[{]+/, "").replace(/[^\]}]+$/, "");
      return JSON.parse(cleaned);
    } catch {
      // Intenta extraer bloque entre ```json ... ```
      const m = raw.match(/```json\s*([\s\S]*?)```/i);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {
          return null;
        }
      }
      return null;
    }
  }
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    replace: false,
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "10:30",
        activity: "Paseo de orientación",
        from: "Hotel",
        to: "Centro",
        transport: "A pie",
        duration: "1h30m",
        notes:
          "Explora los alrededores del hotel para ubicar servicios, comidas y transporte.",
      },
    ],
  };
}

/* ==============================
   Reglas globales (SYSTEM PROMPT)
   — Sintetiza y fija criterios para el agente
================================= */

// Texto obligatorio para notas de auroras (con **negrita** desde “Después de inolvidable”)
const AURORA_NOTE_TEXT =
  'Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. **La hora de regreso al hotel dependerá del tour de auroras que se tome. Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche, investiga acerca de la seguridad en la época de tu visita).**';

// Distribución determinística solicitada por el usuario
// (se evita última noche y noches consecutivas cuando sea posible)
const AURORA_DISTRIBUTION_RULES = `
Auroras (si la ciudad/latitud y la temporada lo permiten):
- Distribución por duración de la estancia (evitando la última noche y noches consecutivas cuando sea posible):
  • 1–5 días → Días 1 y 3
  • 1–7 días → Días 1, 3 y 5
  • 1–10 días → Días 1, 3, 5 y 7
  • 1–15 días → Días 1, 3, 5, 7, 9 y 11
- Ventana horaria base: inicio ≥ 18:00 y fin ~ 00:30–01:00, permitiendo cruce de día (start < end del día siguiente).
- Duración: si no se especifica, usa “Depende del tour”.
- Transporte: “Tour guiado o Vehículo propio”.
- Nota (obligatoria, exacta): ${AURORA_NOTE_TEXT}
- Estética de nota: usar clase de estilo "note-sm" (en el campo "noteClass" si corresponde).
`;

// Regla “Destino → Sub-paradas” (aplica a tours/día completo fuera de ciudad)
const SUBPARADAS_RULES = `
Desglose “Destino → Sub-paradas” (aplicable a tours/excursiones/rutas/día completo que salgan del entorno urbano):
- Divide la jornada en 3–6 sub-paradas (mín. 3; ideal 5–6; máx. 8 si el día es muy completo).
- Estructura recomendada:
  1) Salida desde la ciudad base (30–60 min; “Vehículo alquilado o Tour guiado”).
  2–6) Sub-paradas intermedias (45–120 min cada una; “A pie” o “Tour guiado” dentro del sitio).
  7) Pausa gastronómica/cultural (60–90 min).
  8) Regreso a <Ciudad> (≈ 1–3 h; “Vehículo alquilado o Tour guiado”).
- Criterios:
  • Orden geográfico realista, sin saltos ni retrocesos.
  • Horas crecientes, sin superposición (buffers ≥ 15 min).
  • Variedad de experiencias (paisaje/actividad/pueblo/mirador/descanso).
  • Duración total del bloque diurno aprox. 8–11 h (08:00–18:30).
- Siempre cerrar el bloque con “Regreso a <Ciudad>” ANTES de cualquier cena o evento nocturno.
- Tras el “Regreso a <Ciudad>”, NO heredar “Vehículo alquilado o Tour guiado” en nuevas actividades urbanas.
`;

// Transporte correcto + retornos y buffers
const TRANSPORT_RETURNS_RULES = `
Transporte y retornos:
- Entre puntos foráneos o interurbanos, determina “Vehículo alquilado o Tour guiado”.
- En ciudad, o después de “Regreso a <Ciudad>”, usa “A pie / Transporte público / Taxi”.
- Añade buffers ≥ 15 min. Evita solapes; si una actividad nocturna cruza de día (ej. auroras), permítelo.
- “Regreso a <Ciudad>” obligatorio cuando se sale del entorno urbano. Si esa misma noche hay auroras, el retorno debe terminar ≤ 18:30.
- “Regreso a hotel” al final del día, EXCEPTO cuando la última actividad sea auroras (el tour ya contempla el retorno).
- Rango horario recomendado del día: 08:00–18:30 (diurno). Actividades nocturnas pueden extenderse hasta ~01:00.
`;

// Formatos admitidos por el planner (mantener compatibilidad)
const FORMAT_RULES = `
Formatos esperados (cualquiera de los siguientes):
- A) {"destination":"<Ciudad>","rows":[...],"replace": false}
- B) {"rows":[...],"replace": false}
- C) {"rows":[...]} (siempre se interpreta como replace=false)
- D) {"itinerary":{"<Ciudad>":{"byDay":{"1":[...],"2":[...]}}}}
Requisitos por fila:
- {day, start, end, activity, from, to, transport, duration, notes?, noteClass? , _crossDay?}
- start/end en "HH:MM". Si una actividad nocturna cruza de día (ej. 20:30–01:00), marca _crossDay=true.
- “notes” informativas (nunca vacías) y sin texto de sistema/plantilla.
`;

// Prompt del sistema consolidado
const SYSTEM_PROMPT = `
Eres “Astra”, un planificador de viajes. Devuelves SIEMPRE uno de los formatos JSON válidos que el cliente acepta.

Objetivo:
- Tomar instrucciones del usuario/llamador (contexto del planner) y devolver un itinerario optimizado, sin solapes, con transporte lógico y detalles útiles.

Reglas universales:
${SUBPARADAS_RULES}

${TRANSPORT_RETURNS_RULES}

${AURORA_DISTRIBUTION_RULES}

${FORMAT_RULES}

Política de estilo:
- Nombres claros de actividades.
- Notas breves y motivadoras (1–2 líneas), y en auroras usa el texto exacto indicado (con **negrita** en el tramo final).
- Evita duplicados multi-día.
`;

/* ==============================
   Llamada al modelo
================================= */
async function callModel(messages) {
  // Inserta el system prompt al inicio, respetando cualquier system existente del cliente
  const msgs = [];
  const hasSystem = (messages || []).some((m) => m.role === "system");
  if (!hasSystem) msgs.push({ role: "system", content: SYSTEM_PROMPT });
  else {
    // Precede el SYSTEM_PROMPT y luego los messages originales (para reforzar reglas)
    msgs.push({ role: "system", content: SYSTEM_PROMPT });
  }
  msgs.push(...(messages || []));

  const completion = await client.chat.completions.create({
    model: "gpt-5.1",
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 1500,
    messages: msgs,
    response_format: { type: "text" }, // devuelve texto plano JSON-friendly
  });

  const text =
    completion.choices?.[0]?.message?.content?.trim() ||
    JSON.stringify(fallbackJSON());

  return text;
}

/* ==============================
   Handler HTTP (Edge/Node)
================================= */
export default async function handler(req) {
  try {
    const body = req.method === "POST" ? await req.json() : {};
    const messages = extractMessages(body);

    // Compat: si el caller envía "instructions" directo
    if (typeof body.instructions === "string" && body.instructions.trim()) {
      messages.push({ role: "user", content: body.instructions.trim() });
    }

    const text = await callModel(messages);

    // Intenta validar que haya JSON parseable; si no, devuelve texto tal cual (el planner es tolerante)
    const j = cleanToJSON(text);
    if (j) {
      return new Response(JSON.stringify(j), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // Fallback: texto plano (el planner intentará parsearlo)
    return new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (err) {
    console.error("[/api/chat] ERROR:", err);
    // Devuelve fallback JSON seguro
    return new Response(JSON.stringify(fallbackJSON()), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
