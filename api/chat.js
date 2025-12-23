// /api/chat.js — v43.6 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y calcula) → (2) PLANNER (estructura).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v43.6 — Cambios quirúrgicos (robustez real):
// - Quality Gate INFO endurecido: solapes, buffer >=15m, genéricos ("día libre", "últimos..."),
//   auroras (no consecutivas / no último día / suggested_days coherente), y "día completo" sin granularidad.
// - Planner determinístico cuando hay research_json.rows_draft: NO LLM; solo normaliza + anti-solape + buffer.
// - Mantiene contratos y camino legado del PLANNER por mensajes si research_json no existe.

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

/* ============== Tiempo / horarios (helpers) ============== */
function _toInt_(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function _parseHHMM_(s) {
  const m = String(s || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = _toInt_(m[1], -1);
  const mm = _toInt_(m[2], -1);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function _fmtHHMM_(mins) {
  let m = _toInt_(mins, 0);
  if (m < 0) m = 0;
  if (m > 24 * 60 - 1) m = 24 * 60 - 1;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function _normalizeHHMMOrKeep_(s) {
  const t = _parseHHMM_(s);
  return t == null ? String(s || "").trim() : _fmtHHMM_(t);
}

function _inForbiddenNightWindow_(startMin, endMin) {
  // Actividades diurnas NO entre 01:00–05:00 (si se detecta dentro de ese rango)
  // Permitimos cruces por medianoche si _crossDay viene, pero aquí solo auditamos fuerte.
  const a = _toInt_(startMin, -1);
  const b = _toInt_(endMin, -1);
  if (a < 0 || b < 0) return false;
  // Si está completamente dentro 01:00–05:00
  const w1 = 60; // 01:00
  const w2 = 300; // 05:00
  return a >= w1 && b <= w2;
}

function _durationMinutes_(startStr, endStr) {
  const a = _parseHHMM_(startStr);
  const b = _parseHHMM_(endStr);
  if (a == null || b == null) return null;
  // Si cruzó medianoche, lo consideramos +24h
  if (b < a) return b + 1440 - a;
  return b - a;
}

/* ============== Llamada a Responses API (entrada como string consolidado) ============== */
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

/* ============== Normalizador de duraciones dentro del JSON ya parseado ============== */
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s = String(txt ?? "").trim();
    if (!s) return s;

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
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = touchRows(parsed.rows_draft);
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

/* ============== Quality Gate (mejorado - quirúrgico) ============== */
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

  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;
  if (bad.some((b) => t === b || t.includes(b))) return true;
  if (/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _isTooGenericMetaDay_(activity) {
  const t = _canonTxt_(activity);
  if (!t) return true;
  // Estas frases rompen tu intención premium y el prompt (aunque no estén en "bad")
  const badMeta = [
    "dia libre",
    "dia libre para explorar",
    "ultimos momentos en la ciudad",
    "ultimas compras",
    "explora a tu ritmo",
    "tiempo libre",
    "manana libre",
    "tarde libre",
  ];
  return badMeta.some((b) => t === b || t.includes(b));
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

function _groupByDay_(rows = []) {
  const byDay = {};
  for (const r of rows) {
    const d = Number(r.day) || 1;
    byDay[d] = byDay[d] || [];
    byDay[d].push(r);
  }
  return byDay;
}

function _sortByStart_(rows = []) {
  return [...rows].sort((a, b) => {
    const sa = _parseHHMM_(a.start);
    const sb = _parseHHMM_(b.start);
    if (sa == null && sb == null) return 0;
    if (sa == null) return 1;
    if (sb == null) return -1;
    return sa - sb;
  });
}

function _detectOverlapsAndBuffers_(rowsForDay, minBuffer = 15) {
  const issues = [];
  const list = _sortByStart_(rowsForDay || []);
  let prevEnd = null;

  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const s = _parseHHMM_(r.start);
    const e = _parseHHMM_(r.end);
    if (s == null || e == null) continue;

    // Prohibido 01:00–05:00 (si no es crossDay)
    if (!_canonTxt_(r._crossDay).includes("true") && _inForbiddenNightWindow_(s, e)) {
      issues.push(`fila "${r.activity}" cae en 01:00–05:00 (no permitido).`);
    }

    // Si end == start o end inválido (incluye regresos 0m como activity pero HH:MM ok)
    const dur = _durationMinutes_(r.start, r.end);
    if (dur != null && dur <= 0 && !r._crossDay) {
      issues.push(`fila "${r.activity}" tiene end<=start (horario inválido).`);
    }

    if (prevEnd != null) {
      if (s < prevEnd) issues.push(`solape: "${r.activity}" inicia antes de terminar la anterior.`);
      if (s - prevEnd < minBuffer) issues.push(`buffer <${minBuffer}m entre filas (ajustar horarios).`);
    }

    prevEnd = e;
  }

  return issues;
}

function _isAuroraRow_(activity = "") {
  const t = _canonTxt_(activity);
  return /aurora|northern lights/.test(t);
}

function _validateAuroras_(parsed, daysTotal) {
  const issues = [];
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
  if (!rows.length) return issues;

  const auroraDays = [...new Set(rows.filter((r) => _isAuroraRow_(r.activity)).map((r) => Number(r.day) || 1))].sort(
    (a, b) => a - b
  );

  // Si no hay auroras en filas pero aurora.suggested_days tiene, inconsistencia
  const declared = Array.isArray(parsed?.aurora?.suggested_days) ? parsed.aurora.suggested_days.map((x) => Number(x) || 0).filter(Boolean) : [];

  if (declared.length || auroraDays.length) {
    // No consecutivas
    for (let i = 1; i < auroraDays.length; i++) {
      if (auroraDays[i] === auroraDays[i - 1] + 1) issues.push("auroras consecutivas en filas (no permitido).");
    }
    // No último día
    if (auroraDays.includes(daysTotal)) issues.push("aurora aparece en el último día (no permitido).");
    // Máximo 1 por día
    const counts = {};
    rows.forEach((r) => {
      const d = Number(r.day) || 1;
      if (_isAuroraRow_(r.activity)) counts[d] = (counts[d] || 0) + 1;
    });
    Object.keys(counts).forEach((d) => {
      if (counts[d] > 1) issues.push(`más de 1 aurora en el día ${d} (no permitido).`);
    });

    // Coherencia suggested_days vs filas
    const aSet = new Set(auroraDays);
    const dSet = new Set(declared);
    const mismatch =
      auroraDays.length !== declared.length ||
      auroraDays.some((d) => !dSet.has(d)) ||
      declared.some((d) => !aSet.has(d));

    if (mismatch) issues.push("aurora.suggested_days no coincide con los días donde hay filas de aurora.");
  }

  return issues;
}

function _validateFullDaySingleRow_(rows, dayHours = null) {
  // Detecta casos tipo: una sola fila 08:30–19:00 "Blue Lagoon" o "Últimos momentos"
  // Permite que un day-trip tenga pocas filas SOLO si se trata de retorno y sub-paradas; aquí marcamos el extremo.
  const issues = [];
  const byDay = _groupByDay_(rows || {});
  Object.keys(byDay).forEach((k) => {
    const d = Number(k) || 1;
    const list = byDay[d] || [];
    const real = list.filter((r) => String(r.activity || "").trim());
    if (real.length !== 1) return;

    const r = real[0];
    const dur = _durationMinutes_(r.start, r.end);
    if (dur == null) return;

    // Si ocupa >= 70% del día típico (>= 7h) y la actividad no es "Día libre" (que igual está prohibido por otro check)
    if (dur >= 420) {
      const act = _canonTxt_(r.activity);
      // si es claramente "day trip" pero en 1 fila, se marca
      const strongTour = /golden circle|circulo dorado|peninsula|snaefellsnes|tour|day trip|excursion|glaciar|lagoon|blue lagoon|sky lagoon|geyser|waterfall|cascada|volcan|parque nacional/i;
      if (strongTour.test(act)) {
        issues.push(`día ${d} tiene un macro-tour/laguna en 1 sola fila (falta granularidad/sub-paradas).`);
      } else {
        issues.push(`día ${d} tiene 1 sola fila que ocupa casi todo el día (baja granularidad).`);
      }
    }
  });
  return issues;
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];
  const daysTotal = Number(parsed?.days_total || contextHint?.days_total || 1);
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("rows_draft no cubre todos los días 1..days_total.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");
  if (rows.length && rows.some((r) => _isTooGenericMetaDay_(r.activity))) issues.push('hay actividades meta genéricas ("día libre", "últimos momentos", etc.). Deben reemplazarse por POIs reales.');

  // Overlaps/buffers por día
  try {
    const byDay = _groupByDay_(rows);
    Object.keys(byDay).forEach((k) => {
      const d = Number(k) || 1;
      const errs = _detectOverlapsAndBuffers_(byDay[d], 15);
      errs.forEach((e) => issues.push(`día ${d}: ${e}`));
    });
  } catch {}

  // Auroras (coherencia y reglas)
  try {
    _validateAuroras_(parsed, daysTotal).forEach((e) => issues.push(e));
  } catch {}

  // Full-day single row / falta granularidad
  try {
    _validateFullDaySingleRow_(rows, contextHint?.day_hours || parsed?.day_hours || null).forEach((e) => issues.push(e));
  } catch {}

  // Macro-tour “en una fila” (heurística existente)
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

function _validatePlannerOutput_(parsed, contextHint = {}) {
  const issues = [];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const daysTotal = Number(contextHint?.days_total || parsed?.days_total || 0);

  if (!rows.length) issues.push("rows vacío o ausente.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push("duration no cumple 2 líneas en una o más filas.");
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("hay placeholders genéricos en activity (baja calidad).");
  if (rows.length && rows.some((r) => _isTooGenericMetaDay_(r.activity))) issues.push('hay actividades meta genéricas ("día libre", "últimos momentos", etc.).');

  // Overlaps/buffers
  try {
    const byDay = _groupByDay_(rows);
    Object.keys(byDay).forEach((k) => {
      const d = Number(k) || 1;
      const errs = _detectOverlapsAndBuffers_(byDay[d], 15);
      errs.forEach((e) => issues.push(`día ${d}: ${e}`));
    });
  } catch {}

  // Auroras coherencia vs reglas (si daysTotal conocido)
  try {
    if (daysTotal) {
      const tmp = { ...contextHint, rows_draft: rows, aurora: parsed?.aurora || contextHint?.aurora };
      _validateAuroras_(tmp, daysTotal).forEach((e) => issues.push(e));
    }
  } catch {}

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

REGLA MAESTRA 1 — IMPERDIBLES + ALCANCE REAL DEL VIAJE (CRÍTICO):
- Para cada ciudad base, identifica los **imperdibles reales** (POIs/experiencias icónicas) según temporada, clima probable, perfil del grupo (edades/movilidad), intereses y días disponibles.
- En estancias de varios días, NO te limites artificialmente a quedarte “cerca”: diseña mezcla óptima de:
  (a) imperdibles urbanos y
  (b) day-trips/macro-rutas imperdibles desde la base,
  siempre sin sacrificar lo esencial de la ciudad.
- Si un day-trip es un imperdible y el tiempo lo permite, inclúyelo.
- Los imperdibles deben reflejarse en rows_draft y listarse también en imperdibles.
- Los day-trips elegidos deben listarse en macro_tours.

REGLA MAESTRA 2 — TRANSPORTE INTELIGENTE (CRÍTICO):
- Antes de asignar transporte en un day-trip, evalúa si hay medios eficientes y realistas (tren/metro/bus interurbano) y sugiérelos cuando aplique.
  Ejemplo: desde Madrid, muchos day-trips se resuelven excelente por tren (y algunos por bus).
- Si no puedes determinar una opción eficiente con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según densidad urbana y zonas.

REGLA MAESTRA 3 — CLARIDAD TOTAL POR SUB-PARADAS (CRÍTICO, APLICA A TODO):
- Para CUALQUIER recorrido con múltiples paradas (no solo day-trips), expresa la secuencia como actividades del tipo:
  "Destino – Sub-parada" (o "Ruta/Área – Sub-parada") tan específico como se pueda.
- Esto aplica a: macro-tours, rutas urbanas por barrios, circuitos panorámicos, penínsulas, costas, miradores, etc.
- Cada sub-parada debe ser una fila con start/end, from/to, transport, duration y notes: el usuario debe ver claramente qué visita, en qué orden y cómo se mueve.

HORARIOS (CRÍTICO):
- Si el usuario define ventanas por día, respétalas como base, pero puedes ajustarlas inteligentemente cuando falten experiencias clave (auroras, espectáculos, cenas con show).
  Puedes extender el horario nocturno para incluirlas sin solapes.
- Si el usuario no define horarios, propone day_hours realistas por estación/ciudad/ritmo.
- El día 1 puede iniciar más tarde si hay señales de llegada/cansancio, pero el resto debe maximizar aprovechamiento.
- Buffers mínimos 15m entre bloques.
- Actividades diurnas NO entre 01:00–05:00.

DURACIÓN EN 2 LÍNEAS (OBLIGATORIO EN TODAS LAS FILAS):
- duration debe ser SIEMPRE exactamente 2 líneas:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar un tiempo razonable, NO inventes: usa
  "Transporte: Verificar duración en el Info Chat" o "Actividad: Verificar duración en el Info Chat"
  y mantén el formato de 2 líneas.

MACRO-TOURS / note CRÍTICO:
- Está PROHIBIDO crear días "Día libre", "Últimos momentos", "Explora a tu ritmo" como actividad principal.
  Debes reemplazarlos por POIs/experiencias reales, aunque sea un día suave.

MACRO-TOURS / DAY-TRIPS (CRÍTICO):
- Si incluyes un day-trip fuerte, ese día queda dedicado al tour.
- Debe tener 5–8 sub-paradas con el formato "Tour – Sub-parada" o "Destino – Sub-parada".
- Incluye explícitamente al cierre una fila: "Regreso a {ciudad base}" (con duración 2 líneas).
- No colocar day-trips duros el último día.
- NO generar duplicados bilingües del mismo tour/actividad.

LAGUNAS TERMALES (CRÍTICO):
- Cualquier laguna termal (Blue Lagoon, Sky Lagoon, etc.) debe tener mínimo 3 horas de actividad efectiva.
- Si la laguna se programa como actividad principal del día, NO puede ser una sola fila "08:30–19:00".
  Debe incluir sub-bloques (llegada, entrada/locker, baño, comida, regreso) o integrarse en una ruta.

AURORAS (SOLO SI ES PLAUSIBLE):
- Antes de sugerir auroras, valida plausibilidad por latitud y época del año (oscuridad/temporada).
- Si NO es plausible, NO las sugieras.
- Si es plausible: máximo 1 por día, NO consecutivas, NUNCA en el último día, ventana local concreta, transporte coherente (vehículo alquilado o Tour guiado).
- aurora.suggested_days DEBE coincidir exactamente con los días donde aparece una fila de aurora en rows_draft.

NOCHES: ESPECTÁCULOS Y CENAS CON SHOW:
- Si el destino tiene experiencias nocturnas icónicas, puedes sugerirlas.
- Ajusta horarios para incluirlas SIN SOLAPES con auroras u otros eventos.

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido usar actividades genéricas sin identidad: NO "Museo de Arte", NO "Parque local", NO "Café local", NO "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.

CRÍTICO — SALIDA PARA EVITAR REGRESIONES DEL PLANNER:
- Debes incluir SIEMPRE un arreglo rows_draft con el itinerario COMPLETO (todas las filas de todos los días).
- rows_draft debe traer ya:
  - day, start, end,
  - activity, from, to,
  - transport,
  - duration (2 líneas),
  - notes (1–2 frases de alto impacto, motivadoras y accionables),
  - kind, zone,
  - opcional: _crossDay si cruza medianoche.
- El Planner NO debe inventar: solo formatea/valida y renderiza.
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
- Si faltan campos:
  - transport: si no hay nada, usa "A pie" para urbano y "Vehículo alquilado o Tour guiado" para out-of-town cuando sea evidente por la activity/from/to.
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
- Respeta ventana day_hours si viene.
- No pongas actividades diurnas entre 01:00–05:00.
- "Regreso a {ciudad}" debe ser la última fila del day-trip si aplica.

DURACIÓN (2 líneas obligatorias):
- duration debe ser SIEMPRE:
  "Transporte: Xm\\nActividad: Ym"
- Si no conoces, usa:
  "Transporte: Verificar duración en el Info Chat\\nActividad: Verificar duración en el Info Chat"

MODO ACOTADO:
- Si viene "target_day", devuelve SOLO filas de ese día.
`.trim();

/* ============== Planner determinístico (sin LLM) ============== */
function _cloneRow_(r) {
  return {
    day: r?.day,
    start: r?.start,
    end: r?.end,
    activity: r?.activity ?? "",
    from: r?.from ?? "",
    to: r?.to ?? "",
    transport: r?.transport ?? "",
    duration: r?.duration ?? "",
    notes: r?.notes ?? "",
    kind: r?.kind ?? "",
    zone: r?.zone ?? "",
    _crossDay: r?._crossDay ?? undefined,
  };
}

function _applyBufferAndDeoverlap_(rows, minBuffer = 15) {
  const byDay = _groupByDay_(rows || []);
  const out = [];

  Object.keys(byDay)
    .map((k) => Number(k) || 1)
    .sort((a, b) => a - b)
    .forEach((day) => {
      const list = _sortByStart_(byDay[day] || []).map(_cloneRow_);

      let prevEnd = null;
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const s = _parseHHMM_(r.start);
        const e = _parseHHMM_(r.end);

        // Normaliza HH:MM si puede
        r.start = _normalizeHHMMOrKeep_(r.start);
        r.end = _normalizeHHMMOrKeep_(r.end);

        if (s == null || e == null) {
          out.push(r);
          continue;
        }

        let newStart = s;
        let newEnd = e;

        // Si hay solape/buffer insuficiente, empuja el inicio
        if (prevEnd != null) {
          const minStart = prevEnd + minBuffer;
          if (newStart < minStart) {
            const shift = minStart - newStart;
            newStart = minStart;
            // Mantener duración si posible
            const dur = _durationMinutes_(r.start, r.end);
            if (dur != null && dur > 0) newEnd = newStart + dur;
          }
        }

        // Si end quedó <= start, empuja end mínimo (sin inventar POIs, solo horario)
        if (newEnd <= newStart) newEnd = newStart + 30;

        // Clamp
        if (newStart < 0) newStart = 0;
        if (newEnd > 24 * 60 - 1) newEnd = 24 * 60 - 1;

        r.start = _fmtHHMM_(newStart);
        r.end = _fmtHHMM_(newEnd);

        prevEnd = _parseHHMM_(r.end);
        out.push(r);
      }
    });

  return out;
}

function _plannerDeterministic_(research, body = {}) {
  const rowsDraft = Array.isArray(research?.rows_draft) ? research.rows_draft : [];
  let rows = rowsDraft.map(_cloneRow_);

  // target_day: filtrar si aplica
  const td = body?.target_day;
  if (td != null && td !== "" && td !== false) {
    const want = Number(td);
    if (Number.isFinite(want) && want > 0) rows = rows.filter((r) => Number(r.day) === want);
  }

  // Normalización + buffer/anti-solape
  rows = _applyBufferAndDeoverlap_(rows, 15);

  // durations normalizadas en parsed final
  const parsed = {
    destination: research?.destination || research?.city || "Destino",
    rows,
    followup: "",
  };

  return normalizeDurationsInParsed(parsed);
}

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
      //  B) { mode:"info", messages:[...] }
      //  C) { mode:"info", ...contextPlano }
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3900);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3800);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Si parsea pero está flojo → Quality Gate + 1 retry (máximo)
      if (parsed) {
        const hint = {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
          day_hours: context?.day_hours || context?.dayHours || null,
        };

        const audit = _validateInfoResearch_(parsed, hint);

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.
REGLAS DE REPARACIÓN (NO NEGOCIABLES):
1) rows_draft debe cubrir todos los días 1..days_total sin días vacíos.
2) activity NO puede ser genérica ni meta: PROHIBIDO "día libre", "últimos momentos", "explora a tu ritmo".
   Debes reemplazar por POIs/experiencias reales y específicas.
3) duration debe ser EXACTAMENTE 2 líneas: "Transporte: ...\\nActividad: ..."
4) Horarios: sin solapes y con buffer mínimo 15m entre filas del mismo día.
5) Si hay auroras:
   - máximo 1 por día
   - NO consecutivas
   - NUNCA en el último día
   - aurora.suggested_days debe coincidir EXACTAMENTE con los días donde existe una fila de aurora
6) Si hay laguna termal o macro-tour:
   - NO puede ser una sola fila que ocupa casi todo el día
   - Debes granular con sub-bloques/sub-paradas y cerrar con "Regreso a {ciudad}" si aplica.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.25, 3900);
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

      // Auto-sane mínimo: normaliza duraciones + coherencia suggested_days si está muy desalineado
      try {
        const daysTotal = Number(parsed?.days_total || context?.days_total || 1);
        const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
        const auroraDays = [...new Set(rows.filter((r) => _isAuroraRow_(r.activity)).map((r) => Number(r.day) || 1))].sort((a, b) => a - b);
        if (parsed?.aurora && parsed.aurora.plausible === true) {
          // Si el modelo puso suggested_days, pero no coincide, alineamos a filas reales (metadata)
          parsed.aurora.suggested_days = auroraDays.filter((d) => d >= 1 && d <= daysTotal);
        }
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      const research = body.research_json || null;

      // Camino nuevo determinístico (preferido): research_json + rows_draft => NO LLM
      if (research && Array.isArray(research?.rows_draft) && research.rows_draft.length) {
        const parsed = _plannerDeterministic_(research, body);

        // Audit suave por si algo raro entra
        try {
          const audit = _validatePlannerOutput_(parsed, { days_total: Number(research?.days_total || 0), aurora: research?.aurora });
          // Si falla, igual devolvemos (no rompemos). El verdadero fix está en INFO.
          if (!audit.ok) {
            // no throw: compat
          }
        } catch {}

        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

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

      // Camino viejo con research_json pero sin rows_draft usable -> LLM (último recurso)
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

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3600);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (parsed) {
        const audit = _validatePlannerOutput_(parsed, { days_total: Number(research?.days_total || 0), aurora: research?.aurora });
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
- No solapes + buffer mínimo 15m.
- Elimina meta genéricos: NO "día libre", NO "últimos momentos", NO "explora a tu ritmo".
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
