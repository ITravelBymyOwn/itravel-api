// /api/chat.js — v42.5 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y calcula) → (2) PLANNER (estructura).
// Respeta estrictamente preferencias/condiciones del usuario.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============== Utilidades comunes ===============
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

function cleanToJSONPlus(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
  } catch {}
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
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
        notes: "Explora libremente la ciudad.",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o ancho de banda.",
  };
}

async function callText(messages, temperature = 0.4, max_output_tokens = 3000) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: messages
      .map(m => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
      .join("\n\n"),
  });
  return (
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    ""
  );
}

// =============== Prompts del sistema ===============

// 1) SISTEMA — INFO CHAT (investiga/calcula, obedece preferencias)
const SYSTEM_INFO = `
Eres el **motor de investigación** de ITravelByMyOwn (Info Chat).

RECIBES: un objeto JSON "context" con TODOS los datos del planner:
- ciudad, país, fechas, días totales
- dirección/nombre de hotel (punto base exacto para tiempos)
- viajeros (edades), ritmo, presupuesto
- **preferencias** y **condiciones especiales** del usuario (¡PRIORIDAD MÁXIMA!)
- transporte preferido/disponible
- ciudades previa/siguiente (si aplica)
- notas libres del usuario
- reglas del sistema (p.ej., max_substops_per_tour=8)

TU TAREA (global, sin predefinidos por país):
1) Identifica **imperdibles** (must_see=true) y ordénalos por cercanía/zonas.
2) Detecta **macro-tours de 1 día** (ciudades cercanas relevantes) *solo si*
   respetan las preferencias/condiciones y aportan más valor que alternativas locales.
3) Calcula **tiempos REALES** entre puntos, incluyendo **regreso al hotel**.
   - Si falta dirección exacta, usa la del hotel_base como referencia urbana.
   - Entrega tiempos como duraciones ("45m", "1h15", "2h") y, si es útil, modo sugerido.
4) Construye para cada día una **ruta optimizada** (orden lógico, sin sobrecargar).
5) Para excursiones, lista **sub-paradas (hasta 8)** con nombres precisos.
6) **Auroras (cuando aplique):**
   - Parte SIEMPRE de la ciudad y de las fechas dadas por el usuario.
   - **Infiere latitud** aproximada de la ciudad y decide si es plausible ver auroras
     en esas fechas (considera estación, horas de oscuridad y clima típico).
   - **Investiga ventanas locales típicas de avistamiento** para esas fechas y
     **tours que operan** (sin listar operadores; solo el rango horario habitual).
   - Devuelve una **ventana horaria local concreta** (ej.: 20:00–01:30, 21:30–02:00),
     y marca días sugeridos **no consecutivos** y **nunca el último día**.
   - Suministra campos para que el Planner pinte la fila nocturna: transporte por defecto
     ("Tour guiado/Van" o "Vehículo alquilado o Tour guiado"), una **nota estándar**
     “Actividad sujeta a clima; **depende del tour**”, y **duración** fija:
     "**Depende del tour o horas que dediques si vas por tu cuenta**".
7) Incluye sugerencias de comida/descanso si son icónicas y compatibles con condiciones
   (p.ej., evitar largas colas si hay movilidad reducida).

REGLAS CLAVE:
- **Nunca ignores** preferencias/condiciones del usuario; si chocan con un imperdible, explícalo en "rationale".
- No devuelvas texto fuera de JSON. Respuesta **única** en JSON válido.

SALIDA JSON ÚNICA:
{
  "destination": "Ciudad",
  "country": "País",
  "days_total": 5,
  "hotel_base": "Nombre o dirección",
  "rationale": "Notas de porqué este orden y elecciones, considerando preferencias/condiciones.",
  "imperdibles": [
    { "name":"...", "type":"...", "area":"...", "must_see": true }
  ],
  "macro_tours": [
    {
      "name":"Excursión — Toledo",
      "typical_transport": "Tren o Tour guiado",
      "substops":[
        { "name":"Casco histórico", "duration":"1h45", "leg_from_prev":"30m Tren/Taxi" },
        { "name":"Catedral Primada", "duration":"1h15", "leg_from_prev":"10m a pie" }
      ],
      "return_to_city_duration":"1h Tren",
      "why": "Aporta más valor que X en días N según preferencias/ritmo."
    }
  ],
  "in_city_routes": [
    {
      "day": 1,
      "optimized_order": [
        { "name":"Palacio Real", "duration":"1h30", "leg_from_prev":"20m desde hotel (Metro/Taxi)" },
        { "name":"Plaza Mayor", "duration":"45m", "leg_from_prev":"10m a pie" }
      ],
      "return_to_hotel_duration":"20m Metro/Taxi"
    }
  ],
  "meals_suggestions":[
    { "slot":"almuerzo", "area":"Centro", "type":"local", "duration":"60–90m" }
  ],
  "aurora": {
    "plausible": false,
    "suggested_days": [],
    "window_local": { "start": "", "end": "" },             // HH:MM locales si plausible
    "transport_default": "",                                // "Tour guiado/Van" o "Vehículo alquilado o Tour guiado"
    "note": "Actividad sujeta a clima; depende del tour",   // nota estándar
    "duration": "Depende del tour o horas que dediques si vas por tu cuenta"
  },
  "constraints": {
    "max_substops_per_tour": 8,
    "avoid_duplicates_across_days": true,
    "optimize_order_by_distance_and_time": true,
    "respect_user_preferences_and_conditions": true
  }
}
`.trim();

// 2) SISTEMA — PLANNER (estructura con filas; no investiga)
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat con datos fácticos
(orden, sub-paradas, tiempos de cada tramo, regreso al hotel, etc.).

TU TAREA:
- Convertir research_json en {"destination","rows":[...]}.
- **No inventes** tiempos ni destinos: usa exactamente los tiempos de research_json.
- Asigna horas razonables dentro de la ventana 08:30–19:00, agregando buffers ≥15m.
- Inserta **notas motivadoras** breves en cada fila (sin texto florido).
- Para macro-tours, usa **"Actividad": "Excursión — A / — B / — C ..."** (hasta 8 sub-paradas).
- Respeta preferencias/condiciones del usuario si research_json las contempla (no sobrecargues días, evita largas caminatas si se indicó, etc.).
- **Auroras**: si "aurora.plausible = true":
  - Usa **exactamente** la ventana research_json.aurora.window_local {start,end}.
  - Crea filas nocturnas (sin usar el último día) para cada día en aurora.suggested_days,
    con "transport" = aurora.transport_default cuando exista.
  - "duration" = aurora.duration (texto), y "notes" = aurora.note (añade "valid:" si corresponde).
  - Si falta window_local, omite la creación (no inventes).

FORMATO ÚNICO (JSON válido, sin texto adicional):
{
  "destination":"Ciudad",
  "rows":[
    {
      "day":1,
      "start":"08:30",
      "end":"10:00",
      "activity":"Visitar X",
      "from":"Hotel",
      "to":"X",
      "transport":"A pie / Metro / Tren / Taxi / Vehículo alquilado o Tour guiado",
      "duration":"1h30",
      "notes":"Consejo breve"
    }
  ],
  "followup":"Sugerencia breve opcional"
}
`.trim();

// =============== Handler principal ===============
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";

    // -------------------- MODO INFO --------------------
    // Entrada esperada: { mode:"info", context:{...TODOS LOS DATOS DEL PLANNER...} }
    if (mode === "info") {
      const context = body.context || {};
      // Hard-guard: debe llegar TODO lo del planner (preferencias/condiciones incluidas)
      const infoUserMsg = {
        role: "user",
        content: JSON.stringify({ context }, null, 2),
      };

      // 1er intento (normal)
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3500);
      let parsed = cleanToJSONPlus(raw);

      // Reintento más estricto si no hay JSON válido
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = {
        destination: context.city || "Destino",
        country: context.country || "",
        days_total: context.days_total || 1,
        hotel_base: context.hotel_address || "",
        rationale: "Fallback mínimo.",
        imperdibles: [],
        macro_tours: [],
        in_city_routes: [],
        meals_suggestions: [],
        aurora: {
          plausible: false,
          suggested_days: [],
          window_local: { start: "", end: "" },
          transport_default: "",
          note: "Actividad sujeta a clima; depende del tour",
          duration: "Depende del tour o horas que dediques si vas por tu cuenta"
        },
        constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true }
      };

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO PLANNER --------------------
    // Entrada esperada: { mode:"planner", research_json:{...}, city?: "..." }
    if (mode === "planner") {
      const research = body.research_json || null;

      // Permitir también flujo legado (mensajes), pero preferimos research_json directo
      if (!research) {
        // Flujo legado con messages: intentamos estructurar, pero sin inventar
        const clientMessages = extractMessages(body);
        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.35, 3500);
        let parsed = cleanToJSONPlus(raw);
        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 3000);
          parsed = cleanToJSONPlus(raw);
        }
        if (!parsed) parsed = fallbackJSON();
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Flujo nuevo (recomendado): research_json explícito
      const plannerUserMsg = {
        role: "user",
        content: JSON.stringify({ research_json: research }, null, 2),
      };

      // 1er intento normal
      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3500);
      let parsed = cleanToJSONPlus(raw);

      // Reintento estricto si falló
      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3000);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = fallbackJSON();
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO LEGADO "text" (opcional) --------------------
    if (mode === "text") {
      const clientMessages = extractMessages(body);
      const raw = await callText(clientMessages, 0.5, 2000);
      return res.status(200).json({ text: raw || "" });
    }

    // Modo desconocido
    return res.status(400).json({ error: "Invalid mode" });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
