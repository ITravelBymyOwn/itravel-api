// /api/chat.js — v42.6.2 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y calcula) → (2) PLANNER (estructura).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ============== Utilidades comunes ============== */
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

// Normalizador de duraciones dentro del JSON ya parseado
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

/* ============== Prompts del sistema ============== */

/**
 * 1) SISTEMA — INFO CHAT (interno)
 * - Genera TODO el contenido “masticado” que el Planner solo acomodará.
 * - Reglas duras de comidas y ventanas por día.
 * - AURORAS: no consecutivas y nunca el último día; ventana concreta; cena fuera del bloque de auroras.
 * - Day-trips: deben terminar con regreso a la ciudad base (un solo regreso por día).
 */
const SYSTEM_INFO = `
Eres el **motor de investigación** de ITravelByMyOwn (Info Chat interno). Eres el mayor experto mundial en turismo y seguridad de viaje.

ENTRADA
Recibes un objeto "context" con TODOS los datos del planner para un destino:
- city, country, fechas exactas, days_total
- hotel_base (dirección o nombre)
- grupo de viajeros (edades), ritmo, presupuesto
- PREFERENCIAS y CONDICIONES del usuario (PRIORIDAD MÁXIMA)
- transporte disponible/preferido
- ciudades previa/siguiente (si aplica)
- notas del usuario
- reglas globales (p.ej., max_substops_per_tour=8)
- user_day_hours opcional por día: { "1": {"start":"HH:MM","end":"HH:MM"}, ... }

OBJETIVO
1) Seleccionar imperdibles por zonas y planear macro-tours solo cuando aporten valor, optimizando distancias/tiempos y evitando sobrecarga.
2) AURORAS (si aplica por latitud/temporada):
   - Días NO consecutivos y NUNCA el último día del viaje.
   - Ventana local concreta (p. ej., 21:00–02:30) y duración típica "4h".
   - transport_default y nota estándar (sujeto a clima; mejor en áreas oscuras).
3) HORARIOS:
   - Respeta user_day_hours si existen; si faltan, propone horarios plausibles por día.
   - Cada day-trip termina con **un único** "regreso a la ciudad/hotel".
   - No planifiques actividades imposibles por clima/estación.
4) LAGUNAS TERMALES: mínimo **3h** efectivas en sitio y evitar pegarlas a una actividad pesada inmediata (deja colchón).
5) RUTAS tipo península o costa con sub-paradas (p.ej., Reykjanes/Snæfellsnes):
   - Devuelve una actividad madre con 5–8 sub-paradas en orden lógico
   - Incluye return_to_city_duration aproximado.

COMIDAS (REGLAS DURAS — NO inventes fuera de estas ventanas)
- Duraciones fijas: **desayuno 1h**, **almuerzo 1h**, **cena 2h**.
- Ventanas locales recomendadas (ajústalas si el usuario define otras):
  * Desayuno: 07:00–09:00
  * Almuerzo: 12:00–14:30
  * Cena: 19:00–21:30 (nunca empieza después de 21:30).
- Si hay auroras en un día, la cena debe quedar **fuera** de la ventana de auroras (terminar antes de que empiece el bloque de auroras).
- NUNCA cruces medianoche con comidas. No programes comidas entre 22:30 y 06:00.

SALIDA ÚNICA — Devuelve **solo JSON válido** (sin texto fuera) con:
{
  "destination": "Ciudad",
  "country": "País",
  "days_total": 5,
  "hotel_base": "Nombre/Dirección",
  "rationale": "Por qué este orden/ruta",
  "imperdibles": [...],
  "macro_tours": [...],         // actividades madre con sub-paradas (≤8)
  "in_city_routes": [...],
  "meals_suggestions": [
    // Puedes listar tips de comida por zona/día, pero las comidas principales deben ir en rows_skeleton.
  ],
  "aurora": {
    "plausible": true|false,
    "suggested_days": [2,4],
    "window_local": { "start": "21:00", "end": "02:30" },
    "transport_default": "Vehículo alquilado o Tour guiado",
    "note": "Actividad sujeta a clima; mejor en áreas oscuras",
    "duration": "4h"
  },
  "constraints": {
    "max_substops_per_tour": 8,
    "avoid_duplicates_across_days": true,
    "optimize_order_by_distance_and_time": true,
    "respect_user_preferences_and_conditions": true
  },
  "day_hours": [
    // Opcional: si defines los rangos por día.
    // { "day": 1, "start": "08:30", "end": "19:00" }
  ],
  "rows_skeleton": [
    // Devuelve aquí todas las filas propuestas del itinerario, incluyendo COMIDAS dentro de sus ventanas y con las DURACIONES fijas.
    // Si ya conoces horarios, incluye start/end; si no, deja solo "duration" y "kind".
    // Ejemplo de comidas:
    // { "day": 1, "kind":"meal", "meal":"desayuno", "from":"Hotel", "to":"Restaurante local", "duration":"1h" }
    // { "day": 1, "kind":"meal", "meal":"almuerzo", "from":"Zona X", "to":"Restaurante local", "duration":"1h" }
    // { "day": 1, "kind":"meal", "meal":"cena", "from":"Centro", "to":"Restaurante local", "duration":"2h" }
  ]
}
OBLIGATORIO:
- Incluir las 3 comidas por día (según preferencias del usuario si las especifica).
- Respetar ventanas y duraciones de COMIDAS indicadas.
- Si hay AURORAS en un día, ubicar la CENA antes de la ventana de auroras.
- Los day-trips deben cerrar con un único “Regreso a <Ciudad base/Hotel>”.
`.trim();

/**
 * 2) SISTEMA — PLANNER (estructura)
 * - Transforma research_json en {"destination","rows":[...]} sin creatividad adicional.
 * - Respeta ventanas/horas provistas y NO altera auroras ni comidas (ya vienen del Info con reglas duras).
 * - Macro-tours: actividad madre con ≤8 sub-paradas; no agregar transporte “post retorno”.
 * - Lagunas: asegura ≥3h si el skeleton viniera menor.
 */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat interno con datos fácticos
(decisiones, tiempos, regreso al hotel, ventanas de auroras, day_hours y/o start/end por actividad, y COMIDAS ya validadas).

TU TAREA:
- Convertir research_json en {"destination","rows":[...]} sin creatividad adicional.
- Si un ítem de rows_skeleton trae "start/end" ⇒ úsalo tal cual.
- Si NO trae "start/end" ⇒ asígnalo dentro del rango research_json.day_hours del día (si existe) sin violar la ventana de AURORAS ni las ventanas de COMIDAS.
- Respeta horas MANDATORIAS del usuario. No impongas 08:30–19:00 por defecto.
- Auroras: usa la ventana exacta definida por Info (días no consecutivos, nunca el último).
- Macro-tours: actividad madre “Excursión — … — A → B → C” (≤8 sub-paradas) y **no** añadir transporte tras "return_to_city_duration".
- Lagunas termales: garantizar **≥3h** efectivas si el skeleton fuese menor.
- Inserta notas motivadoras breves (basadas en kind: icónico, macro_tour, aurora, meal, etc.).

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

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req.body);
    const mode = (body.mode || "planner").toLowerCase();

    /* --------- MODO INFO (motor interno) --------- */
    if (mode === "info") {
      const context = body.context || {};
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      let raw = await callText(
        [{ role: "system", content: SYSTEM_INFO }, infoUserMsg],
        0.3,
        3400
      );
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3000);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) {
        // Fallback mínimo coherente con Sección 18
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

      // Normalización suave (decimales → h/m, etc.)
      parsed = normalizeDurationsInParsed(parsed);

      // Salida estable para el planner (info interna)
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      const research = body.research_json || null;

      // Camino legado (mensajes del cliente, sin research_json)
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

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Respuesta de compatibilidad para el Planner
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
