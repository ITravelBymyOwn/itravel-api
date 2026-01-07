// /api/chat.js — v44.0.0 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v44.0.0 (OPT + FIX TIMEOUTS):
// - Timeout duro por llamada LLM + presupuesto total en INFO para evitar 120s.
// - INFO: menos tokens, menos reintentos, cache TTL.
// - PLANNER: fast-path determinístico si viene research_json.rows_draft (0 llamadas LLM).
// - COMIDAS: guía flexible (no predefinir cenas).
// - Mantiene reglas críticas (transporte público priorizado cuando aplica, auroras, day-trips, etc.)

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ============== Performance knobs ============== */
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Tiempo máximo por llamada al modelo (ms). Manténlo < timeout del frontend.
const LLM_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS || 25000);

// Presupuesto total del modo INFO (ms) para evitar cadenas largas de retries.
const INFO_BUDGET_MS = Number(process.env.INFO_BUDGET_MS || 45000);

// Cache INFO (best-effort, memoria del runtime)
const __INFO_CACHE__ =
  globalThis.__INFO_CACHE__ || (globalThis.__INFO_CACHE__ = new Map());
// TTL en ms
const INFO_CACHE_TTL_MS = Number(process.env.INFO_CACHE_TTL_MS || 15 * 60 * 1000);

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
        duration:
          "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
        notes: "Explora libremente la ciudad.",
        kind: "",
        zone: "",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o despliegue.",
  };
}

/* ✅ fallback INFO (para no romper Planner que exige rows_draft) */
function fallbackInfoJSON(context = {}) {
  const city = String(context?.city || context?.destination || "Destino").trim() || "Destino";
  const country = String(context?.country || "").trim();
  const daysTotal = Math.max(1, Number(context?.days_total || context?.days || context?.daysTotal || 1));

  const rows_draft = [];
  for (let d = 1; d <= daysTotal; d++) {
    rows_draft.push({
      day: d,
      start: "",
      end: "",
      activity: `Fallback – Planificación pendiente (Día ${d})`,
      from: city,
      to: city,
      transport: "",
      duration:
        "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
      notes: "⚠️ El Info Chat interno no pudo generar este día. Revisa OPENAI_API_KEY / despliegue.",
      kind: "",
      zone: "",
    });
  }

  return {
    destination: city,
    country,
    days_total: daysTotal,
    hotel_base: String(context?.hotel_address || context?.hotel_base || "").trim(),
    rationale: "Fallback mínimo (INFO).",
    imperdibles: [],
    macro_tours: [],
    in_city_routes: [],
    meals_suggestions: [],
    aurora: {
      plausible: false,
      suggested_days: [],
      window_local: { start: "", end: "" },
      duration: "~3h–4h",
      transport_default: "",
      note: "Fallback: depende de clima/latitud y del tour.",
    },
    constraints: {
      max_substops_per_tour: 8,
      avoid_duplicates_across_days: true,
      optimize_order_by_distance_and_time: true,
      respect_user_preferences_and_conditions: true,
      no_consecutive_auroras: true,
      no_last_day_aurora: true,
      thermal_lagoons_min_stay_minutes: 180,
    },
    day_hours: [],
    rows_draft,
    rows_skeleton: rows_draft.map((r) => ({
      day: r.day,
      start: "",
      end: "",
      activity: "",
      from: "",
      to: "",
      transport: "",
      duration: "",
      notes: "",
      kind: "",
      zone: "",
    })),
    followup: "⚠️ Fallback INFO: revisa OPENAI_API_KEY o despliegue.",
  };
}

/* ============== LLM call con timeout duro ============== */
function _withTimeout(promise, ms, label = "LLM") {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/* ✅ Chat Completions con roles reales + timeout */
async function callText(messages, temperature = 0.25, max_output_tokens = 1800) {
  const work = client.chat.completions.create({
    model: MODEL,
    temperature,
    max_tokens: max_output_tokens,
    messages: (messages || []).map((m) => ({
      role: String(m.role || "user"),
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
  });

  const resp = await _withTimeout(work, LLM_CALL_TIMEOUT_MS, "callText");
  return resp?.choices?.[0]?.message?.content?.trim() || "";
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

function _missingDays_(rows, daysTotal) {
  try {
    const need = Math.max(1, Number(daysTotal) || 1);
    const present = new Set((Array.isArray(rows) ? rows : []).map((r) => Number(r?.day) || 0));
    const missing = [];
    for (let d = 1; d <= need; d++) if (!present.has(d)) missing.push(d);
    return missing;
  } catch {
    return [];
  }
}

function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];

  const daysTotal = Number(parsed?.days_total || contextHint?.days_total || 1);
  const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];

  if (!rows.length) issues.push("rows_draft vacío o ausente (obligatorio).");
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal))
    issues.push("rows_draft no cubre todos los días 1..days_total.");

  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration)))
    issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');

  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity)))
    issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");

  // AURORAS no consecutivas / no último día
  const auroraDays = rows
    .filter((r) => /auroras?|northern\s*lights/i.test(r.activity) || String(r?.kind || "").toLowerCase() === "aurora")
    .map((r) => Number(r.day))
    .filter((n) => Number.isFinite(n))
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

  // Macro-tours únicos (no repetidos)
  const macroCanon = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/–.*$/, "")
      .trim();

  const macroDays = {};
  rows.forEach((r) => {
    const key = macroCanon(r.activity);
    if (/golden\s*circle|circulo\s*dorado|day\s*trip|excursion|tour\b/i.test(key)) {
      macroDays[key] = macroDays[key] || new Set();
      macroDays[key].add(Number(r.day));
    }
  });

  Object.entries(macroDays).forEach(([k, days]) => {
    if (days.size > 1) issues.push(`macro-tour "${k}" repartido en múltiples días (${[...days].join(", ")}).`);
  });

  return { ok: issues.length === 0, issues };
}

/* ============== Sanitizador day_hours entrante ============== */
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

/* ============== Planner validator (no rompe) ============== */
function _validatePlannerOutput_(parsed) {
  try {
    const issues = [];
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!rows.length) issues.push("rows vacío o ausente (obligatorio).");

    if (rows.length) {
      if (rows.some((r) => !_hasTwoLineDuration_(r?.duration)))
        issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
      if (rows.some((r) => _isGenericPlaceholderActivity_(r?.activity)))
        issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");
      if (rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day))))
        issues.push("hay filas con 'day' inválido (<1 o no numérico).");
    }

    return { ok: issues.length === 0, issues };
  } catch {
    return { ok: true, issues: [] };
  }
}

/* ============== Fill helpers ============== */
function _splitActivityDestSub_(activity) {
  try {
    const s = String(activity || "").trim();
    if (!s) return null;
    const m = s.match(/^(.+?)\s[–-]\s(.+?)$/);
    if (!m) return null;
    const left = String(m[1] || "").trim();
    const right = String(m[2] || "").trim();
    if (!left || !right) return null;
    return { from: left, to: right };
  } catch {
    return null;
  }
}

function _fillFromToFromActivity_(rows = []) {
  try {
    if (!Array.isArray(rows) || !rows.length) return rows;

    let prevTo = "";
    const out = rows.map((r) => {
      const row = { ...(r || {}) };
      const from0 = String(row.from || "").trim();
      const to0 = String(row.to || "").trim();

      if (!from0 || !to0) {
        const sp = _splitActivityDestSub_(row.activity);
        if (sp) {
          if (!from0) row.from = sp.from;
          if (!to0) row.to = sp.to;
        }
      }

      const from1 = String(row.from || "").trim();
      const to1 = String(row.to || "").trim();
      if (!from1 && prevTo) row.from = prevTo;
      if (to1) prevTo = to1;

      return row;
    });

    return out;
  } catch {
    return rows;
  }
}

/* ============== Enforcements INFO (quirúrgicos) ============== */
function _dedupeConsecutiveDays_(days = []) {
  const sorted = [...new Set(days.map((n) => Number(n)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const d = sorted[i];
    if (out.length && d === out[out.length - 1] + 1) continue;
    out.push(d);
  }
  return out;
}

function _enforceAuroras_(parsed, daysTotal) {
  try {
    if (!parsed || !Array.isArray(parsed.rows_draft)) return parsed;

    const total = Math.max(1, Number(daysTotal) || Number(parsed?.days_total) || 1);
    const auroraMeta = parsed?.aurora && typeof parsed.aurora === "object" ? parsed.aurora : null;
    const plausible = auroraMeta ? Boolean(auroraMeta.plausible) : null;

    if (plausible === false) {
      parsed.rows_draft = parsed.rows_draft.filter(
        (r) =>
          !(String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || "")))
      );
      if (auroraMeta) {
        auroraMeta.suggested_days = [];
        parsed.aurora = auroraMeta;
      }
      return parsed;
    }

    const auroraRows = parsed.rows_draft.filter(
      (r) => String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || ""))
    );

    const days = auroraRows.map((r) => Number(r?.day)).filter((n) => Number.isFinite(n));
    let keepDays = _dedupeConsecutiveDays_(days).filter((d) => d !== total);

    if (auroraMeta && Array.isArray(auroraMeta.suggested_days) && auroraMeta.suggested_days.length) {
      const metaDays = auroraMeta.suggested_days
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n))
        .filter((d) => d !== total);
      const inter = keepDays.filter((d) => metaDays.includes(d));
      if (inter.length) keepDays = inter;
    }

    const keepSet = new Set(keepDays);
    parsed.rows_draft = parsed.rows_draft.filter((r) => {
      const isAur =
        String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || ""));
      if (!isAur) return true;
      const d = Number(r?.day);
      return keepSet.has(d);
    });

    if (auroraMeta) {
      auroraMeta.suggested_days = [...keepSet].sort((a, b) => a - b);
      parsed.aurora = auroraMeta;
    }

    return parsed;
  } catch {
    return parsed;
  }
}

function _insertReturnRowIfMissing_(parsed, baseCity) {
  try {
    if (!parsed || !Array.isArray(parsed.rows_draft) || !parsed.rows_draft.length) return parsed;

    const city = String(baseCity || parsed?.destination || "").trim();
    if (!city) return parsed;

    const byDay = new Map();
    parsed.rows_draft.forEach((r) => {
      const d = Number(r?.day) || 0;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });

    const outRows = [];
    const isMacro = (r) => String(r?.kind || "").toLowerCase() === "macro_tour";
    const isReturn = (r) => /regreso\s+a\s+/i.test(String(r?.activity || ""));

    const inferFromPlace = (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const rr = rows[i];
        if (!rr) continue;
        const t = String(rr?.to || "").trim();
        if (t) return t;
        const sp = _splitActivityDestSub_(rr?.activity);
        if (sp?.to) return sp.to;
      }
      return "";
    };

    const inferTransport = (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const tr = String(rows[i]?.transport || "").trim();
        if (tr) return tr;
      }
      return "Vehículo alquilado o Tour guiado";
    };

    const inferZone = (rows) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        const z = String(rows[i]?.zone || "").trim();
        if (z) return z;
      }
      return "";
    };

    const days = [...byDay.keys()].filter((d) => d > 0).sort((a, b) => a - b);

    days.forEach((d) => {
      const dayRows = (byDay.get(d) || []).slice();
      dayRows.sort((a, b) => String(a?.start || "").localeCompare(String(b?.start || "")));

      const hasMacro = dayRows.some(isMacro);
      const alreadyReturn = dayRows.some(isReturn);

      dayRows.forEach((r) => outRows.push(r));

      if (hasMacro && !alreadyReturn) {
        const fromPlace = inferFromPlace(dayRows);
        const transport = inferTransport(dayRows);
        const zone = inferZone(dayRows);

        outRows.push({
          day: d,
          start: "",
          end: "",
          activity: `Regreso a ${city}`,
          from: fromPlace || "",
          to: city,
          transport: transport,
          duration:
            "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
          notes: "Regreso a la ciudad base para descansar.",
          kind: "macro_tour",
          zone: zone || "",
        });
      }
    });

    parsed.rows_draft = outRows;
    return parsed;
  } catch {
    return parsed;
  }
}

function _enforceInfoHardRules_(parsed, daysTotalHint) {
  try {
    if (!parsed || typeof parsed !== "object") return parsed;

    const total = Math.max(1, Number(parsed?.days_total || daysTotalHint || 1));
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);
    parsed = _enforceAuroras_(parsed, total);
    parsed = _insertReturnRowIfMissing_(parsed, parsed?.destination);
    if (Array.isArray(parsed.rows_draft)) parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);

    return parsed;
  } catch {
    return parsed;
  }
}

/* ============== ✅ PLANNER determinístico (fast path) ============== */
function _ensureTwoLineDuration_(dur) {
  const s = String(dur || "").trim();
  if (/Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s)) return s;
  if (s) return `Transporte: Verificar duración en el Info Chat\nActividad: ${s}`;
  return "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
}

function _isUrbanLikely_(row, baseCity) {
  const city = String(baseCity || "").trim().toLowerCase();
  const from = String(row?.from || "").trim().toLowerCase();
  const to = String(row?.to || "").trim().toLowerCase();
  if (!city) return false;
  return (!from || from.includes(city)) && (!to || to.includes(city));
}

function _normalizePlannerRow_(r, baseCity) {
  const row = { ...(r || {}) };
  row.day = Number(row.day) || 1;
  row.start = String(row.start || "").trim();
  row.end = String(row.end || "").trim();
  row.activity = String(row.activity || "").trim();
  row.from = String(row.from || "").trim();
  row.to = String(row.to || "").trim();
  row.transport = String(row.transport || "").trim();
  row.notes = String(row.notes || "").trim();
  row.kind = String(row.kind || "").trim();
  row.zone = String(row.zone || "").trim();
  row.duration = _ensureTwoLineDuration_(row.duration);

  if (!row.transport) row.transport = _isUrbanLikely_(row, baseCity) ? "A pie" : "Vehículo alquilado o Tour guiado";
  return row;
}

function _plannerDeterministicFromResearch_(research, target_day) {
  const baseCity = String(research?.destination || research?.city || "").trim();
  const rowsDraft = Array.isArray(research?.rows_draft) ? research.rows_draft : [];
  if (!rowsDraft.length) return null;

  const td = target_day == null ? null : Number(target_day);
  const filtered = td ? rowsDraft.filter((r) => Number(r?.day) === td) : rowsDraft.slice();

  let outRows = filtered.map((r) => _normalizePlannerRow_(r, baseCity));
  outRows = _fillFromToFromActivity_(outRows);

  return { destination: baseCity || "Destino", rows: outRows, followup: "" };
}

/* ============== Prompts del sistema ============== */

/* =======================
   SISTEMA — INFO CHAT (interno)
   ======================= */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium para diseñar itinerarios optimizados, realistas, secuenciales y claros.
Tu salida será consumida por un Planner que solo estructura/renderiza lo que tú decidas.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para usarse en tabla.

✅ ARQUITECTURA (OPCIÓN A):
- Tú (INFO) eres la **fuente de verdad** de los horarios: start/end por fila en rows_draft.
- El Planner solo valida/ajusta solapes pequeños; NO genera ventanas ni rellena horarios por defecto.

REGLA MAESTRA 1 — IMPERDIBLES + ALCANCE REAL DEL VIAJE (CRÍTICO):
- Para cada ciudad base, identifica **imperdibles reales** según temporada, perfil del grupo, intereses y días disponibles.
- Mezcla óptima de imperdibles urbanos + day-trips/macro-rutas desde la base sin sacrificar lo esencial.
- Los imperdibles deben reflejarse en rows_draft y listarse en imperdibles.
- Los day-trips elegidos deben listarse en macro_tours.

REGLA MAESTRA 2 — TRANSPORTE INTELIGENTE (CRÍTICO):
- Evalúa opciones reales (tren/metro/bus interurbano) y sugiérelas cuando aplique.
- Si existe transporte público eficiente para un day-trip (tren rápido/bus frecuente y razonable), PRIORIZA transporte público sobre vehículo.
- Si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según zonas.

REGLA MAESTRA 3 — CLARIDAD TOTAL POR SUB-PARADAS (CRÍTICO):
- Para recorridos multi-parada (macro-tours o urbano), expresa secuencia como:
  "Destino – Sub-parada" o "Ruta/Área – Sub-parada".
- Cada sub-parada debe ser una fila con start/end, from/to, transport, duration y notes.
- from/to NO deben ir vacíos: completa ambos.

HORARIOS (CRÍTICO):
- Si el usuario define ventanas por día (day_hours) en el contexto, respétalas como base.
  Puedes ajustarlas inteligentemente para incluir experiencias clave (auroras/espectáculos) sin solapes.
- Si el usuario NO define day_hours:
  - NO inventes una plantilla rígida repetida (PROHIBIDO 08:30–19:00 fijo para todos).
  - Genera horarios realistas por filas (rows_draft) según ciudad/estación/ritmo.
- Buffers mínimos 15m entre bloques.
- Actividades diurnas NO entre 01:00–05:00.

✅ COMIDAS (GUÍA FLEXIBLE, NO PRIORITARIA):
- Las comidas NO son prioridad por defecto: inclúyelas solo cuando aporten valor real (logística, descanso, experiencia icónica o encaje natural en la ruta).
- Si el itinerario incluye comida, sugiere horarios locales razonables según el ritmo del día, sin imponer un bloque fijo diario.
- Evita placeholders genéricos como "Restaurante local" o "Café local": si recomiendas un lugar, debe ser identificable (nombre, food hall, calle/área clara con opciones).
- Si no puedes recomendar un lugar específico con confianza, omite la fila de comida y deja que el usuario la decida.

DURACIÓN EN 2 LÍNEAS (OBLIGATORIO EN TODAS LAS FILAS):
- duration debe ser SIEMPRE exactamente 2 líneas:
  "Transporte: <tiempo>"
  "Actividad: <tiempo>"
- Si no puedes estimar, NO inventes: usa
  "Transporte: Verificar duración en el Info Chat" o "Actividad: Verificar duración en el Info Chat"
  manteniendo el formato de 2 líneas.

MACRO-TOURS / DAY-TRIPS (CRÍTICO):
- Si incluyes un day-trip fuerte, ese día queda dedicado al tour.
- Debe tener 5–8 sub-paradas.
- Incluye explícitamente al cierre una fila: "Regreso a {ciudad base}" (con duración 2 líneas).
- No colocar day-trips duros el último día.
- NO generar duplicados bilingües del mismo tour/actividad.

LAGUNAS TERMALES (CRÍTICO):
- Mínimo 3 horas de actividad efectiva.
- Evalúa integración dentro de una ruta si aplica.

AURORAS (SOLO SI ES PLAUSIBLE):
- Valida plausibilidad por latitud y época del año.
- Si es plausible: máximo 1 por día, NO consecutivas, NUNCA en el último día, ventana local concreta, transporte coherente.

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.
- Si el usuario da referencias ("iglesia icónica"), infiere el POI más probable.

CRÍTICO — SALIDA PARA EVITAR REGRESIONES DEL PLANNER:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días) con:
  day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone.

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
- Si NO viene en el contexto del usuario, déjalo como [] (no lo inventes).
- Si SÍ viene, puedes devolverlo reflejando/ajustando (si extendiste noches por shows/auroras).
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
- from/to: si vienen vacíos, dedúcelos SOLO desde "Destino – Sub-parada" en activity (sin inventar).
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

/* ============== Cache helpers ============== */
function _cacheGet(key) {
  try {
    const v = __INFO_CACHE__.get(key);
    if (!v) return null;
    if (Date.now() > v.exp) {
      __INFO_CACHE__.delete(key);
      return null;
    }
    return v.data;
  } catch {
    return null;
  }
}

function _cacheSet(key, data) {
  try {
    __INFO_CACHE__.set(key, { exp: Date.now() + INFO_CACHE_TTL_MS, data });
  } catch {}
}

function _buildInfoCacheKey(context) {
  try {
    const c = context || {};
    const city = String(c.city || c.destination || "").trim().toLowerCase();
    const country = String(c.country || "").trim().toLowerCase();
    const days = String(c.days_total || c.days || c.daysTotal || "").trim();
    const hotel = String(c.hotel_base || c.hotel_address || c.hotel || "").trim().toLowerCase();
    const prefs = JSON.stringify(c.preferences || c.prefs || c.profile || {});
    const dates = JSON.stringify(c.dates || c.trip_dates || {});
    // Si quieres que cambios del user input invaliden cache:
    const user = JSON.stringify(c.user || c.user_input || c.input || "");
    return `${city}__${country}__${days}__${hotel}__${prefs}__${dates}__${user}`.slice(0, 1200);
  } catch {
    return "";
  }
}

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  let safeBody = {};
  let safeMode = "planner";
  try {
    safeBody = parseBody(req?.body);
    safeMode = String(safeBody?.mode || "planner").toLowerCase();
  } catch {}

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = safeBody;
    const mode = safeMode;

    if (!process.env.OPENAI_API_KEY) {
      if (mode === "info") {
        const context = body?.context || body || {};
        const fb = fallbackInfoJSON(context);
        return res.status(200).json({ text: JSON.stringify(fb) });
      }
      return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
    }

    /* --------- MODO INFO (motor interno) --------- */
    if (mode === "info") {
      const t0 = Date.now();

      let context = body.context;
      if (!context && Array.isArray(body.messages) && body.messages.length) context = { messages: body.messages };
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // Sanitizar day_hours plantilla rígida
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

      // Cache
      const cacheKey = _buildInfoCacheKey(context);
      if (cacheKey) {
        const cached = _cacheGet(cacheKey);
        if (cached) return res.status(200).json({ text: JSON.stringify(cached) });
      }

      const daysTotalHint = context?.days_total || context?.days || context?.daysTotal || 1;
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) Primer intento (sin cadena larga de retries)
      let parsed = null;
      try {
        const raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.22, 2200);
        parsed = cleanToJSONPlus(raw);
      } catch (e) {
        // timeout / error → fallback rápido
        parsed = null;
      }

      // 2) Si parseó, Quality Gate (1 retry máximo, si hay presupuesto)
      if (parsed) {
        try {
          const audit = _validateInfoResearch_(parsed, { days_total: daysTotalHint });

          if (!audit.ok && Date.now() - t0 < INFO_BUDGET_MS) {
            const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA:
Fallas:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.
REGLAS:
1) rows_draft debe cubrir 1..days_total.
2) activity NO puede ser genérica.
3) duration EXACTAMENTE 2 líneas.
4) Si hay macro-tour/day-trip: 5–8 sub-paradas + "Regreso a {ciudad}".
5) day_hours: NO lo inventes si no venía.
6) AURORAS: NO consecutivas y NUNCA el último día.

Responde SOLO JSON válido.
`.trim();

            let repaired = null;
            try {
              const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.20, 2200);
              repaired = cleanToJSONPlus(repairRaw);
            } catch {
              repaired = null;
            }
            if (repaired) parsed = repaired;
          }
        } catch {}
      }

      // 3) Enforcements locales (rápidos, sin modelo)
      if (parsed) parsed = _enforceInfoHardRules_(parsed, daysTotalHint);

      // 4) Si falta cobertura y hay presupuesto, 1 fill rápido (opcional y acotado)
      if (parsed && Date.now() - t0 < INFO_BUDGET_MS) {
        try {
          const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
          const missing = _missingDays_(rows, parsed?.days_total || daysTotalHint);

          if (missing.length && Date.now() - t0 < INFO_BUDGET_MS - 8000) {
            const fillPrompt = `
${SYSTEM_INFO}

TAREA EXTRA: faltan días ${missing.join(", ")}.
Genera SOLO filas para esos días, sin tocar las existentes.
Reglas: duration 2 líneas, from/to completos, sin genéricos, auroras no consecutivas ni último día.
Responde SOLO JSON válido.
`.trim();

            let filled = null;
            try {
              const fillRaw = await callText([{ role: "system", content: fillPrompt }, infoUserMsg], 0.20, 2400);
              filled = cleanToJSONPlus(fillRaw);
            } catch {
              filled = null;
            }

            if (filled && Array.isArray(filled.rows_draft)) {
              // merge simple: concat + sort por day/start (sin dedupe sofisticado para performance)
              const merged = [...rows, ...filled.rows_draft].sort((a, b) => {
                const da = Number(a?.day) || 0;
                const db = Number(b?.day) || 0;
                if (da !== db) return da - db;
                return String(a?.start || "").localeCompare(String(b?.start || ""));
              });
              parsed = { ...parsed, ...filled, rows_draft: merged };
              parsed = _enforceInfoHardRules_(parsed, daysTotalHint);
            }
          }
        } catch {}
      }

      // 5) Fallback si nada funcionó o excedió presupuesto
      if (!parsed || !Array.isArray(parsed?.rows_draft) || !parsed.rows_draft.length) {
        parsed = fallbackInfoJSON(context || {});
      }

      parsed = normalizeDurationsInParsed(parsed);

      if (cacheKey) _cacheSet(cacheKey, parsed);

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      // validate (no LLM)
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // ✅ FAST PATH: research_json.rows_draft → no LLM
      if (research && Array.isArray(research?.rows_draft) && research.rows_draft.length) {
        const det = _plannerDeterministicFromResearch_(research, body.target_day ?? null);
        if (det && Array.isArray(det.rows) && det.rows.length) {
          const out = normalizeDurationsInParsed(det);
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      }

      // Camino legado (mensajes del cliente, sin research_json)
      if (!research) {
        const clientMessages = extractMessages(body);

        let parsed = null;
        try {
          const raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.22, 1800);
          parsed = cleanToJSONPlus(raw);
        } catch {
          parsed = null;
        }

        if (!parsed) parsed = fallbackJSON();

        try {
          if (Array.isArray(parsed?.rows)) parsed.rows = _fillFromToFromActivity_(parsed.rows);
        } catch {}

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json directo) — si no disparó el fast path, usa LLM como backup
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

      let parsed = null;
      try {
        const raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.22, 1800);
        parsed = cleanToJSONPlus(raw);
      } catch {
        parsed = null;
      }

      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);
        if (!audit.ok) {
          // 1 retry máximo (solo si es recuperable y rápido)
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN OBLIGATORIA:
Fallas:
- ${audit.issues.join("\n- ")}

NO inventes actividades. Usa research_json.rows_draft como verdad.
Devuelve SOLO JSON válido.
`.trim();

          try {
            const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.18, 1800);
            const repaired = cleanToJSONPlus(repairRaw);
            if (repaired) parsed = repaired;
          } catch {}
        }
      }

      if (!parsed) parsed = fallbackJSON();

      try {
        if (Array.isArray(parsed?.rows)) parsed.rows = _fillFromToFromActivity_(parsed.rows);
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    try {
      if (safeMode === "info") {
        const context = safeBody?.context || safeBody || {};
        const fb = fallbackInfoJSON(context);
        return res.status(200).json({ text: JSON.stringify(fb) });
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
