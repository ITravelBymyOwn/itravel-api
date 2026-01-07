// /api/chat.js — v43.6.6 (ESM, Vercel)
// Doble etapa: INFO (investiga/decide) → PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// FIX v43.6.6: compatibilidad SDK OpenAI (responses.create si existe; si no, chat.completions.create).
// Además: cliente lazy-init SOLO si hay OPENAI_API_KEY (evita crashes y falsos fallbacks).

import OpenAI from "openai";

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

  try {
    return JSON.parse(raw);
  } catch {}

  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
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

/* Fallback INFO (para no romper Planner que exige rows_draft) */
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
      duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
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

/* ============== OpenAI client (lazy + compat) ============== */
function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    return new OpenAI({ apiKey: key });
  } catch {
    return null;
  }
}

// Llamada unificada (compat): intenta Responses API; si no, usa Chat Completions.
async function callText(client, messages, temperature = 0.35, max_output_tokens = 3200) {
  if (!client) throw new Error("OPENAI_CLIENT_UNAVAILABLE");

  // Consolidar a string (tu formato original)
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  // 1) Responses API (si existe)
  try {
    if (client.responses && typeof client.responses.create === "function") {
      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature,
        max_output_tokens,
        input: inputStr,
      });
      return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
    }
  } catch (e) {
    // Si Responses falla, probamos chat.completions
  }

  // 2) Chat Completions (fallback compatible)
  const resp2 = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    max_tokens: Math.min(4096, Math.max(256, Number(max_output_tokens) || 3200)),
    messages: [{ role: "user", content: inputStr }],
  });

  const txt = resp2?.choices?.[0]?.message?.content;
  return String(txt || "").trim();
}

// Normalizador de duraciones dentro del JSON ya parseado
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s = String(txt ?? "").trim();
    if (!s) return s;
    if (/^Transporte\s*:/i.test(s) || /^Actividad\s*:/i.test(s)) return s;
    if (/^~\s*\d+(\.\d+)?\s*h$/i.test(s)) return s;

    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if (dh) {
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours * 60);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }

    const hMix = s.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if (hMix) return `${hMix[1]}h${hMix[2]}m`;

    if (/^\d+\s*m$/i.test(s)) return s;
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

/* ============== Quality Gate / Helpers ============== */
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
  if (auroraDays.includes(daysTotal)) issues.push("auroras programadas en el último día (no permitido).");

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

  try {
    const byDay = new Map();
    rows.forEach((r) => {
      const d = Number(r?.day) || 0;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });

    for (let d = 1; d <= daysTotal; d++) {
      const dayRows = byDay.get(d) || [];
      const macroRows = dayRows.filter(
        (r) =>
          String(r?.kind || "").toLowerCase() === "macro_tour" ||
          /circulo\s*dorado|snæfellsnes|costa\s*sur|day\s*trip|excursion|tour\b/i.test(String(r?.activity || ""))
      );
      if (macroRows.length > 0 && macroRows.length < 5) {
        issues.push(`macro-tour en día ${d} tiene pocas sub-paradas (${macroRows.length}); requiere 5–8.`);
      }
    }
  } catch {}

  const toMin = (hhmm) => {
    const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };

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
    const s = toMin(r.start);
    const e = toMin(r.end);
    if (s == null || e == null) return;

    let block = e - s;
    if (block <= 0) block += 24 * 60;

    const dur = durFromText(r.duration);
    if (dur && dur < block * 0.7) issues.push(`duración inconsistente en día ${r.day} (${r.activity}).`);
  });

  return { ok: issues.length === 0, issues };
}

/* Sanitizador de day_hours entrante */
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

/* Planner output validator */
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

/* Merge rows_draft por día */
function _mergeRowsDraftByDay_(baseRows = [], addRows = []) {
  try {
    const out = [];
    const seen = new Set();

    const keyOf = (r) => {
      const day = Number(r?.day) || 0;
      const start = String(r?.start || "");
      const end = String(r?.end || "");
      const act = String(r?.activity || "");
      return `${day}__${start}__${end}__${act}`;
    };

    const pushUnique = (r) => {
      const k = keyOf(r);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(r);
    };

    (Array.isArray(baseRows) ? baseRows : []).forEach(pushUnique);
    (Array.isArray(addRows) ? addRows : []).forEach(pushUnique);

    out.sort((a, b) => {
      const da = Number(a?.day) || 0;
      const db = Number(b?.day) || 0;
      if (da !== db) return da - db;
      const sa = String(a?.start || "");
      const sb = String(b?.start || "");
      return sa.localeCompare(sb);
    });

    return out;
  } catch {
    return Array.isArray(baseRows) ? baseRows : [];
  }
}

/* Enforcements locales */
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
          !(
            String(r?.kind || "").toLowerCase() === "aurora" ||
            /auroras?|northern\s*lights/i.test(String(r?.activity || ""))
          )
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
      const isAur = String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || ""));
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
          duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
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

/* ============== Prompts del sistema (idénticos a tu v43.6.5) ============== */
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
- Si existe transporte público eficiente para un day-trip (p. ej. tren rápido/bus frecuente y razonable), PRIORIZA transporte público sobre vehículo.
- Si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según zonas.

REGLA MAESTRA 3 — CLARIDAD TOTAL POR SUB-PARADAS (CRÍTICO, APLICA A TODO):
- Para recorridos multi-parada (macro-tours o urbano), expresa secuencia como:
  "Destino – Sub-parada" o "Ruta/Área – Sub-parada".
- Cada sub-parada debe ser una fila con start/end, from/to, transport, duration y notes.
- from/to NO deben ir vacíos: completa ambos.

HORARIOS (CRÍTICO):
- Si el usuario define ventanas por día (day_hours) en el contexto, respétalas como base.
  Puedes ajustarlas inteligentemente para incluir experiencias clave (auroras/espectáculos/cenas icónicas),
  extendiendo horario nocturno sin solapes.
- Si el usuario NO define day_hours:
  - NO inventes una plantilla rígida repetida (PROHIBIDO 08:30–19:00 fijo para todos).
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

LAGUNAS TERMALES (CRÍTICO):
- Mínimo 3 horas de actividad efectiva.
- Evalúa integración dentro de una ruta si aplica.

AURORAS (SOLO SI ES PLAUSIBLE):
- Valida plausibilidad por latitud y época del año.
- Si es plausible: máximo 1 por día, NO consecutivas, NUNCA en el último día,
  ventana local concreta, transporte coherente.

NOCHES: ESPECTÁCULOS Y CENAS CON SHOW:
- Puedes sugerir experiencias nocturnas icónicas con frecuencia moderada.
- Comidas eficientes: incluye solo si aporta valor real (icónico/logística/pausa).

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.
- Si el usuario da referencias ("iglesia icónica"), infiere el POI más probable.

CRÍTICO — SALIDA PARA EVITAR REGRESIONES DEL PLANNER:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días) con:
  day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone, opcional _crossDay.

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
- Si SÍ viene, puedes devolverlo reflejando/ajustando (si extendiste noches por auroras/cenas show).
`.trim();

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

    // Sin key: fallback por modo (igual que tu v43.6.5)
    if (!process.env.OPENAI_API_KEY) {
      if (mode === "info") {
        const context = body?.context || body || {};
        return res.status(200).json({ text: JSON.stringify(fallbackInfoJSON(context)) });
      }
      return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
    }

    const client = getOpenAIClient();
    if (!client) {
      if (mode === "info") {
        const context = body?.context || body || {};
        return res.status(200).json({ text: JSON.stringify(fallbackInfoJSON(context)) });
      }
      return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
    }

    /* --------- MODO INFO --------- */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // Sanitizar day_hours “plantilla”
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

      const daysTotalHint = context?.days_total || context?.days || context?.daysTotal || 1;
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      let raw = await callText(client, [{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 4200);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText(client, [{ role: "system", content: strict }, infoUserMsg], 0.2, 4200);
        parsed = cleanToJSONPlus(raw);
      }

      if (parsed) {
        const audit = _validateInfoResearch_(parsed, { days_total: daysTotalHint });
        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

Corrige SIN texto fuera del JSON.
REGLAS:
1) rows_draft cubre 1..days_total.
2) NO genérico.
3) duration 2 líneas.
4) macro-tour: 5–8 sub-paradas + Regreso.
5) "Destino – Sub-parada".
6) day_hours: NO inventar si no venía.
7) Auroras: no consecutivas y no último día.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText(client, [{ role: "system", content: repairPrompt }, infoUserMsg], 0.25, 4200);
          const repaired = cleanToJSONPlus(repairRaw);

          if (repaired) {
            const auditR = _validateInfoResearch_(repaired, { days_total: daysTotalHint });
            parsed = repaired;
            if (!auditR.ok) parsed = _enforceInfoHardRules_(parsed, daysTotalHint);
          }
        }
      }

      // Fill missing days (1 llamada extra)
      if (parsed) {
        try {
          const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
          const missing = _missingDays_(rows, parsed?.days_total || daysTotalHint);

          if (missing.length) {
            const fillPrompt = `
${SYSTEM_INFO}

TAREA EXTRA (CRÍTICA): faltan días: ${missing.join(", ")}.
GENERA SOLO filas para esos días faltantes.
NO reescribas lo existente.
Mantén estructura completa.
duration 2 líneas.
day_hours: NO inventar.
Auroras: no consecutivas y no último día.
Incluye Regreso si hay macro-tour.
NO placeholders genéricos.

Responde SOLO JSON válido.
`.trim();

            const fillRaw = await callText(client, [{ role: "system", content: fillPrompt }, infoUserMsg], 0.28, 5200);
            const filled = cleanToJSONPlus(fillRaw);

            if (filled && Array.isArray(filled.rows_draft)) {
              const mergedRows = _mergeRowsDraftByDay_(rows, filled.rows_draft);
              parsed = {
                ...parsed,
                ...filled,
                rows_draft: mergedRows,
                day_hours: Array.isArray(parsed?.day_hours)
                  ? parsed.day_hours
                  : Array.isArray(filled?.day_hours)
                    ? filled.day_hours
                    : [],
              };
            }

            parsed = _enforceInfoHardRules_(parsed, daysTotalHint);

            const audit2 = _validateInfoResearch_(parsed, { days_total: daysTotalHint });
            if (!audit2.ok) {
              const lastTry = `
${SYSTEM_INFO}
ULTIMO INTENTO:
Fallas:
- ${audit2.issues.join("\n- ")}

Responde SOLO JSON válido.
`.trim();

              const lastRaw = await callText(client, [{ role: "system", content: lastTry }, infoUserMsg], 0.2, 5200);
              const lastParsed = cleanToJSONPlus(lastRaw);
              if (lastParsed) {
                parsed = _enforceInfoHardRules_(lastParsed, daysTotalHint);
              }
            }
          } else {
            parsed = _enforceInfoHardRules_(parsed, daysTotalHint);
          }
        } catch {}
      }

      if (!parsed) parsed = fallbackInfoJSON(context || {});
      else {
        try {
          if (!Array.isArray(parsed?.rows_draft) || !parsed.rows_draft.length) parsed = fallbackInfoJSON(context || {});
        } catch {}
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER --------- */
    if (mode === "planner") {
      // validate=true no llama al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // Legado sin research_json
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText(client, [{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.35, 3600);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText(client, [{ role: "system", content: strict }, ...clientMessages], 0.2, 3200);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        try {
          if (Array.isArray(parsed?.rows)) parsed.rows = _fillFromToFromActivity_(parsed.rows);
        } catch {}

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      const plannerUserPayload = {
        research_json: research,
        target_day: body.target_day ?? null,
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
      };

      const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload, null, 2) };

      let raw = await callText(client, [{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3600);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText(client, [{ role: "system", content: strict }, plannerUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);
        if (!audit.ok) {
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN:
Fallas:
- ${audit.issues.join("\n- ")}

NO inventes.
Usa research_json.rows_draft.
No reescribas activity.
from/to desde "Destino – Sub-parada".
duration 2 líneas.
NO genéricos.
day_hours soft.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText(client, [{ role: "system", content: repairPlanner }, plannerUserMsg], 0.25, 3600);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
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
        return res.status(200).json({ text: JSON.stringify(fallbackInfoJSON(context)) });
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
