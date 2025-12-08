// /api/chat.js — v42.6 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y calcula) → (2) PLANNER (estructura).
// Respeta estrictamente preferencias/condiciones del usuario. Salidas SIEMPRE en { text: "<JSON|texto>" }.

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =============== Utilidades comunes ===============
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try { return JSON.parse(reqBody); } catch { return {}; }
  }
  return reqBody;
}
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Limpia y extrae un único JSON de un texto (tolerante a prólogos/epílogos)
function cleanToJSONPlus(raw = "") {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;

  // 1) Intento directo
  try { return JSON.parse(raw); } catch {}

  // 2) Primer/último corchete
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
  } catch {}

  // 3) Recorte de ruido en extremos
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

// Llamada unificada a Responses API (entrada como string consolidado)
async function callText(messages, temperature = 0.35, max_output_tokens = 3200) {
  const inputStr = messages
    .map(m => `${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n\n");

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: inputStr,
  });

  return (
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    ""
  );
}

// 🆕 Normalizador de duraciones dentro del JSON ya parseado
function normalizeDurationsInParsed(parsed){
  if(!parsed) return parsed;

  const norm = (txt)=>{
    const s = String(txt ?? "").trim();
    if(!s) return s;

    // Acepta formatos: "1.5h", "1h30", "1 h 30", "90m", "~7h", "2h"
    // No tocamos si empieza con "~"
    if (/^~\s*\d+(\.\d+)?\s*h$/i.test(s)) return s;

    // 1.5h → 1h30m
    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if(dh){
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours*60);
      const h = Math.floor(total/60);
      const m = total%60;
      return h>0 ? (m>0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }

    // 1h30 ó 1 h 30 → 1h30m
    const hMix = s.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if(hMix){
      return `${hMix[1]}h${hMix[2]}m`;
    }

    // 90m → 90m (ya está bien)
    if (/^\d+\s*m$/i.test(s)) return s;

    // 2h → 2h (ya está bien)
    if (/^\d+\s*h$/i.test(s)) return s;

    return s;
  };

  const touchRows = (rows=[]) => rows.map(r=>({ ...r, duration: norm(r.duration) }));

  try{
    if(Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);
    if(Array.isArray(parsed.destinations)){
      parsed.destinations = parsed.destinations.map(d=>({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows
      }));
    }
    if(Array.isArray(parsed.itineraries)){
      parsed.itineraries = parsed.itineraries.map(it=>({
        ...it,
        rows: Array.isArray(it.rows) ? touchRows(it.rows) : it.rows
      }));
    }
  }catch{}

  return parsed;
}

// =============== Prompts del sistema ===============

/**
 * 1) SISTEMA — INFO CHAT (interno)
 * - Genera TODO el contenido “masticado” que el Planner solo acomodará (misma “mente” que Info Chat externo).
 * - Horarios:
 *    • Si el usuario dio horas de inicio/fin por día ⇒ MANDATORIAS.
 *    • Si NO las dio ⇒ recomienda horas realistas por día y por actividad (experto en turismo global).
 * - Entrega también rows_skeleton ya con start/end cuando corresponda (o day_hours por día para que el Planner pueda asignar).
 * - Reglas explícitas incluidas: AURORAS (días no consecutivos, evitar último día), REYKJANES sub-paradas (≤8), LAGUNAS ≥3h y no pegadas a actividad pesada inmediata.
 */
const SYSTEM_INFO = `
Eres el **motor de investigación** de ITravelByMyOwn (Info Chat interno). Actúas como un experto en turismo internacional.

ENTRADA:
Recibes un objeto "context" con TODOS los datos del planner para una ciudad:
- city, country, fechas exactas, days_total
- hotel_base (dirección o nombre)
- grupo de viajeros (edades), ritmo, presupuesto
- PREFERENCIAS y CONDICIONES especiales del usuario (PRIORIDAD MÁXIMA)
- transporte disponible/preferido
- ciudades previa/siguiente (si aplica)
- notas del usuario
- reglas globales (p.ej., max_substops_per_tour=8)
- user_day_hours (mapa opcional con horas mandatorias por día: { "1": {"start":"HH:MM","end":"HH:MM"}, ... })

OBJETIVO:
1) Tomar decisiones con libertad e inteligencia:
   - Imperdibles por zonas.
   - Macro-tours (solo si aportan más valor que quedarse en ciudad y respetan condiciones).
   - Tiempos REALES entre puntos y regreso al hotel (duraciones tipo "45m", "1h15", "2h").
   - Rutas en ciudad por día, sin sobrecargar.
   - Comidas/descansos icónicos cuando tenga sentido (duración 60–90m o lo indicado por usuario).
2) AURORAS (si aplica por latitud/temporada y fechas):
   - Determina si es plausible.
   - Devuelve ventana local concreta {start,end}.
   - Sugiere días NO consecutivos y NUNCA el último día.
   - Define transport_default, note estándar y duration textual.
3) HORARIOS:
   - Si el usuario ESPECIFICÓ horas de inicio/fin por día (user_day_hours) ⇒ **MANDATORIAS** (respétalas).
   - Si NO hay horas del usuario ⇒ **recomienda horas realistas** por día y por actividad según el destino/época y la logística (no impongas 08:30–19:00).
   - Para macro-tours, bloquea el rango lógico como una sola actividad madre y devuelve return_to_city_duration.
   - Para auroras, usa la ventana exacta (ej. 20:30–01:30) y marca "kind":"aurora".
4) LAGUNAS TERMALES (Blue Lagoon / Secret Lagoon / Sky Lagoon, etc.):
   - **Duración mínima 3h efectivas en sitio** (sin contar traslados).
   - Evitar pegarlas inmediatamente a otra actividad "pesada" (ballenas, glaciares, trekking largo) en la misma mañana/tarde.
   - Si el usuario puso hora fija de entrada, respétala y ajusta salida para alcanzar ≥3h.
5) REYKJANES / RUTAS CON SUB-PARADAS:
   - Si hay day-trip a Reykjanes (o rutas similares), devuelve **una actividad madre** con **5–8 sub-paradas** canónicas en orden lógico (≤8 total).
   - Incluye "return_to_city_duration".
6) SALIDA: un ÚNICO **JSON válido** que el Planner usará directamente sin creatividad adicional.

SALIDA — JSON ÚNICO (sin texto fuera):
{
  "destination": "Ciudad",
  "country": "País",
  "days_total": 5,
  "hotel_base": "Nombre o dirección del hotel",
  "rationale": "Por qué este orden/selección, considerando preferencias/condiciones, en breve.",
  "imperdibles": [
    { "name":"...", "type":"museo|mirador|barrio|parque|icónico|kids", "area":"...", "must_see": true }
  ],
  "macro_tours": [
    {
      "name":"Excursión — Nombre",
      "typical_transport":"Vehículo alquilado o Tour guiado",
      "substops":[
        { "name":"Parada A", "duration":"1h15", "leg_from_prev":"30m Vehículo" }
      ],
      "return_to_city_duration":"2h Vehículo",
      "why":"Motivo resumido"
    }
  ],
  "in_city_routes":[
    {
      "day": 1,
      "optimized_order":[
        { "name":"Punto A", "duration":"45m", "leg_from_prev":"15m desde hotel (A pie/Taxi)" },
        { "name":"Punto B", "duration":"40m", "leg_from_prev":"10m a pie" }
      ],
      "return_to_hotel_duration":"20m Taxi/A pie"
    }
  ],
  "meals_suggestions":[
    { "slot":"almuerzo", "area":"Centro", "type":"local", "duration":"60–90m" }
  ],
  "aurora": {
    "plausible": false,
    "suggested_days": [],
    "window_local": { "start":"", "end":"" },
    "transport_default": "",
    "note": "Actividad sujeta a clima; depende del tour",
    "duration": "Depende del tour o horas que dediques si vas por tu cuenta"
  },
  "constraints": {
    "max_substops_per_tour": 8,
    "avoid_duplicates_across_days": true,
    "optimize_order_by_distance_and_time": true,
    "respect_user_preferences_and_conditions": true
  },

  // Recomendación de horas por DÍA (si el usuario no dio horas). Si el usuario sí dio horas, replica aquí las del usuario:
  "day_hours": [
    { "day": 1, "start": "09:00", "end": "18:30" },
    { "day": 2, "start": "08:15", "end": "19:30" }
  ],

  // Esqueleto de filas listo para que el Planner SOLO acomode y añada notas (si hay horas conocidas, inclúyelas; si no, omítelas):
  "rows_skeleton":[
    {
      "day": 1,
      "activity": "Visita a Punto A",
      "from": "Hotel",
      "to": "Punto A",
      "transport": "A pie / Taxi / Metro",
      "duration": "45m",
      "leg_from_prev": "15m desde hotel (A pie/Taxi)",
      "kind": "icónico",
      "start": "09:15",
      "end": "10:00"
    },
    {
      "day": 2,
      "activity": "Excursión — Ruta — A → B → C",
      "from": "Hotel",
      "to": "Ruta",
      "transport": "Vehículo alquilado o Tour guiado",
      "duration": "8h",
      "leg_from_prev": "Salida desde hotel",
      "kind": "macro_tour",
      "return_to_city_duration": "1h45 Vehículo",
      "substops":[ { "name":"A","duration":"45m" }, { "name":"B","duration":"50m" } ],
      "start": "08:00",
      "end": "17:00"
    },
    {
      "day": 2,
      "activity":"Auroras boreales",
      "from":"Hotel",
      "to":"Puntos de observación (variable)",
      "transport":"Vehículo alquilado o Tour guiado",
      "duration":"Depende del tour o horas que dediques si vas por tu cuenta",
      "leg_from_prev":"Según ventana nocturna",
      "kind":"aurora",
      "aurora_window": { "start":"20:30", "end":"01:30" },
      "note":"Actividad sujeta a clima; depende del tour"
    },
    {
      "day": 3,
      "activity":"Blue Lagoon",
      "from":"Hotel",
      "to":"Blue Lagoon",
      "transport":"Vehículo alquilado o Tour guiado",
      "duration":"3h", // mínimo 3h efectivas
      "kind":"termal_spa",
      "note":"Reserva con antelación; lleva traje de baño."
    }
  ]
}

REGLAS CLAVE:
- Responde SOLO con un JSON válido.
- No inventes enlaces ni operadores concretos; sí incluye ventanas horarias típicas y duraciones realistas.
- Respeta horas MANDATORIAS del usuario (user_day_hours); en su ausencia, recomienda "day_hours" y/o "start/end" en cada ítem de rows_skeleton.
- Evita duplicar lugares entre días. Macro-tours con sub-paradas (máx. 8).
- Para auroras: días no consecutivos y nunca el último día; usa su ventana exacta.
- Para lagunas termales: duración mínima 3h efectivas y evita encadenarlas a actividades pesadas inmediatas.
`.trim();

/**
 * 2) SISTEMA — PLANNER (estructura, sin imponer 08:30–19:00)
 * - Usa horarios ya provistos por Info Chat (rows_skeleton.start/end) o, si faltan, usa day_hours por día.
 * - Si el usuario dio horas mandatorias (reflejadas por Info Chat), se respetan tal cual.
 * - Crea filas con notas motivadoras cortas; NO altera ventanas de auroras.
 * - No agrega transporte "post excursión" después del retorno.
 */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat interno con datos fácticos
(decisiones, tiempos, regreso al hotel, ventanas de auroras, day_hours y/o start/end por actividad).

TU TAREA:
- Convertir research_json en {"destination","rows":[...]} sin creatividad adicional.
- **NO inventes** destinos ni tiempos: usa exactamente lo que venga en rows_skeleton y/o day_hours.
- HORARIOS:
  - Si un ítem de rows_skeleton trae "start" y "end" ⇒ úsalo tal cual.
  - Si NO trae "start/end" ⇒ asigna dentro del rango del día indicado en research_json.day_hours (o, en su ausencia, distribuye razonablemente según las duraciones y legs).
  - Respeta horas MANDATORIAS del usuario (transmitidas por Info Chat). No impongas 08:30–19:00 por defecto.
- **Auroras**:
  - Si research_json.aurora.window_local existe, usa esa ventana exacta (start/end) para su(s) fila(s).
  - Días sugeridos NO consecutivos y nunca el último día (ya decidido por Info Chat). No cueles auroras fuera de esa ventana.
- **Macro-tours**:
  - Pinta una actividad madre “Excursión — … — A → B → C” (hasta 8 sub-paradas).
  - **NO** agregues nuevo transporte “post excursión” después de "return_to_city_duration".
- **Lagunas termales**:
  - Asegura **≥3h** efectivas en sitio (si la duración del skeleton fuera menor, ajusta a 3h).
- **Notas**:
  - Inserta notas motivadoras breves y variadas en cada fila (sin texto florido). Puedes basarte en el "kind" del skeleton (icónico, macro_tour, aurora, paseo, kids, comida, descanso).

FORMATO ÚNICO (JSON válido, sin texto adicional):
{
  "destination":"Ciudad",
  "rows":[
    {
      "day":1,
      "start":"09:15",
      "end":"10:00",
      "activity":"Visitar X",
      "from":"Hotel",
      "to":"X",
      "transport":"A pie / Metro / Tren / Taxi / Vehículo alquilado o Tour guiado",
      "duration":"45m",
      "notes":"Consejo breve y motivador"
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

    const body = parseBody(req.body);
    const mode = (body.mode || "planner").toLowerCase();

    // -------------------- MODO INFO --------------------
    if (mode === "info") {
      const context = body.context || {};
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      let raw = await callText(
        [{ role: "system", content: SYSTEM_INFO }, infoUserMsg],
        0.35,
        3500
      );
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) {
        // Fallback mínimo coherente con lo que espera la Sección 18
        parsed = {
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
          constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true },
          day_hours: [],
          rows_skeleton: []
        };
      }

      // 🆕 normalización suave (decimales → h/m, etc.)
      parsed = normalizeDurationsInParsed(parsed);

      // **Salida estable para Info Chat externo e interno**
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO PLANNER --------------------
    if (mode === "planner") {
      const research = body.research_json || null;

      // Camino legado (mensajes del cliente)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText(
          [{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages],
          0.35,
          3500
        );
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 3000);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();

        // 🆕 normalización suave
        parsed = normalizeDurationsInParsed(parsed);

        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json directo)
      const plannerUserMsg = { role: "user", content: JSON.stringify({ research_json: research }, null, 2) };

      let raw = await callText(
        [{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg],
        0.35,
        3500
      );
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3000);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = fallbackJSON();

      // 🆕 normalización suave
      parsed = normalizeDurationsInParsed(parsed);

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    // -------------------- MODO LEGADO "text" --------------------
    if (mode === "text") {
      const clientMessages = extractMessages(body);
      const raw = await callText(clientMessages, 0.5, 2000);
      return res.status(200).json({ text: raw || "" });
    }

    return res.status(400).json({ error: "Invalid mode" });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Respuesta de compatibilidad para el Planner/Info Chat
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
