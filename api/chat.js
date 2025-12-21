// /api/chat.js — v43.2 (ESM, Vercel)
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

  // 2) Primer/último { }
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  } catch {}

  // 3) Recorte de ruido
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
        duration: "Transporte: \nActividad: ",
        notes: "Explora libremente la ciudad.",
        kind: "",
        zone: "",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o despliegue.",
  };
}

// Llamada unificada a Responses API (entrada como string consolidado)
async function callText(messages, temperature = 0.35, max_output_tokens = 3200) {
  const inputStr = messages
    .map((m) => {
      const c =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
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
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s = String(txt ?? "").trim();
    if (!s) return s;

    // IMPORTANTE:
    // Si viene en formato "Transporte: ...\nActividad: ...", lo dejamos intacto.
    if (/^Transporte\s*:/i.test(s) || /^Actividad\s*:/i.test(s)) return s;

    // No tocamos si empieza con "~"
    if (/^~\s*\d+(\.\d+)?\s*h$/i.test(s)) return s;

    // 1.5h → 1h30m
    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if (dh) {
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours * 60);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }

    // 1h30 ó 1 h 30 → 1h30m
    const hMix = s.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if (hMix) return `${hMix[1]}h${hMix[2]}m`;

    // 90m → 90m
    if (/^\d+\s*m$/i.test(s)) return s;

    // 2h → 2h
    if (/^\d+\s*h$/i.test(s)) return s;

    return s;
  };

  const touchRows = (rows = []) =>
    rows.map((r) => ({ ...r, duration: norm(r.duration) }));

  try {
    if (Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);
    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows,
      }));
    }
    if (Array.isArray(parsed.itineraries)) {
      parsed.itineraries = parsed.itineraries.map((it) => ({
        ...it,
        rows: Array.isArray(it.rows) ? touchRows(it.rows) : it.rows,
      }));
    }
  } catch {}

  return parsed;
}

/* ============== Prompts del sistema ============== */

/* =======================
   SISTEMA — INFO CHAT (interno)
   ======================= */
const SYSTEM_INFO = `
Eres el **motor de investigación y decisión** de ITravelByMyOwn (Info Chat interno) y un **experto internacional en turismo**.
Tu salida será consumida por un Planner que SOLO acomoda lo que tú decides. Tu objetivo es un itinerario **viable, optimizado y secuencial** (mínimo ida/vuelta), maximizando el aprovechamiento del viaje.

REGLAS BASE:
- Devuelve **UN ÚNICO JSON VÁLIDO** (sin texto fuera).
- Tú decides: actividades, orden, tiempos realistas, transporte, colas/tickets, buffers, clusters por zona.
- Respeta preferencias/condiciones del usuario (movilidad, niños, clima, ritmo, presupuesto, etc.).
- Evita solapes: una actividad no puede ocurrir al mismo tiempo que otra.
- Evita pérdidas de tiempo: NO diseñes rutas con “volver al mismo lugar” sin razón; agrupa por vecindarios/zonas.
- NO generes duplicados bilingües del mismo tour/actividad (ej: NO "Golden Circle Tour" y "Tour del Círculo Dorado" a la vez).

COMPRENSIÓN DE UBICACIONES “HUMANAS” (CRÍTICO):
- Si el usuario describe ubicaciones por referencia (“la iglesia icónica”, “el puerto viejo”, “la plaza principal”, “el mirador famoso”, “cerca del estadio”, etc.), debes **inferir el POI más probable** en esa ciudad y usarlo coherentemente en from/to/zone/notes.
  Ejemplo: en Reykjavik, “la iglesia icónica” => Hallgrímskirkja. Haz lo mismo para cualquier ciudad del mundo.

MULTI-DÍA EN CIUDAD (CRÍTICO):
- Si days_total > 1, está PROHIBIDO repetir el mismo “loop” base (ej: mismo café + misma calle + mismo museo) en varios días.
- Distribuye imperdibles por días y alterna zonas/barrios.
- Incluye variedad real: 1 día histórico/céntrico, 1 día arte/museos, 1 día waterfront/arquitectura, 1 día termas o experiencia local, etc. (según ciudad/estación).
- Mantén 1 bloque “flex” moderado (descanso/compras) si el ritmo lo amerita, pero NO conviertas todos los días en clones.

HORARIOS (CRÍTICO):
- Si el usuario NO provee horas, tú tienes libertad de proponer day_hours realistas según estación/ciudad/ritmo:
  - Invierno: inicio más tarde suele ser razonable (p.ej. 09:00–10:00), cena 19:00–21:30 aprox.
  - Siempre buffers mínimos 15m entre traslados/entradas.
- NO asumas por defecto 08:30–19:00 si no hay una razón explícita.

DURACIÓN EN 2 LÍNEAS (NUEVO):
- En cada fila (row), el campo "duration" debe venir SIEMPRE como 2 líneas:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
  Ejemplos:
  - "Transporte: 15m\\nActividad: 1h30m"
  - Si es caminando corto: "Transporte: 10m\\nActividad: 45m"
  - Si no hay traslado (misma zona): "Transporte: 0m\\nActividad: 1h"

Macro-tours / day-trips (CRÍTICO):
- Si incluyes un macro-tour en un día, ese día debe quedar “ocupado” por el tour:
  - Puede haber desayuno antes y cena después (cerca de base), pero NO metas visitas dentro del bloque del tour.
- 5–8 sub-paradas + return_to_city_duration.
- Incluye explícitamente “Regreso a {ciudad}” al cierre del day-trip si aplica.

Auroras (si aplica):
- NO consecutivas, NUNCA último día.
- Ventana local exacta, duración y transporte.
- Si propones aurora, nota específica accionable (tour recomendado, evitar luz, revisar nubosidad/actividad).

Lagunas:
- ≥3h efectivas (actividad).

NOTAS:
- Deben ser concretas y útiles (1–2 frases), accionables (reserva, ticket, mejor hora, por qué ese orden).
- Evita “verifica horarios” repetido en todas.

SALIDA (JSON):
{
  "destination":"Ciudad",
  "country":"País",
  "days_total":1,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":[],
  "macro_tours":[],
  "in_city_routes":[],
  "meals_suggestions":[],
  "aurora":{
    "plausible":false,
    "suggested_days":[],
    "window_local":{"start":"","end":""},
    "duration":"~3h–4h",
    "transport_default":"Vehículo alquilado o Tour guiado",
    "note":"..."
  },
  "constraints":{
    "max_substops_per_tour":8,
    "avoid_duplicates_across_days":true,
    "optimize_order_by_distance_and_time":true,
    "respect_user_preferences_and_conditions":true,
    "no_consecutive_auroras":true,
    "no_last_day_aurora":true,
    "thermal_lagoons_min_stay_minutes":180
  },
  "day_hours":[{"day":1,"start":"HH:MM","end":"HH:MM"}],
  "rows_skeleton":[
    {"day":1,"start":"","end":"","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}
  ]
}
`.trim();

/* =======================
   SISTEMA — PLANNER (estructurador)
   ======================= */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un "research_json" del Info Chat interno con decisiones cerradas.
Tu trabajo es **estructurar** en el formato final **sin creatividad adicional** (NO inventes actividades nuevas),
PERO SÍ debes **garantizar consistencia**, evitar duplicados y evitar solapes.

SALIDA ÚNICA (JSON):
{
  "destination":"Ciudad",
  "rows":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}
  ],
  "followup":""
}

REGLAS:
- JSON válido, sin texto fuera.
- NO inventes tours nuevos. NO dupliques el mismo tour/actividad en dos idiomas.
- NO repitas el mismo “loop” en varios días si days_total>1 (usa la intención del research_json).
- Evita solapes: si dos filas se pisan en tiempo, debes ajustar/eliminar/reordenar de forma mínima para que NO se solapen.
- Duración (OBLIGATORIO): el campo "duration" debe venir en 2 líneas:
  "Transporte: <tiempo>\\nActividad: <tiempo>"
- Si rows_skeleton trae start/end => respétalo.
- Si no trae start/end:
  - Si existe day_hours del día, asigna dentro de esa ventana con buffers ≥15m.
  - Si NO existe day_hours (usuario no dio horarios), puedes escoger una ventana realista (no fija 08:30–19:00) y luego asignar dentro.

MACRO-TOURS / DAY-TRIPS (CRÍTICO):
- Si el research_json implica un macro-tour para un día, ese bloque domina el día:
  - Es válido conservar desayuno antes y cena después, pero debes ELIMINAR cualquier fila existente que caiga dentro del bloque del tour.
  - Debes incluir “Regreso a {ciudad}” al final del day-trip si aplica.

EXISTING_ROWS:
- Si viene "existing_rows" para un día, úsalo como contexto para NO repetir y para mantener coherencia,
  pero tienes permiso de **reemplazar/eliminar** filas conflictivas para cumplir el research_json (especialmente con macro-tours).
- No “concatentes” un tour encima de un día completo ya lleno si eso produce solapes.

MODO ACOTADO:
- Si el input incluye "target_day", devuelve **SOLO filas de ese día** (todas con day=target_day).
- Además, si incluye "day_hours", úsalo para fijar la ventana de ese día.
`.trim();

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const mode = String(body.mode || "planner").toLowerCase();

    /* --------- MODO INFO (motor interno) --------- */
    if (mode === "info") {
      // Soporta:
      //  A) { mode:"info", context:{...} }
      //  B) { mode:"info", messages:[...] }  (cuando el frontend lo manda así)
      //  C) { mode:"info", ...contextPlano } (algunos builds)
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        // Si viene plano, tratamos todo el body como contexto menos mode
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3500);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) {
        parsed = {
          destination: context?.city || "Destino",
          country: context?.country || "",
          days_total: context?.days_total || 1,
          hotel_base: context?.hotel_address || context?.hotel_base || "",
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
            duration: "Depende del tour o horas que dediques si vas por tu cuenta",
          },
          constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true },
          day_hours: [],
          rows_skeleton: [],
        };
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      const research = body.research_json || null;

      // Camino legado (mensajes del cliente, sin research_json)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.35, 3500);
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
      // ✅ PATCH QUIRÚRGICO: incluir target_day, day_hours y existing_rows si vienen
      const plannerUserMsg = {
        role: "user",
        content: JSON.stringify(
          {
            research_json: research,
            target_day: body.target_day ?? null,
            day_hours: body.day_hours ?? null,
            existing_rows: body.existing_rows ?? null,
          },
          null,
          2
        ),
      };

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3500);
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
    // compat: nunca rompas el planner
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
