// /api/chat.js — v43.7.0 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v43.7.0 — Cambios quirúrgicos para corregir problemas reales observados:
// - FIX: PLANNER coverage hardening (si devuelve incompleto, server hace 1 repair + fill por días faltantes con target_day y merge).
// - INFO: refuerzo de "Regreso al hotel/alojamiento" al cierre de CADA día (si no contradice macro-tour).
// - INFO: regla anti "último día light" si no hay hora de salida/flight (asume día completo).
// - POST: encadenar from/to por día (si viene genérico/ciudad o vacío) sin inventar POIs.
// - INFO: notas con más impacto (sin inventar hechos, solo tono premium/motivación).
//
// Mantiene tu filosofía: no inventar POIs desde server; server solo corrige estructura/consistencia.

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

  // GUARD SEMÁNTICO — AURORAS
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

  // GUARD SEMÁNTICO — MACRO-TOURS ÚNICOS
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
    if (days.size > 1) {
      issues.push(`macro-tour "${k}" repartido en múltiples días (${[...days].join(", ")}).`);
    }
  });

  // GUARD SEMÁNTICO — MACRO-TOUR con pocas sub-paradas (<5)
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

  // GUARD SEMÁNTICO — DURACIÓN VS BLOQUE HORARIO
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

/* ============== Validación planner (existente) ============== */
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
        issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");
      }
      if (rows.some((r) => Number(r?.day) < 1 || !Number.isFinite(Number(r?.day)))) {
        issues.push("hay filas con 'day' inválido (<1 o no numérico).");
      }
    }

    return { ok: issues.length === 0, issues };
  } catch (e) {
    return { ok: true, issues: [] };
  }
}

/* ============== ✅ v43.6.3: Merge de rows_draft por día (preserva lo bueno) ============== */
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

/* ============== Enforcements locales (sin inventar POIs) ============== */
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

// ✅ NUEVO v43.7.0: Encadenar from/to por día cuando viene genérico o vacío (sin inventar POIs)
function _chainFromToByDay_(rows = [], baseCity = "") {
  try {
    if (!Array.isArray(rows) || rows.length < 2) return rows;

    const city = String(baseCity || "").trim();
    const byDay = new Map();
    rows.forEach((r) => {
      const d = Number(r?.day) || 0;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    });

    const out = [];
    const days = [...byDay.keys()].filter((d) => d > 0).sort((a, b) => a - b);

    const isReturnLike = (a) => /^(regreso|volver|return)\b/i.test(String(a || ""));

    days.forEach((d) => {
      const dayRows = (byDay.get(d) || []).slice();

      // Orden por start (si no hay, conserva)
      dayRows.sort((a, b) => String(a?.start || "").localeCompare(String(b?.start || "")));

      let prevTo = "";
      dayRows.forEach((r, idx) => {
        const row = { ...(r || {}) };

        const act = String(row.activity || "").trim();
        const from = String(row.from || "").trim();
        const to = String(row.to || "").trim();

        // No tocar la primera fila del día
        if (idx > 0) {
          const fromIsEmpty = !from;
          const fromIsGenericCity = city && from && _canonTxt_(from) === _canonTxt_(city);

          // Si hay prevTo real (no vacío) y el from viene vacío o “ciudad base” genérico,
          // y la actividad no es “Regreso ...”, entonces encadenamos.
          if (prevTo && (fromIsEmpty || fromIsGenericCity) && !isReturnLike(act)) {
            row.from = prevTo;
          }
        }

        // Actualizar prevTo si hay to usable
        if (to) prevTo = to;

        out.push(row);
      });
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
        (r) => !(String(r?.kind || "").toLowerCase() === "aurora" || /auroras?|northern\s*lights/i.test(String(r?.activity || "")))
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

    if (Array.isArray(parsed.rows_draft)) {
      parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);
    }

    parsed = _enforceAuroras_(parsed, total);
    parsed = _insertReturnRowIfMissing_(parsed, parsed?.destination);

    if (Array.isArray(parsed.rows_draft)) {
      parsed.rows_draft = _fillFromToFromActivity_(parsed.rows_draft);
    }

    return parsed;
  } catch {
    return parsed;
  }
}

/* ============== ✅ NUEVO v43.7.0: Merge de rows planner por día ============== */
function _mergePlannerRowsByDay_(baseRows = [], addRows = []) {
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
- Si existe transporte público eficiente para un day-trip, PRIORIZA transporte público sobre vehículo.
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

✅ REGLA NUEVA (CRÍTICA): CIERRE LOGÍSTICO AL FINAL DE CADA DÍA
- Al final de CADA día (urbano o tras macro-tour), incluye una fila corta tipo:
  "Regreso al hotel" / "Regreso al alojamiento" / "Regreso a la base"
  con from/to coherentes (desde el último lugar del día hacia "Hotel"/"Alojamiento"/base),
  para cerrar el día y facilitar el render de tablas.
- NO inventes dirección; usa "Hotel" o "Alojamiento" como destino si no hay nombre.
- Mantén duración 2 líneas.

✅ REGLA NUEVA (CRÍTICA): ÚLTIMO DÍA NO “LIGHT” SI NO HAY HORA DE SALIDA
- Si NO se provee hora de vuelo/salida/check-out en el contexto:
  asume que el día final también es aprovechable.
  Debe tener suficientes actividades (mínimo 3–5 bloques realistas) + cierre logístico.
- Solo haz “día corto” si hay una restricción explícita en el contexto.

LAGUNAS TERMALES (CRÍTICO):
- Mínimo 3 horas de actividad efectiva.

AURORAS (SOLO SI ES PLAUSIBLE):
- Valida plausibilidad por latitud y época del año.
- Si es plausible y preferAurora=true y days_total>=4:
  sugiere 2 oportunidades separadas (no consecutivas, nunca el último día) SI el clima/estación lo permite.
  Si no puedes sostener 2 con confianza, deja 1.
- Máximo 1 por día, NO consecutivas, NUNCA en el último día, ventana local concreta.

NOTAS (IMPACTO PREMIUM, SIN INVENTAR HECHOS):
- Las notes deben ser más emocionantes y motivadoras (tono premium), sin agregar datos falsos.
  Ej: "Imperdible: ..." / "Momento wow: ..." / "Te vas a enamorar de ..."

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.
- Si el usuario da referencias ("iglesia icónica"), infiere el POI más probable.

CRÍTICO — SALIDA PARA EVITAR REGRESIONES DEL PLANNER:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días).

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
- Si NO viene target_day: tu rows DEBE cubrir TODOS los días 1..days_total (no devuelvas solo un día).

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

      // v43.6.1: eliminar day_hours si parece plantilla rígida repetida
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

      // 1) Primer intento
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 4200);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 4200);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Quality Gate + 1 retry (máximo) — revalidar repaired
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, { days_total: daysTotalHint });

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
6) day_hours: NO lo inventes si no viene en el contexto; si no viene, déjalo como [].
7) AURORAS: NO consecutivas y NUNCA el último día.
8) CIERRE DEL DÍA: incluye "Regreso al hotel/alojamiento" al final de cada día.

Responde SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.25, 4200);
          const repaired = cleanToJSONPlus(repairRaw);

          if (repaired) {
            const auditR = _validateInfoResearch_(repaired, { days_total: daysTotalHint });
            parsed = repaired;

            if (!auditR.ok) {
              parsed = _enforceInfoHardRules_(parsed, daysTotalHint);
            }
          }
        }
      }

      // v43.6.3: Si aún falta cobertura → rellenar SOLO días faltantes (1 llamada extra)
      if (parsed) {
        try {
          const rows = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
          const missing = _missingDays_(rows, parsed?.days_total || daysTotalHint);

          if (missing.length) {
            const fillPrompt = `
${SYSTEM_INFO}

TAREA EXTRA (CRÍTICA): tu JSON NO cubre todos los días.
Debes GENERAR SOLAMENTE filas adicionales para los días faltantes: ${missing.join(", ")}.
REGLAS:
- NO modifiques ni reescribas las filas existentes.
- Devuelve un JSON VÁLIDO con la MISMA estructura completa, incluyendo rows_draft.
- rows_draft final debe cubrir TODOS los días 1..days_total.
- from/to NO deben quedar vacíos.
- duration siempre 2 líneas.
- AURORAS: NO consecutivas y NUNCA el último día.
- Incluye "Regreso a {ciudad base}" al cierre de macro-tours.
- Incluye "Regreso al hotel/alojamiento" al final de cada día.
- NO inventes day_hours si no venía en el contexto (déjalo []).
- NO uses placeholders genéricos.

Responde SOLO JSON válido.
`.trim();

            const fillRaw = await callText([{ role: "system", content: fillPrompt }, infoUserMsg], 0.28, 5200);
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
ULTIMO INTENTO OBLIGATORIO:
Tu salida DEBE cubrir 1..days_total y pasar QualityGate.
Fallas detectadas:
- ${audit2.issues.join("\n- ")}

Responde SOLO JSON válido, sin texto fuera.
`.trim();

              const lastRaw = await callText([{ role: "system", content: lastTry }, infoUserMsg], 0.2, 5200);
              const lastParsed = cleanToJSONPlus(lastRaw);
              if (lastParsed) {
                parsed = lastParsed;
                parsed = _enforceInfoHardRules_(parsed, daysTotalHint);
              }
            }
          } else {
            parsed = _enforceInfoHardRules_(parsed, daysTotalHint);
          }
        } catch {}
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
          constraints: {
            max_substops_per_tour: 8,
            respect_user_preferences_and_conditions: true,
            thermal_lagoons_min_stay_minutes: 180,
          },
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
      // v43.6.2: VALIDATE no debe llamar al modelo
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

        try {
          if (Array.isArray(parsed?.rows)) {
            parsed.rows = _fillFromToFromActivity_(parsed.rows);
            parsed.rows = _chainFromToByDay_(parsed.rows, parsed?.destination || "");
          }
        } catch {}

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      const daysTotal = Number(research?.days_total || research?.daysTotal || research?.days || 1);

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
- from/to: si vienen vacíos, dedúcelos SOLO desde "Destino – Sub-parada" (sin inventar).
- duration en 2 líneas obligatorias: "Transporte: ...\\nActividad: ..."
- Elimina placeholders genéricos.
- day_hours: NO lo inventes ni lo impongas; solo úsalo como guía si viene del usuario.
- Si NO viene target_day: tu rows DEBE cubrir TODOS los días 1..days_total.

Devuelve SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPlanner }, plannerUserMsg], 0.25, 3600);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      if (!parsed) parsed = fallbackJSON();

      // ✅ v43.7.0: HARDEN cobertura planner cuando target_day es null
      try {
        const targetDay = body.target_day ?? null;

        if (targetDay == null) {
          const rows0 = Array.isArray(parsed?.rows) ? parsed.rows : [];
          const missing = _missingDays_(rows0, daysTotal);

          // 1) 1 repair explícito si falta cobertura
          if (missing.length) {
            const covRepair = `
${SYSTEM_PLANNER}

REPARACIÓN DE COBERTURA (CRÍTICA):
Tu salida NO cubre todos los días.
Debes devolver rows con TODOS los días 1..days_total (${daysTotal}), sin faltar ninguno.
NO inventes actividades: usa research_json.rows_draft como verdad y estructura todo.
Devuelve SOLO JSON válido.
`.trim();

            const covRepairRaw = await callText([{ role: "system", content: covRepair }, plannerUserMsg], 0.2, 3600);
            const covRepaired = cleanToJSONPlus(covRepairRaw);
            if (covRepaired && Array.isArray(covRepaired.rows) && covRepaired.rows.length) {
              parsed = covRepaired;
            }
          }

          // 2) Si aún falta: fill por día faltante usando target_day (server-side) y merge
          const rows1 = Array.isArray(parsed?.rows) ? parsed.rows : [];
          const missing2 = _missingDays_(rows1, daysTotal);

          if (missing2.length) {
            let merged = rows1.slice();

            for (const d of missing2) {
              const dayPayload = {
                research_json: research,
                target_day: d,
                day_hours: body.day_hours ?? null,
                existing_rows: body.existing_rows ?? null,
              };

              const dayMsg = { role: "user", content: JSON.stringify(dayPayload, null, 2) };

              const dayRaw = await callText([{ role: "system", content: SYSTEM_PLANNER }, dayMsg], 0.25, 2200);
              const dayParsed = cleanToJSONPlus(dayRaw);

              if (dayParsed && Array.isArray(dayParsed.rows) && dayParsed.rows.length) {
                merged = _mergePlannerRowsByDay_(merged, dayParsed.rows);
              }
            }

            parsed = {
              ...(parsed || {}),
              destination: String(parsed?.destination || research?.destination || research?.city || "").trim(),
              rows: merged,
              followup: String(parsed?.followup || "").trim(),
            };
          }
        }
      } catch {}

      // Completar from/to + encadenar por día (sin inventar)
      try {
        if (Array.isArray(parsed?.rows)) {
          parsed.rows = _fillFromToFromActivity_(parsed.rows);
          parsed.rows = _chainFromToByDay_(parsed.rows, parsed?.destination || research?.destination || research?.city || "");
        }
      } catch {}

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
