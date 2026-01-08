// /api/chat.js — v51.4 (ESM, Vercel)
// Basado EXACTAMENTE en v51.3. Ajustes quirúrgicos solicitados:
// - Comidas: libres; si se incluyen, NO fijar restaurante en activity/from/to; notes debe dar 3 opciones.
// - Transporte: si no hay certeza de tiempo, se permite "Depende del lugar" en la línea Transporte.
// - Actividad: SIEMPRE debe incluir tiempo estimado (no "Depende..." ni "Verificar..." en Actividad).
// Mantiene: { text: "<JSON>" } siempre.
// Mantiene: SOLO city_day en INFO y en PLANNER.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===================== Utils ===================== */
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
    city_day: [
      {
        city: "Desconocido",
        day: 1,
        rows: [
          {
            day: 1,
            start: "09:00",
            end: "11:00",
            activity: "Desconocido – Itinerario base (fallback)",
            from: "Hotel",
            to: "Centro",
            transport: "Caminando",
            duration: "Transporte: Depende del lugar\nActividad: ~1h–2h",
            notes: "⚠️ Fallback: revisa OPENAI_API_KEY o despliegue. Explora libremente y ajusta en el Info Chat.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o despliegue.",
  };
}

/* ===================== Responses API call (con timeout) ===================== */
async function callText(messages, temperature = 0.3, max_output_tokens = 2600, timeoutMs = 55000) {
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await client.responses.create(
      {
        model: "gpt-4o-mini",
        temperature,
        max_output_tokens,
        input: inputStr,
      },
      { signal: controller.signal }
    );

    return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
  } catch (e) {
    return "";
  } finally {
    clearTimeout(t);
  }
}

/* ===================== Normalización de duraciones ===================== */
function normalizeDurationsInParsed(parsed) {
  if (!parsed) return parsed;

  const norm = (txt) => {
    const s0 = String(txt ?? "").trim();
    if (!s0) return s0;

    // ✅ Si viene con coma "Transporte: X,Actividad: Y" => 2 líneas
    const commaTwoLine = s0.match(/^\s*Transporte\s*:\s*([^,\n]+)\s*,\s*Actividad\s*:\s*([^\n]+)\s*$/i);
    if (commaTwoLine) {
      return `Transporte: ${commaTwoLine[1].trim()}\nActividad: ${commaTwoLine[2].trim()}`;
    }

    // Si ya cumple 2 líneas, dejamos
    if (/Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s0)) return s0;

    // Acepta "~3h–5h" etc.
    if (/^~\s*\d+(\.\d+)?\s*h/i.test(s0)) return s0;

    // Normaliza "2 h" => "2h"
    const dh = s0.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if (dh) {
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours * 60);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
    }

    const hMix = s0.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if (hMix) return `${hMix[1]}h${hMix[2]}m`;

    if (/^\d+\s*m$/i.test(s0)) return s0;
    if (/^\d+\s*h$/i.test(s0)) return s0;

    return s0;
  };

  const touchRows = (rows = []) => rows.map((r) => ({ ...r, duration: norm(r.duration) }));

  try {
    if (Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);

    if (Array.isArray(parsed.city_day)) {
      parsed.city_day = parsed.city_day.map((b) => ({
        ...b,
        rows: Array.isArray(b.rows) ? touchRows(b.rows) : b.rows,
      }));
    }

    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows,
        city_day: Array.isArray(d.city_day)
          ? d.city_day.map((b) => ({ ...b, rows: Array.isArray(b.rows) ? touchRows(b.rows) : b.rows }))
          : d.city_day,
      }));
    }
  } catch {}

  return parsed;
}

/* ===================== Canon helpers ===================== */
function _canonTxt_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _hasTwoLineDuration_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
}

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set(rows.map((r) => Number(r.day) || 1));
  for (let d = 1; d <= need; d++) {
    if (!present.has(d)) return false;
  }
  return true;
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
    "museos y cultura",
    "museos y cultura local",
  ];

  if (t.length <= 10 && /^(museo|parque|cafe|restaurante|plaza|mercado)$/i.test(t)) return true;
  if (bad.some((b) => t === b || t.includes(b))) return true;
  if (/^(museo|parque|cafe|restaurante)\b/i.test(t) && t.split(" ").length <= 3) return true;

  return false;
}

function _activityHasDestDash_(activity) {
  const s = String(activity || "");
  return /\s[–-]\s/.test(s);
}

function _isAurora_(activity) {
  return /auroras?|aurora|northern\s*lights/i.test(String(activity || ""));
}

function _isMacroTourKey_(activity) {
  const t = _canonTxt_(activity);
  return /golden circle|circulo dorado|day trip|excursion|tour\b|sur de islandia|south iceland|snaefellsnes|sn[aæ]fellsnes/i.test(
    t
  );
}

function _parseTimeToMin_(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function _isNightWindow_(startHHMM, endHHMM) {
  const s = _parseTimeToMin_(startHHMM);
  const e = _parseTimeToMin_(endHHMM);
  if (s == null || e == null) return false;

  const isNightPoint = (min) => min >= 18 * 60 || min < 5 * 60;

  if (e <= s) return isNightPoint(s) || isNightPoint(e);
  return isNightPoint(s) && isNightPoint(e);
}

function _hasZeroTransport_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*0m/i.test(s);
}

function _hasNA_(s) {
  const t = String(s || "").trim().toLowerCase();
  return t === "n/a" || t === "na" || t.includes("n/a");
}

function _isValidHHMM_(t) {
  const m = String(t || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

function _rowMinutesSpan_(row) {
  const s = _parseTimeToMin_(row?.start);
  const e = _parseTimeToMin_(row?.end);
  if (s == null || e == null) return null;
  if (e < s) return e + 24 * 60 - s;
  return e - s;
}

function _durationLine_(duration, which /* 'transporte'|'actividad' */) {
  const s = String(duration || "");
  const re = which === "transporte" ? /Transporte\s*:\s*([^\n]+)/i : /Actividad\s*:\s*([^\n]+)/i;
  const m = s.match(re);
  return m ? String(m[1] || "").trim() : "";
}

function _looksLikeTimeEstimate_(txt) {
  const t = String(txt || "").trim();
  if (!t) return false;
  // acepta: 45m, 1h, 1h30m, ~2h, ~3h–5h, 2h-3h
  if (/[~]?\s*\d+\s*(h|m)\b/i.test(t)) return true;
  if (/[~]?\s*\d+\s*h\s*\d+\s*m/i.test(t)) return true;
  if (/[~]?\s*\d+\s*h\s*[–-]\s*\d+\s*h/i.test(t)) return true;
  if (/[~]?\s*\d+\s*m\s*[–-]\s*\d+\s*m/i.test(t)) return true;
  return false;
}

function _transportDurationOk_(durationTransportLine) {
  const t = _canonTxt_(durationTransportLine);
  if (!t) return false;
  if (t.includes("depende del lugar")) return true; // ✅ permitido
  if (t.includes("verificar duracion en el info chat")) return true; // último recurso
  return _looksLikeTimeEstimate_(durationTransportLine);
}

function _activityDurationOk_(durationActivityLine) {
  const t = _canonTxt_(durationActivityLine);
  if (!t) return false;
  // ❌ No permitido para actividad
  if (t.includes("depende del lugar")) return false;
  if (t.includes("verificar duracion en el info chat")) return false;
  return _looksLikeTimeEstimate_(durationActivityLine);
}

function _auroraNotesOk_(notes) {
  const t = _canonTxt_(notes);
  if (!t) return false;
  const hasValid = t.includes("valid");
  const hasWeather = t.includes("clima") || t.includes("nubos") || t.includes("nubes") || t.includes("pronost");
  const hasAlt = t.includes("alternativa") || t.includes("low cost") || t.includes("mirador") || t.includes("zona oscura");
  return hasValid && hasWeather && hasAlt;
}

function _auroraTransportOk_(transport) {
  const t = _canonTxt_(transport);
  return t.includes("vehiculo") && (t.includes("tour") || t.includes("guiad"));
}

function _isMeal_(activity) {
  return /(desayuno|almuerzo|cena)/i.test(String(activity || ""));
}

function _mealNotesHaveThreeOptions_(notes) {
  const s = String(notes || "");
  const t = _canonTxt_(notes);
  if (!t) return false;

  // buscamos "opciones" y al menos 3 ítems (•, -, 1), o separados por ;
  const hasOpciones = t.includes("opciones");
  const bullets = (s.match(/[•\-\u2022]\s+/g) || []).length;
  const numbered = (s.match(/\b(1|2|3)[\)\.]\s+/g) || []).length;

  // fallback: "Opción:" repetida
  const opcionWord = (t.match(/\bopcion\b/g) || []).length;

  // fallback: separado por comas después de "Opciones:"
  let commaCount = 0;
  const idx = t.indexOf("opciones");
  if (idx >= 0) {
    const tail = s.slice(Math.max(0, idx), idx + 250);
    commaCount = (tail.match(/,/g) || []).length;
  }

  return hasOpciones && (bullets >= 3 || numbered >= 3 || opcionWord >= 3 || commaCount >= 2);
}

/* ===================== day_hours sanitizer ===================== */
function _sanitizeIncomingDayHours_(day_hours, daysTotal) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return null;

    const need = Math.max(1, Number(daysTotal) || day_hours.length || 1);
    const norm = (t) => String(t || "").trim();

    // Acepta formato objeto [{day,start,end}] y también string ["09:00-18:00", ...]
    const cleaned = day_hours.map((d, idx) => {
      if (typeof d === "string") {
        const m = d.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        return {
          day: idx + 1,
          start: m ? m[1] : "",
          end: m ? m[2] : "",
        };
      }
      return {
        day: Number(d?.day) || idx + 1,
        start: norm(d?.start) || "",
        end: norm(d?.end) || "",
      };
    });

    const hasAny = cleaned.some((d) => d.start || d.end);
    if (!hasAny) return null;

    // Si vienen todos iguales, lo consideramos "no aportante" (deja que AI decida)
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

/* ===================== city_day helpers ===================== */
function _flattenCityDayBlocks_(city_day) {
  const blocks = Array.isArray(city_day) ? city_day : [];
  const out = [];
  blocks
    .map((b) => ({
      city: String(b?.city || b?.destination || "").trim(),
      day: Number(b?.day) || 1,
      rows: Array.isArray(b?.rows) ? b.rows : [],
    }))
    .sort((a, b) => a.day - b.day)
    .forEach((b) => {
      b.rows.forEach((r) => out.push({ ...r, day: Number(r.day) || b.day || 1 }));
    });
  return out;
}

function _normalizeCityDayShape_(city_day, destinationFallback = "") {
  const blocks = Array.isArray(city_day) ? city_day : [];
  const out = blocks
    .map((b, idx) => ({
      city: String(b?.city || b?.destination || destinationFallback || "").trim(),
      day: Number(b?.day) || idx + 1,
      rows: Array.isArray(b?.rows) ? b.rows : [],
    }))
    .sort((a, b) => a.day - b.day);

  out.forEach((b) => {
    b.rows = (Array.isArray(b.rows) ? b.rows : []).map((r) => ({ ...r, day: Number(r?.day) || b.day }));
  });

  return out;
}

/* ===================== Quality Gate INFO (valida SOLO city_day) ===================== */
function _validateInfoResearch_(parsed, contextHint = {}) {
  const issues = [];
  const daysTotal = Math.max(1, Number(parsed?.days_total || contextHint?.days_total || 1));
  const destination = String(parsed?.destination || contextHint?.destination || contextHint?.city || "").trim();

  const hasCityDay = Array.isArray(parsed?.city_day) && parsed.city_day.length;
  if (!hasCityDay) issues.push("city_day vacío o ausente (obligatorio).");

  const rows = hasCityDay ? _flattenCityDayBlocks_(parsed.city_day) : [];
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal)) issues.push("No cubre todos los días 1..days_total.");

  // Duración 2 líneas + sin N/A + sin 0m
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push("duration no cumple 2 líneas.");
  if (rows.length && rows.some((r) => _hasNA_(r.duration))) issues.push('duration contiene "N/A" (prohibido).');
  if (rows.length && rows.some((r) => _hasZeroTransport_(r.duration))) issues.push('hay "Transporte: 0m" (prohibido).');

  // Activity quality
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("placeholders genéricos en activity.");
  if (rows.length && rows.some((r) => !_activityHasDestDash_(r.activity))) issues.push('activity sin "Destino – Sub-parada".');

  // from/to/transport
  if (rows.length && rows.some((r) => !String(r.from || "").trim() || !String(r.to || "").trim())) issues.push("from/to vacíos.");
  if (rows.length && rows.some((r) => !String(r.transport || "").trim())) issues.push("transport vacío.");
  if (rows.length && rows.some((r) => _hasNA_(r.transport))) issues.push('transport contiene "N/A" (prohibido).');

  // start/end obligatorios
  if (rows.length && rows.some((r) => !_isValidHHMM_(r.start) || !_isValidHHMM_(r.end)))
    issues.push("start/end faltan o no están en HH:MM.");

  // Duration lines: Transporte puede ser "Depende del lugar"; Actividad NO.
  if (rows.length) {
    const badTransportLine = rows.some((r) => !_transportDurationOk_(_durationLine_(r.duration, "transporte")));
    if (badTransportLine) issues.push("línea 'Transporte:' debe ser estimación realista o 'Depende del lugar' (o Verificar solo si imposible).");

    const badActivityLine = rows.some((r) => !_activityDurationOk_(_durationLine_(r.duration, "actividad")));
    if (badActivityLine) issues.push("línea 'Actividad:' debe contener SIEMPRE una estimación de tiempo (no 'Depende...' ni 'Verificar...').");
  }

  // Notes obligatorias
  if (rows.length && rows.some((r) => !String(r.notes || "").trim())) issues.push("notes vacías (obligatorias).");

  // Meals: si aparecen, no fijar un lugar en activity/from/to y notes debe dar 3 opciones
  const mealRows = rows.filter((r) => _isMeal_(r.activity));
  if (mealRows.length) {
    const hasSpecificTo = mealRows.some((r) => {
      const to = _canonTxt_(r.to);
      const act = _canonTxt_(r.activity);
      // Si "to" es un nombre propio o demasiado específico, intentamos detectarlo de forma heurística:
      // permitimos "zona gastronomica", "a eleccion", "centro", "barrio", "area", "waterfront", etc.
      const allowed = ["zona", "gastronom", "a eleccion", "a elección", "centro", "barrio", "area", "área", "waterfront", "puerto", "downtown"];
      const looksAllowed = allowed.some((k) => to.includes(_canonTxt_(k)));
      // si to tiene 2+ palabras con mayúsculas típicamente sería nombre, pero aquí no tenemos mayúsculas (canon). usamos longitud y no-allowed
      const tooSpecific = !looksAllowed && to.split(" ").length >= 2 && to.length >= 10;
      // activity también debe ser genérica de comida (no "Cena en X")
      const actTooSpecific = /cena en\s+/i.test(String(r.activity || "")) || /almuerzo en\s+/i.test(String(r.activity || "")) || /desayuno en\s+/i.test(String(r.activity || ""));
      return tooSpecific || actTooSpecific;
    });
    if (hasSpecificTo) issues.push("comidas: no fijar restaurante/lugar en activity/from/to (solo en notes como opciones).");

    const missingOptions = mealRows.some((r) => !_mealNotesHaveThreeOptions_(r.notes));
    if (missingOptions) issues.push("comidas: notes deben incluir 'Opciones:' con 3 alternativas para elegir.");
  }

  // Auroras
  const auroraRows = rows.filter((r) => _isAurora_(r.activity));
  const auroraDays = auroraRows.map((r) => Number(r.day) || 1).sort((a, b) => a - b);

  for (let i = 1; i < auroraDays.length; i++) {
    if (auroraDays[i] === auroraDays[i - 1] + 1) {
      issues.push("auroras en días consecutivos (evitar; solo si no hay alternativa).");
      break;
    }
  }
  if (auroraDays.includes(daysTotal)) issues.push("auroras en el último día (evitar; solo condicional si no hay alternativa).");

  if (auroraRows.some((r) => !_isNightWindow_(r.start, r.end))) issues.push("auroras fuera de ventana nocturna (prohibido).");
  if (auroraRows.some((r) => !_auroraTransportOk_(r.transport)))
    issues.push('aurora: transport debe reflejar "Vehículo ... o Tour guiado ...".');
  if (auroraRows.some((r) => !_auroraNotesOk_(r.notes)))
    issues.push('aurora: notes deben incluir "valid:" + clima/nubosidad + alternativa low-cost.');

  // Macro-tours por día + anti-duplicado
  const baseCity = String(parsed?.destination || contextHint?.destination || "").trim() || destination;
  const byDay = new Map();
  rows.forEach((r) => {
    const d = Number(r.day) || 1;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  });

  const macroSeen = new Map();
  for (let d = 1; d <= daysTotal; d++) {
    const dayRows = byDay.get(d) || [];
    const hasMacro = dayRows.some((r) => _isMacroTourKey_(r.activity));
    if (!hasMacro) continue;

    const dayText = _canonTxt_(dayRows.map((r) => r.activity).join(" | "));
    let macroKey = "";
    if (dayText.includes("golden circle") || dayText.includes("circulo dorado")) macroKey = "golden_circle";
    else if (dayText.includes("snaefellsnes") || dayText.includes("snæfellsnes")) macroKey = "snaefellsnes";
    else if (dayText.includes("sur de islandia") || dayText.includes("south iceland")) macroKey = "south_iceland";
    else macroKey = "macro_generic";

    if (macroSeen.has(macroKey)) {
      issues.push(`macro-tour repetido (${macroKey}) en días ${macroSeen.get(macroKey)} y ${d} (evitar).`);
    } else {
      macroSeen.set(macroKey, d);
    }

    const macroishCount = dayRows.filter(
      (r) =>
        _isMacroTourKey_(r.activity) ||
        _canonTxt_(r.zone).includes("circulo") ||
        _canonTxt_(r.zone).includes("golden") ||
        _canonTxt_(r.activity).includes("sur de islandia") ||
        _canonTxt_(r.activity).includes("south iceland") ||
        _canonTxt_(r.activity).includes("snaefellsnes")
    ).length;

    if (macroishCount < 5) issues.push(`macro-tour en día ${d} con <5 sub-paradas (debe 5–8).`);

    const hasReturn = dayRows.some((r) => {
      const a = _canonTxt_(r.activity);
      return a.includes("regreso") && (baseCity ? a.includes(_canonTxt_(baseCity)) : true);
    });
    if (!hasReturn) issues.push(`macro-tour en día ${d} sin "Regreso a ${baseCity || "ciudad base"}".`);

    if (d === daysTotal) issues.push("macro-tour/day-trip en el último día (no permitido).");
  }

  // Coherencia básica: bloques largos no pueden tener Actividad demasiado corta
  try {
    const badSpan = rows.some((r) => {
      const span = _rowMinutesSpan_(r);
      const actLine = _durationLine_(r.duration, "actividad");
      if (span == null) return false;
      if (span < 240) return false; // solo validamos bloques largos
      // si el bloque es muy largo, la actividad debe verse acorde (~3h o más)
      // heurística: si no contiene rango o >=3h, es sospechoso
      const canon = _canonTxt_(actLine);
      const has3h = /\b3\s*h\b/.test(canon) || canon.includes("~3h") || canon.includes("3h");
      const hasRange = /[–-]\s*\d+\s*h/i.test(actLine);
      return !(has3h || hasRange);
    });
    if (badSpan) issues.push("inconsistencia: bloque horario largo pero duración de Actividad no refleja un bloque largo.");
  } catch {}

  return { ok: issues.length === 0, issues };
}

/* ===================== Prompts ===================== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn.
Debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera).

OBJETIVO:
1) Planifica el itinerario completo (evita repeticiones/contradicciones).
2) Devuelve city_day[] (Ciudad–Día) ORDENADO y COMPLETO 1..days_total.

REGLA CLAVE:
- Genera TODO lo necesario para completar la tabla del frontend: cada fila debe tener start y end (HH:MM), además de activity/from/to/transport/duration/notes.

CONTRATO filas (OBLIGATORIO):
- start/end: "HH:MM" (24h). Horarios realistas con buffers 10–20m.
- activity: "DESTINO – SUB-PARADA" (– o - con espacios)
- from/to/transport NO vacíos (PROHIBIDO "N/A")
- duration SIEMPRE 2 líneas:
  "Transporte: <estimación realista>" o "Transporte: Depende del lugar" si NO se puede inferir con certeza
  "Actividad: <estimación realista SIEMPRE>"  (PROHIBIDO "Depende del lugar" y PROHIBIDO "Verificar..." en Actividad)
  Solo si es imposible estimar Transporte: puedes usar "Verificar duración en el Info Chat" (como excepción).
- PROHIBIDO "Transporte: 0m" y PROHIBIDO "N/A" en duration/transport.
- Notes OBLIGATORIAS en cada fila: tono motivador y concreto (no genérico), con tips logísticos (ropa, reservas, seguridad, mejor momento).

COMIDAS (Libre, con regla de presentación):
- Puedes incluir comidas si aportan valor al ritmo del día, pero NO son obligatorias.
- Si incluyes comida:
  1) NO pongas un restaurante específico en activity/from/to (NO "Cena en X"). Usa algo neutral:
     - activity: "{Ciudad} – Cena" (o Almuerzo/Desayuno)
     - to: "Zona gastronómica (a elección)" o "Centro (a elección)"
  2) En notes debes dar "Opciones:" con 3 alternativas reales (3 nombres) para que el usuario elija.
  3) Horario realista: cena ~19:00–21:30; almuerzo ~12:00–14:30.

DAY-TRIPS / MACRO-TOURS:
- Si propones un macro-tour/day-trip: 5–8 sub-paradas.
- Debe terminar con "Regreso a {Destino}" como última sub-parada del día.
- No repitas el mismo macro-tour en otro día.
- No en el último día.

AURORAS (Regla Flexible + research/inferencia obligatoria):
- Solo sugerir si PLAUSIBLE por latitud + temporada aproximada (según fechas).
- NO fijes horas por defecto: infiere ventana típica local (picos) y asigna start/end coherentes (noche).
- Duración típica del tour/caza: infiere realista para el destino/época (no 1h).
- transport debe reflejar dualidad:
  "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)".
- Evita días consecutivos si hay alternativas.
- Evita último día; si solo cabe, márcalo como CONDICIONAL en notes.
- Notes de aurora OBLIGATORIAS: incluir "valid:" (latitud/temporada) + dependencia de clima/nubosidad + alternativa low-cost (mirador oscuro cercano).

SALIDA mínima:
{
  "destination":"Ciudad",
  "country":"País",
  "days_total":N,
  "hotel_base":"...",
  "rationale":"...",
  "imperdibles":[],
  "macro_tours":[],
  "meals_suggestions":[],
  "aurora":{"plausible":false,"suggested_days":[],"window_local":{"start":"","end":""},"duration":"...","transport_default":"Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)","note":""},
  "constraints":{"max_substops_per_tour":8,"no_consecutive_auroras":true,"no_last_day_aurora":true,"thermal_lagoons_min_stay_minutes":180},
  "day_hours":[],
  "city_day":[{"city":"Ciudad","day":1,"rows":[...]}],
  "rows_skeleton":[]
}

Responde SOLO JSON válido.
`.trim();

const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json".
Fuente de verdad: research_json (NO inventes POIs).
Tu tarea es devolver city_day limpio y utilizable por el frontend.

REGLA:
- Usa SOLO research_json.city_day como fuente.
- NO uses rows_draft ni rows, aunque existan.

Salida:
{ "destination":"Ciudad", "city_day":[...], "followup":"" }
`.trim();

/* ===================== Handler ===================== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = parseBody(req.body);
    const mode = String(body.mode || "planner").toLowerCase();

    /* ===================== INFO ===================== */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // day_hours: si no aporta, se elimina (deja libre a la IA)
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

      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.28, 3800, 55000);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3400, 45000);
        parsed = cleanToJSONPlus(raw);
      }

      if (parsed) {
        const audit = _validateInfoResearch_(parsed, {
          days_total: context?.days_total || context?.days || context?.daysTotal || 1,
          destination: context?.city || parsed?.destination || "",
          city: context?.city || "",
        });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA:
Fallos detectados:
- ${audit.issues.join("\n- ")}

Instrucciones de reparación:
- Corrige SIN inventar marcas comerciales. Si incluyes opciones de comida, deben ser 3 nombres reales y van SOLO en notes.
- Si no puedes estimar Transporte con certeza: usa "Depende del lugar" (no "N/A").
- Actividad SIEMPRE debe tener tiempo estimado (no "Depende..." ni "Verificar...").
- Ajusta horarios start/end y duration para coherencia.
- Macro-tours: 5–8 sub-paradas + "Regreso a {Destino}".
- Auroras: NO consecutivas, transport dual, notes con valid+clima/nubosidad+alternativa low-cost, duración típica realista.

Devuelve SOLO JSON válido.
`.trim();

          const repairRaw = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.22, 4200, 55000);
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
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
          meals_suggestions: [],
          aurora: {
            plausible: false,
            suggested_days: [],
            window_local: { start: "", end: "" },
            transport_default: "Vehículo alquilado (por cuenta propia) o Tour guiado (según duración/pickup)",
            note: "Condicional por clima/nubosidad.",
            duration: "~3h–5h",
          },
          constraints: {
            max_substops_per_tour: 8,
            no_consecutive_auroras: true,
            no_last_day_aurora: true,
            thermal_lagoons_min_stay_minutes: 180,
          },
          day_hours: [],
          city_day: [],
          rows_skeleton: [],
          followup: "⚠️ No se pudo generar un itinerario válido. Intenta nuevamente.",
        };
      }

      // ✅ Asegurar forma city_day (y limpiar campos legacy)
      try {
        const destinationFallback = String(parsed?.destination || context?.city || "").trim();
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
        if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
        if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;
      } catch {
        if (!Array.isArray(parsed.city_day)) parsed.city_day = [];
        if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
        if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;
      }

      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* ===================== PLANNER ===================== */
    if (mode === "planner") {
      const research = body.research_json || null;

      if (!research) {
        const clientMessages = extractMessages(body);
        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.25, 2400, 45000);
        let parsed = cleanToJSONPlus(raw);
        if (!parsed) parsed = fallbackJSON();

        const destinationFallback = String(parsed?.destination || "").trim();
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destinationFallback);
        if ("rows_draft" in parsed) delete parsed.rows_draft;
        if ("rows" in parsed) delete parsed.rows;

        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      const destination = String(research?.destination || research?.city || body?.destination || "").trim() || "Destino";

      // ✅ SOLO city_day como fuente de verdad
      let city_day = _normalizeCityDayShape_(research?.city_day, destination);

      // Último recurso legacy rows
      if ((!Array.isArray(city_day) || !city_day.length) && Array.isArray(research?.rows) && research.rows.length) {
        const byDay = new Map();
        research.rows.forEach((r) => {
          const d = Number(r?.day) || 1;
          if (!byDay.has(d)) byDay.set(d, []);
          byDay.get(d).push({ ...r, day: d });
        });
        city_day = [...byDay.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([day, rows]) => ({ city: destination, day, rows }));
        city_day = _normalizeCityDayShape_(city_day, destination);
      }

      const out = {
        destination,
        city_day,
        followup: "",
      };

      const normalized = normalizeDurationsInParsed(out);
      return res.status(200).json({ text: JSON.stringify(normalized) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
