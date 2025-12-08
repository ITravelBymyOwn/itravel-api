// /api/chat.js — v42.4 (ESM, Vercel)
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

async function callText(messages, temperature = 0.4, max_output_tokens = 4200) {
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
- ciudad, país, fechas (por día), días totales
- dirección/nombre de hotel (punto base exacto para tiempos)
- viajeros (edades), ritmo, presupuesto
- **preferencias** y **condiciones especiales** del usuario (PRIORIDAD MÁXIMA)
- transporte preferido/disponible y restricciones (p.ej., no conducir)
- ciudades previa/siguiente (si aplica)
- notas libres del usuario
- reglas del sistema (p.ej., max_substops_per_tour=8)

TU TAREA (investiga/razona y devuelve datos fácticos):
1) Identifica **imperdibles** (must_see=true), clasifícalos por zona y ordénalos por cercanía/tiempos.
2) Detecta **macro-tours de 1 día** (ciudades/zonas cercanas) *sólo si* aportan más valor que alternativas locales y cuadran con preferencias/condiciones. 
3) Calcula **tiempos REALES** entre puntos, incluyendo **REGRESO al hotel**:
   - Usa el hotel_base como origen/fin por defecto.
   - Entrega cada tramo como duración legible ("45m","1h15") y, si es útil, con modo sugerido (Metro/Taxi/Tren/Tour).
4) Construye para cada día una **ruta optimizada** (orden lógico sin sobrecargar, huecos razonables).
5) En macro-tours, lista **sub-paradas (hasta 8)** con nombres precisos y tiempos de cada tramo.
6) **Auroras**: 
   - A partir de la **ciudad y fechas**, infiere **latitud** y **temporada**. 
   - Determina **plausibilidad** de ver auroras y **días sugeridos no consecutivos** (nunca el último día).
   - **Investiga ventanas típicas de tours** (p. ej., salida 19:30–21:30 y regreso 00:30–02:00) y propone una **ventana recomendada**. 
   - Provee un **template de fila** con:
     transport = "Vehículo alquilado o Tour guiado",
     duration = "Depende del tour o horas que dediques si vas por tu cuenta",
     note = "Noche especial de caza de auroras... (el retorno depende del tour)".
   - No inventes certezas meteorológicas; expresa plausibilidad/ventanas típicas.
7) Comidas/descanso: sugiere slots (60–90m) cuando aporte a la experiencia y respete condiciones (movilidad, niños, etc.).

REGLAS CLAVE:
- **Nunca ignores** preferencias/condiciones del usuario; si chocan con un imperdible, explícalo en "rationale".
- No devuelvas texto fuera de JSON. Respuesta **única** en JSON válido.

SALIDA JSON ÚNICA (ejemplo de campos):
{
  "destination": "Ciudad",
  "country": "País",
  "days_total": 5,
  "hotel_base": "Nombre o dirección",
  "rationale": "Por qué este orden (preferencias/condiciones).",
  "imperdibles": [
    { "name":"...", "type":"museo/parque/monumento", "area":"Centro/…", "must_see": true }
  ],
  "macro_tours": [
    {
      "name":"Excursión — Círculo Dorado",
      "typical_transport": "Vehículo alquilado o Tour guiado",
      "substops":[
        { "name":"Þingvellir", "duration":"1h15", "leg_from_prev":"45m desde hotel (Auto/Tour)" },
        { "name":"Geysir", "duration":"1h", "leg_from_prev":"50m Auto/Tour" },
        { "name":"Gullfoss", "duration":"1h15", "leg_from_prev":"10m Auto/Tour" }
      ],
      "return_to_city_duration":"2h45 Auto/Tour",
      "why": "Clásico de la zona; encaja con ritmo y condiciones."
    }
  ],
  "in_city_routes": [
    {
      "day": 1,
      "optimized_order": [
        { "name":"Hallgrímskirkja", "duration":"1h30", "leg_from_prev":"15m desde hotel (A pie/Taxi)" },
        { "name":"Laugavegur", "duration":"1h30", "leg_from_prev":"10m a pie" }
      ],
      "return_to_hotel_duration":"20m Taxi/A pie"
    }
  ],
  "meals_suggestions":[
    { "slot":"almuerzo", "area":"Centro", "type":"local", "duration":"60–90m" }
  ],
  "aurora": {
    "plausible": true,
    "latitude": "≈64.1°N",
    "season_window": "Sep–Mar",
    "typical_tour_windows": ["19:30–00:30","20:30–01:30"],
    "recommended_window": "18:30–01:00",
    "suggested_days": [2,4],
    "row_template": {
      "transport": "Vehículo alquilado o Tour guiado",
      "duration": "Depende del tour o horas que dediques si vas por tu cuenta",
      "note": "Noche especial de caza de auroras. El horario exacto y retorno dependen del tour; si vas por tu cuenta, verifica clima/seguridad en carretera."
    }
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
- Asigna horas razonables **sin imponer un tope fijo** (NO fuerces 19:00): 
  permite extensiones nocturnas si el contenido del día lo amerita.
- Inserta **notas motivadoras breves** en cada fila (sin texto florido).
- Para macro-tours, usa **"Actividad": "Excursión — A / — B / — C ..."** (hasta 8 sub-paradas).
- Respeta preferencias/condiciones del usuario (no sobrecargues días, evita caminatas largas si se indicó, etc.).
- **Auroras**: si "aurora.plausible=true", usa "recommended_window" o una de "typical_tour_windows" del research_json
  para la franja horaria de la fila nocturna, en días sugeridos (no consecutivos y nunca el último día).
  Aplica el "row_template" de research_json (transport/duration/note) y conserva la nota "Depende del tour...".
- Añade **buffers ≥15m** entre filas; evita solapes; permite cruce post-medianoche.

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
      const infoUserMsg = {
        role: "user",
        content: JSON.stringify({ context }, null, 2),
      };

      // 1er intento (normal)
      let raw = await callText(
        [{ role: "system", content: SYSTEM_INFO }, infoUserMsg],
        0.35,
        5200
      );
      let parsed = cleanToJSONPlus(raw);

      // Reintento más estricto si no hay JSON válido
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText(
          [{ role: "system", content: strict }, infoUserMsg],
          0.25,
          4800
        );
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
          latitude: "",
          season_window: "",
          typical_tour_windows: [],
          recommended_window: "",
          suggested_days: [],
          row_template: {
            transport: "Vehículo alquilado o Tour guiado",
            duration: "Depende del tour o horas que dediques si vas por tu cuenta",
            note: "Noche de auroras; el horario exacto y retorno dependen del tour."
          }
        },
        constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true }
      };

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO PLANNER --------------------
    // Entrada esperada: { mode:"planner", research_json:{...}, city?: "..." }
    if (mode === "planner") {
      const research = body.research_json || null;

      // Permitir también flujo legado (messages), pero preferimos research_json directo
      if (!research) {
        const clientMessages = extractMessages(body);
        let raw = await callText(
          [{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages],
          0.35,
          4200
        );
        let parsed = cleanToJSONPlus(raw);
        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText(
            [{ role: "system", content: strict }, ...clientMessages],
            0.25,
            3800
          );
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

      let raw = await callText(
        [{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg],
        0.35,
        4200
      );
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText(
          [{ role: "system", content: strict }, plannerUserMsg],
          0.25,
          3800
        );
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

    return res.status(400).json({ error: "Invalid mode" });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
