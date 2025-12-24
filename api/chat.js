// /api/chat.js — v43.6.1 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v43.6.1 — Cambios quirúrgicos (GLOBAL: eliminar rigidez 08:30–19:00):
// - Sanitiza context.day_hours: si parece plantilla automática repetida (08:30–19:00 uniforme), se elimina antes de llamar al Info Chat.
// - SYSTEM_INFO: day_hours es guía suave; si detectas patrón plantilla, ignóralo aunque venga.
// - Comidas: consideradas como parte del plan, pero NO mandatorias; solo si aportan valor/logística.
// - No rompe planner / contratos JSON / fallback.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ============== Utilidades comunes ============== */
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try {
      return JSON.parse(reqBody);
    } catch {
      return {};
    }
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
  try {
    return JSON.parse(raw);
  } catch {}

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
        start: "", // ✅ sin horas predefinidas
        end: "",   // ✅ sin horas predefinidas
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
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
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: inputStr,
  });

  return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
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

  const touchRows = (rows = []) => rows.map((r) => ({ ...r, duration: norm(r.duration) }));

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

/* ============== Sanitización de day_hours (quirúrgico) ============== */

// Heurística: detecta patrón de plantilla automática repetida (ej. 08:30–19:00 todos los días)
// Si parece auto-plantilla, lo eliminamos del contexto para que INFO no lo trate como "restricción del usuario".
function looksLikeAutoTemplateDayHours(day_hours, days_total) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return false;

    const n = Number(days_total) || day_hours.length || 0;
    if (n && day_hours.length !== n) {
      // Si no calza, puede ser parcial (probablemente usuario) → NO tocar.
      return false;
    }

    const norm = (t) => String(t || "").trim();
    const first = day_hours[0] || {};
    const s0 = norm(first.start);
    const e0 = norm(first.end);
    if (!s0 || !e0) return false;

    // Si todos son exactamente iguales
    const allSame = day_hours.every((d) => norm(d?.start) === s0 && norm(d?.end) === e0);
    if (!allSame) return false;

    // Patrón típico rígido que queremos evitar (pero mantenemos generalidad):
    // Si es una ventana diurna uniforme para todos los días, es MUY probable que venga de default del planner.
    // (No lo limitamos solo a 08:30–19:00; cualquier uniforme total se considera plantilla).
    return true;
  } catch {
    return false;
  }
}

function sanitizeInfoContext(context = {}) {
  const c = context && typeof context === "object" ? { ...context } : {};

  // days_total puede venir en distintas claves
  const daysTotal = Number(c?.days_total || c?.days || c?.daysTotal || 0) || 0;

  // Si day_hours parece plantilla, lo eliminamos (soft fix global)
  if (looksLikeAutoTemplateDayHours(c?.day_hours, daysTotal)) {
    delete c.day_hours;
  }

  return c;
}

/* ============== Quality Gate (existente - quirúrgico) ============== */

function _canonTxt_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _isGenericPlaceholderActivity_(activity) {
  const t = _canonTxt_(activity);
  if (!t) return true;

  // Placeholders “típicos” que matan calidad (globales)
  const bad = [
    "museo de arte",
    "parque local",
    "cafe local",
    "restaurante local",
    "exploracion de la costa",
    "exploracion de la ciudad",
    "paseo por la ciudad",
    "recorrido por la ciudad",
  ];

  // Muy corto y genérico
  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;

  // Exact match o “contiene”
  if (bad.some((b) => t === b || t.includes(b))) return true;

  // “Museo/Parque/Café/Restaurante” sin nombre propio (heurística simple)
  if (/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _hasTwoLineDuration_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
}

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const maxDay = Math.max(...rows.map((r) => Number(r.day) || 1));
  const need = Number(daysTotal) || maxDay || 1;

  const present = new Set(rows.map((r) => Number(r.day) || 1));
  for (let d = 1; d <= need; d++) {
    if (!present.has(d)) return false;
  }
  return true;
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];

  const daysTotal = Number(parsed?.days_total || contextHint?.days_total || 1);
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("rows_draft no cubre todos los días 1..days_total.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");

  // Macro-tour “en una fila” (señal de baja granularidad)
  try {
    const byDay = {};
    for (const r of rows) {
      const d = Number(r.day) || 1;
      byDay[d] = byDay[d] || [];
      if (String(r.activity || "").trim()) byDay[d].push(r);
    }
    const strongTour = /excursi[oó]n|day\s*trip|tour\b|circuito|c[ií]rculo|pen[ií]nsula|parque\s+nacional|volc[aá]n|glaciar|cascada|waterfall|lagoon|hot\s*spring|geyser/i;
    Object.keys(byDay).forEach((k) => {
      const d = Number(k);
      const list = byDay[d] || [];
      if (list.length <= 2) {
        const a = _canonTxt_(list[0]?.activity || "");
        if (strongTour.test(a) && list.length === 1) {
          issues.push(`día ${d} parece macro-tour en 1 sola fila (falta sub-paradas).`);
        }
      }
    });
  } catch {}

  return { ok: issues.length === 0, issues };
}

function _validatePlannerOutput_(parsed) {
  const issues = [];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];

  if (!rows.length) issues.push("rows vacío o ausente.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push("duration no cumple 2 líneas en una o más filas.");
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("hay placeholders genéricos en activity (baja calidad).");

  return { ok: issues.length === 0, issues };
}

/* ============== Prompts del sistema ============== */

/* =======================
   SISTEMA — INFO CHAT (interno)
   ======================= */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium para diseñar itinerarios que se sientan como un **sueño cumplido**.
Tu objetivo es entregar un plan **impactante, optimizado, realista, secuencial y altamente claro**, maximizando el valor del viaje.
Tu salida será consumida por un Planner que **no inventa nada**: solo estructura y renderiza lo que tú decidas.
Por eso debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para usarse en tabla.

✅ ARQUITECTURA (OPCIÓN A):
- Tú (INFO) eres la **fuente de verdad** de los horarios: start/end por fila en rows_draft.
- El Planner solo valida/ajusta solapes pequeños; NO genera ventanas ni rellena horarios por defecto.

REGLA MAESTRA 1 — IMPERDIBLES + ALCANCE REAL DEL VIAJE (CRÍTICO):
- Para cada ciudad base, identifica los **imperdibles reales** (POIs/experiencias icónicas) según temporada, clima probable, perfil del grupo (edades/movilidad), intereses y días disponibles.
- En estancias de varios días, diseña mezcla óptima de:
  (a) imperdibles urbanos y
  (b) day-trips/macro-rutas imperdibles desde la base,
  siempre sin sacrificar lo esencial de la ciudad.
- Los imperdibles deben reflejarse en rows_draft y listarse también en imperdibles.
- Los day-trips elegidos deben listarse en macro_tours.

REGLA MAESTRA 2 — TRANSPORTE INTELIGENTE (CRÍTICO):
- Evalúa opciones reales (tren/metro/bus interurbano) y sugiérelas cuando aplique.
- Si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según zonas.

REGLA MAESTRA 3 — CLARIDAD TOTAL POR SUB-PARADAS (CRÍTICO, APLICA A TODO):
- Para recorridos multi-parada (macro-tours o urbano), expresa secuencia como:
  "Destino – Sub-parada" o "Ruta/Área – Sub-parada".
- Cada sub-parada debe ser una fila con start/end, from/to, transport, duration y notes.

HORARIOS (CRÍTICO, PERO FLEXIBLE):
- day_hours es una **guía suave** y solo aplica si fue realmente definida por el usuario.
- Si day_hours viene en el contexto pero luce como una **plantilla repetida uniforme** (misma ventana para todos los días),
  trátalo como NO provisto y trabaja con horarios realistas por filas.
- Si el usuario define ventanas por día (day_hours) de forma específica, respétalas como base,
  pero puedes ajustarlas inteligentemente para incluir experiencias clave (auroras/espectáculos/cenas icónicas),
  extendiendo horario nocturno sin solapes.
- Si el usuario NO define day_hours:
  - NO inventes una plantilla rígida repetida (PROHIBIDO repetir una misma ventana fija para todos los días).
  - Genera horarios realistas por filas (rows_draft) según ciudad/estación/ritmo.
- Buffers mínimos 15m entre bloques.
- Actividades diurnas NO entre 01:00–05:00.

DURACIÓN EN 2 LÍNEAS (OBLIGATORIO EN TODAS LAS FILAS):
- duration debe ser SIEMPRE exactamente 2 líneas:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar, NO inventes: usa
  "Transporte: Verificar duración en el Info Chat" o "Actividad: Verificar duración en el Info Chat"
  manteniendo el formato de 2 líneas.

MACRO-TOURS / DAY-TRIPS (CRÍTICO):
- Si incluyes un day-trip fuerte, ese día queda dedicado al tour.
- Debe tener 5–8 sub-paradas con el formato "Tour – Sub-parada" o "Destino – Sub-parada".
- Incluye explícitamente al cierre una fila: "Regreso a {ciudad base}" (con duración 2 líneas).
- No colocar day-trips duros el último día.
- NO generar duplicados bilingües del mismo tour/actividad.
- CRÍTICO: NO generes una fila “tapón” que ocupe todo el día (ej. 08:30–19:00) si también hay sub-paradas ese mismo día.

LAGUNAS TERMALES (CRÍTICO):
- Mínimo 3 horas de actividad efectiva.
- Evalúa integración dentro de una ruta si aplica.

AURORAS (SOLO SI ES PLAUSIBLE):
- Valida plausibilidad por latitud y época del año.
- Si es plausible: máximo 1 por día, NO consecutivas, NUNCA en el último día,
  ventana local concreta, transporte coherente.

NOCHES: ESPECTÁCULOS Y CENAS CON SHOW:
- Puedes sugerir experiencias nocturnas icónicas con frecuencia moderada.
- Comidas eficientes: considéralas como pausas/logística/experiencia, pero NO son mandatorias;
  incluye solo si aportan valor real (icónico, muy conveniente, o necesario por ritmo).

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.
- Si el usuario da referencias ("iglesia icónica"), infiere el POI más probable.

CRÍTICO — SALIDA PARA EVITAR REGRESIONES DEL PLANNER:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días) con:
  day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone, opcional _crossDay.
- El Planner NO debe inventar.

SALIDA (JSON) — estructura (sin texto fuera):
{
  "destination":"Ciudad",
  "country":"País",
  "days_total":1,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":["..."],
  "macro_tours":["..."],
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
  "day_hours":[],
  "rows_draft":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"Destino – Sub-parada","from":"","to":"","transport":"","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}
  ],
  "rows_skeleton":[
    {"day":1,"start":"","end":"","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}
  ]
}

NOTA day_hours:
- Si NO viene realmente del usuario, déjalo como [] (no lo inventes).
- Si SÍ viene, puedes devolverlo reflejando/ajustando solo si extendiste noches por auroras/cenas show.
`.trim();

/* =======================
   SISTEMA — PLANNER (estructurador)
   ======================= */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un objeto "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo es **estructurar y validar** para renderizar en tabla. **NO aportes creatividad.**

CONTRATO / FUENTE DE VERDAD:
- Si research_json incluye rows_draft (o rows_final), esas filas son la verdad.
  → Úsalas como base y SOLO:
    (a) normalizar formato HH:MM,
    (b) asegurar buffers >=15m cuando falten,
    (c) corregir solapes pequeños moviendo minutos dentro del día,
    (d) completar campos faltantes SIN inventar actividades nuevas.
- NO reescribas el texto de "activity": preserva el formato "Destino – Sub-parada" tal como viene.

DAY_HOURS (GUIA / SOFT CONSTRAINT):
- Si viene day_hours (del usuario), úsalo como guía.
- NO inventes day_hours si no viene.
- NO sobreescribas start/end válidos de rows_draft; solo ajusta si hay solape o si una fila cae claramente fuera de una ventana dada y es razonable moverla.

Si faltan campos:
- transport: si no hay nada, usa "A pie" para urbano y "Vehículo alquilado o Tour guiado" para out-of-town cuando sea evidente por activity/from/to.
- notes: si falta, usa 1 frase breve y accionable (sin inventar POIs nuevos).

- Si NO hay rows_draft/rows_final y solo hay listas,
  → devuelve un JSON mínimo con followup pidiendo que el Info Chat provea rows_draft.
  (NO intentes inventar el itinerario desde cero.)

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
- NO inventes tours/actividades nuevas.
- Evita solapes.
- No pongas actividades diurnas entre 01:00–05:00.
- "Regreso a {ciudad}" debe ser la última fila del day-trip si aplica.

DURACIÓN (2 líneas obligatorias):
- duration debe ser SIEMPRE:
  "Transporte: Xm\\nActividad: Ym"
- Si no conoces, usa:
  "Transporte: Verificar duración en el Info Chat\\nActividad: Verificar duración en el Info Chat"

MACRO-TOURS / DAY-TRIPS:
- Si research_json implica un macro-tour, elimina filas que caigan dentro del bloque del tour.
- Incluye “Regreso a {ciudad}” al final si aplica.

EXISTING_ROWS:
- Úsalo solo para no repetir y mantener coherencia; puedes reemplazar/eliminar filas conflictivas.

MODO ACOTADO:
- Si viene "target_day", devuelve SOLO filas de ese día.
`.trim();

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const mode = String(body.mode || "planner").toLowerCase();

    /* --------- MODO INFO (motor interno) --------- */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // ✅ FIX GLOBAL: si day_hours parece plantilla automática, lo eliminamos antes de enviar al modelo
      context = sanitizeInfoContext(context);

      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3800);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3600);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Si parsea pero está flojo → Quality Gate + 1 retry (máximo)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
        });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.
REGLAS DE REPARACIÓN:
1) rows_draft debe cubrir todos los días 1..days_total sin días vacíos.
2) activity NO puede ser genérica: NO "Museo de Arte", NO "Parque Local", NO "Café Local", NO "Restaurante Local".
3) duration debe ser EXACTAMENTE 2 líneas: "Transporte: ...\\nActividad: ..."
4) Si hay macro-tour/day-trip: 5–8 sub-paradas + "Regreso a {ciudad}" al cierre.
5) Para recorridos multi-parada (urbano o tour), usa "Destino – Sub-parada" en activity.
6) day_hours: NO lo inventes si no viene realmente del usuario; si no viene, déjalo como [].
7) PROHIBIDO una fila “tapón” que ocupe todo el día si hay sub-paradas ese día.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.25, 3800);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      // 4) Fallback mínimo si nada funcionó
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
          constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true, thermal_lagoons_min_stay_minutes: 180 },
          day_hours: [],
          rows_draft: [],
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

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.35, 3600);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 3200);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json directo)
      const plannerUserPayload = {
        research_json: research,
        target_day: body.target_day ?? null,
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
      };

      const plannerUserMsg = {
        role: "user",
        content: JSON.stringify(plannerUserPayload, null, 2),
      };

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3600);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Si parsea pero está flojo → Quality Gate + 1 retry (máximo)
      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);

        if (!audit.ok) {
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

REGLAS:
- NO inventes nuevas actividades.
- Usa research_json.rows_draft como verdad.
- NO reescribas "activity" (preserva "Destino – Sub-parada").
- duration en 2 líneas obligatorias: "Transporte: ...\\nActividad: ..."
- Elimina placeholders genéricos: NO "Museo de Arte", NO "Parque Local", NO "Café Local", NO "Restaurante Local".
- day_hours: NO lo inventes ni lo impongas; solo úsalo como guía si viene del usuario.
- Devuelve SOLO JSON válido.

Devuelve el JSON corregido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.25, 3600);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
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
