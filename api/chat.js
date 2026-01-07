// /api/chat.js — v50 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v50 — Cambios QUIRÚRGICOS (sin romper integración):
// 1) Sanitiza preferences.alwaysIncludeDinner (lo desactiva) para evitar cenas “forzadas”.
// 2) Quality Gate INFO reforzado:
//    - Detecta SOLAPES por día (bloques que se pisan).
//    - Macro-tours: exige sub-paradas secuenciales (>=5 filas del tour) + “Regreso a {base}”.
//    - Prohíbe genéricos adicionales (“cena en restaurante”, “últimas compras”, “museos y cultura”, “exploración de …”).
//    - Evita “último día light” (mínimo de filas significativas).
// 3) Mantiene v43.6.2: validate=true en modo planner no llama al modelo.

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
        start: "",
        end: "",
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
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = touchRows(parsed.rows_draft);
  } catch {}

  return parsed;
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

    // ✅ v50: genéricos detectados en tu output real
    "cena en restaurante",
    "cena en un restaurante",
    "ultimas compras",
    "compras",
    "souvenirs",
    "museos y cultura",
    "exploracion de reykjavik",
    "exploracion de",
    "tiempo libre",
  ];

  // Muy corto y genérico
  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado|compras)$/i.test(t)) return true;

  // Exact match o “contiene”
  if (bad.some((b) => t === b || t.includes(b))) return true;

  // “Museo/Parque/Café/Restaurante/Compras” sin nombre propio (heurística simple)
  if (/^(museo|parque|cafe|restaurante|compras)\b/i.test(t) && t.split(" ").length <= 3) return true;

  // “Cena” sin lugar específico
  if (/^reykjavik\s+cena/i.test(t) || /^cena\b/i.test(t)) {
    // si no hay ningún nombre propio evidente, lo marcamos genérico
    if (t.split(" ").length <= 4) return true;
  }

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

// ✅ v50: helpers para solapes y “último día light”
function _toMin_(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function _sortedDayRows_(rows, day) {
  return rows
    .filter((r) => Number(r.day) === Number(day))
    .map((r) => ({ ...r, _s: _toMin_(r.start), _e: _toMin_(r.end) }))
    .filter((r) => r._s != null && r._e != null)
    .sort((a, b) => a._s - b._s);
}
function _hasOverlapsInDay_(rows, day) {
  const list = _sortedDayRows_(rows, day);
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const cur = list[i];
    if (cur._s < prev._e) return true;
  }
  return false;
}
function _meaningfulRow_(r = {}) {
  const act = _canonTxt_(r.activity);
  if (!act) return false;
  // No contamos “regreso al hotel” como actividad del día
  if (/regreso\s+al\s+hotel|regreso\s+al\s+alojamiento/i.test(act)) return false;
  // No contamos placeholders genéricos
  if (_isGenericPlaceholderActivity_(r.activity)) return false;
  return true;
}
function _meaningfulCountByDay_(rows, day) {
  return rows.filter((r) => Number(r.day) === Number(day)).filter(_meaningfulRow_).length;
}
function _hasReturnToBase_(rows, day, baseCity) {
  const base = _canonTxt_(baseCity || "");
  if (!base) return false;
  return rows.some((r) => {
    if (Number(r.day) !== Number(day)) return false;
    const a = _canonTxt_(r.activity);
    return a.includes("regreso a") && a.includes(base);
  });
}
function _isMacroTourRow_(r) {
  const a = _canonTxt_(r?.activity);
  return /circulo\s*dorado|golden\s*circle|day\s*trip|excursion|tour\b/i.test(a);
}
function _macroTourRowCountInDay_(rows, day) {
  return rows.filter((r) => Number(r.day) === Number(day)).filter(_isMacroTourRow_).length;
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];

  const daysTotal = Number(parsed?.days_total || contextHint?.days_total || 1);
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
  const baseCity = parsed?.destination || contextHint?.city || contextHint?.destination || "";

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal))
    issues.push("rows_draft no cubre todos los días 1..days_total.");

  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration)))
    issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');

  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity)))
    issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante/compras/cena genérico).");

  // ✅ v50: solapes por día (tu error principal en Golden Circle)
  for (let d = 1; d <= daysTotal; d++) {
    if (_hasOverlapsInDay_(rows, d)) {
      issues.push(`hay solapes de horarios dentro del día ${d} (filas que se pisan).`);
      break;
    }
  }

  /* =========================================================
     AURORAS
     ========================================================= */
  const auroraDays = rows
    .filter((r) => /auroras?|aurora\s*boreal|northern\s*lights/i.test(String(r.activity || "")))
    .map((r) => Number(r.day))
    .sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras programadas en días consecutivos (no permitido).");
      break;
    }
  }

  if (auroraDays.includes(daysTotal)) {
    issues.push("auroras programadas en el último día (no permitido).");
  }

  /* =========================================================
     MACRO-TOURS: deben ser secuenciales, 5–8 sub-paradas + regreso a base
     ========================================================= */
  // Si existen macro_tours declarados, exigimos que en algún día haya >=5 filas del tour
  const declaredMacroTours = Array.isArray(parsed?.macro_tours) ? parsed.macro_tours : [];
  if (declaredMacroTours.length) {
    let okSomeDay = false;
    for (let d = 1; d <= daysTotal; d++) {
      const c = _macroTourRowCountInDay_(rows, d);
      if (c >= 5 && _hasReturnToBase_(rows, d, baseCity)) {
        okSomeDay = true;
        break;
      }
    }
    if (!okSomeDay) {
      issues.push(
        'macro-tour declarado pero no estructurado como day-trip real (requiere >=5 sub-paradas "Destino – Sub-parada" en un solo día + "Regreso a {base}").'
      );
    }
  }

  /* =========================================================
     ÚLTIMO DÍA LIGHT (tu regla explícita)
     ========================================================= */
  // Exigimos que el último día tenga al menos 2 filas “significativas”
  // (no cuenta regreso/hotel/placeholder). Esto fuerza al INFO a planear.
  if (daysTotal >= 2) {
    const lastMeaningful = _meaningfulCountByDay_(rows, daysTotal);
    if (lastMeaningful < 2) {
      issues.push("último día demasiado liviano (menos de 2 actividades significativas).");
    }
  }

  /* =========================================================
     DURACIÓN VS BLOQUE HORARIO (ya existía; mantenemos)
     ========================================================= */
  const durFromText = (txt) => {
    const s = String(txt || "");
    let total = 0;
    const mh = s.match(/Actividad\s*:\s*(\d+)\s*h/i);
    const mm = s.match(/Actividad\s*:\s*(\d+)\s*m/i);
    if (mh) total += parseInt(mh[1], 10) * 60;
    if (mm) total += parseInt(mm[1], 10);
    return total;
  };

  rows.forEach((r) => {
    const s = _toMin_(r.start);
    const e = _toMin_(r.end);
    if (s == null || e == null) return;

    let block = e - s;
    if (block <= 0) block += 24 * 60;

    const dur = durFromText(r.duration);
    if (dur && dur < block * 0.7) {
      issues.push(`duración inconsistente en día ${r.day} (${r.activity}).`);
    }
  });

  return { ok: issues.length === 0, issues };
}

/* ============== ✅ v43.6.1: Sanitizador de day_hours entrante ============== */
function _sanitizeIncomingDayHours_(day_hours, daysTotal) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return null;

    const need = Math.max(1, Number(daysTotal) || day_hours.length || 1);

    const norm = (t) => String(t || "").trim();
    const cleaned = day_hours.map((d, idx) => ({
      day: Number(d?.day) || idx + 1,
      start: norm(d?.start) || "",
      end: norm(d?.end) || "",
    }));

    const hasAny = cleaned.some((d) => d.start || d.end);
    if (!hasAny) return null;

    if (cleaned.length === need) {
      const allHave = cleaned.every((d) => d.start && d.end);
      if (allHave) {
        const s0 = cleaned[0].start;
        const e0 = cleaned[0].end;
        const allSame = cleaned.every((d) => d.start === s0 && d.end === e0);
        if (allSame) return null;
      }
    }

    return cleaned;
  } catch {
    return null;
  }
}

/* ============== ✅ FIX QUIRÚRGICO: evitar crash en planner por función faltante ============== */
function _validatePlannerOutput_(parsed) {
  try {
    const issues = [];
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!rows.length) issues.push("rows vacío o ausente (obligatorio).");

    if (rows.length) {
      if (rows.some((r) => !_hasTwoLineDuration_(r?.duration))) {
        issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
      }
      if (rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) {
        issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante/compras/cena genérico).");
      }
      if (rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) {
        issues.push("hay filas con 'day' inválido (<1 o no numérico).");
      }
    }

    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ============== Prompts del sistema ============== */

const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para tabla.

ARQUITECTURA:
- Tú (INFO) eres la **fuente de verdad** de horarios: start/end por fila en rows_draft.
- El Planner solo valida/ajusta solapes pequeños; NO crea ventanas por defecto.

IMPERDIBLES + ALCANCE (CRÍTICO):
- Identifica imperdibles reales y combínalos con day-trips cuando aplique, sin sacrificar ciudad base.

TRANSPORTE (CRÍTICO):
- Dentro de ciudad: coherente (a pie / bus / taxi).
- Fuera de ciudad: si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".

DESTINO – SUB-PARADA (CRÍTICO):
- Para recorridos multi-parada (macro-tours o urbano), cada sub-parada debe ser UNA FILA con:
  activity "Destino – Sub-parada" y campos completos.

HORARIOS (CRÍTICO):
- Si el usuario NO define day_hours: NO inventes plantilla rígida repetida.
- Buffers mínimos 15m.
- Actividades diurnas NO entre 01:00–05:00.
- PROHIBIDO solapar filas dentro del mismo día.

DURACIÓN (OBLIGATORIO):
- duration SIEMPRE 2 líneas:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar: "Verificar duración en el Info Chat" manteniendo 2 líneas.

MACRO-TOURS / DAY-TRIPS (CRÍTICO):
- Si incluyes un day-trip fuerte, ese día queda dedicado al tour.
- Debe tener 5–8 sub-paradas SECUENCIALES (sin una fila gigante 08:00–18:00 que se pisa con otras).
- Incluye explícitamente al cierre una fila: "Regreso a {ciudad base}".
- No colocar day-trips duros el último día.
- NO repartir el mismo macro-tour en varios días.

AURORAS (si plausible):
- NO consecutivas, NUNCA en último día, ventana local concreta, transporte coherente.

COMIDAS:
- Comidas NO son prioridad si no se pide explícitamente.
- NO fuerces cenas “por regla” si el usuario no lo pidió.

PROHIBIDO GENÉRICO:
- Prohibido "Cena en restaurante", "Últimas compras", "Museos y Cultura", "Exploración de ..." como actividad principal.

SALIDA (JSON) (sin texto fuera):
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
  "aurora":{...},
  "constraints":{...},
  "day_hours":[],
  "rows_draft":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"Destino – Sub-parada","from":"","to":"","transport":"","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}
  ],
  "rows_skeleton":[]
}

NOTA day_hours:
- Si NO viene en el contexto del usuario, déjalo como [] (no lo inventes).
`.trim();

const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo es **estructurar y validar** para renderizar en tabla. **NO aportes creatividad.**

CONTRATO / FUENTE DE VERDAD:
- Si research_json incluye rows_draft (o rows_final), esas filas son la verdad.
  → Úsalas como base y SOLO:
    (a) normalizar HH:MM,
    (b) asegurar buffers >=15m cuando falten,
    (c) corregir solapes pequeños moviendo minutos dentro del día,
    (d) completar campos faltantes SIN inventar actividades nuevas.
- NO reescribas "activity": preserva "Destino – Sub-parada".

DAY_HOURS (GUIA / SOFT):
- Si viene day_hours, úsalo como guía.
- NO inventes day_hours si no viene.
- NO sobreescribas start/end válidos de rows_draft; solo ajusta por solape o coherencia.

Si faltan campos:
- transport: urbano "A pie"; fuera "Vehículo alquilado o Tour guiado" si es evidente.
- notes: 1 frase breve sin inventar POIs nuevos.

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
- duration en 2 líneas obligatorias.
- "Regreso a {ciudad}" debe ser la última fila del day-trip si aplica.

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

      // ✅ v50: Sanitizar preferences (apagar alwaysIncludeDinner si viene “inyectado” desde UI)
      try {
        if (context && typeof context === "object" && context.preferences && typeof context.preferences === "object") {
          if ("alwaysIncludeDinner" in context.preferences) {
            context.preferences.alwaysIncludeDinner = false;
          }
        }
      } catch {}

      // ✅ v43.6.1: eliminar day_hours si parece plantilla rígida repetida
      try {
        if (context && typeof context === "object") {
          const daysTotal = context?.days_total || context?.days || context?.daysTotal || 1;
          const sanitized = _sanitizeIncomingDayHours_(context?.day_hours, daysTotal);
          if (!sanitized) {
            if ("day_hours" in context) delete context.day_hours;
          } else {
            context.day_hours = sanitized;
          }
        }
      } catch {}

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
          city: context?.city || "",
          destination: context?.city || "",
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
2) PROHIBIDO solapar filas dentro del mismo día.
3) activity NO puede ser genérica: NO "Cena en restaurante", NO "Últimas compras", NO "Museos y Cultura", NO "Exploración de ...".
4) duration EXACTAMENTE 2 líneas: "Transporte: ...\\nActividad: ..."
5) Macro-tour/day-trip: en UN solo día debe tener 5–8 sub-paradas secuenciales + "Regreso a {ciudad base}".
   PROHIBIDO: una fila gigante 08:00–18:00 que se pisa con otras sub-paradas.
6) NO repartir el mismo macro-tour en varios días.
7) Último día NO puede ser light: mínimo 2 actividades significativas (no cuenta "regreso al hotel").

Devuelve SOLO JSON válido.
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
      // ✅ v43.6.2: VALIDATE no debe llamar al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

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
- NO reescribas "activity".
- duration en 2 líneas obligatorias.
- Elimina placeholders genéricos.
- Devuelve SOLO JSON válido.
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
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
