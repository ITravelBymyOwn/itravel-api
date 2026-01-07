// /api/chat.js — v43.7.0 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v43.7.0 — FIX DEFINITIVO (quirúrgico):
// 1) PLANNER determinista (SIN IA) cuando viene research_json con rows_draft/rows_final.
//    -> Esto elimina regresiones, variabilidad y timeouts del modo planner.
// 2) Quality Gate INFO endurecido:
//    - Obliga formato "X – Y" (Destino – Sub-parada / Tour – Sub-parada) cuando aplique.
//    - Detecta macro-tours repartidos y exige 5+ sub-paradas en un SOLO día.
//    - Amplía lista de genéricos prohibidos (incluye "últimos paseos", etc.).
// 3) Mantiene tu regla: NO forzar ventanas rígidas de comidas; solo sugerir inteligentemente.

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

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const resp = await client.responses.create({
    model,
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

/* ============== Quality Gate (existente - endurecido quirúrgico) ============== */

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

  // Placeholders “típicos” que matan calidad (globales) — AMPLIADO
  const bad = [
    "museo de arte",
    "parque local",
    "cafe local",
    "restaurante local",
    "exploracion de la costa",
    "exploracion de la ciudad",
    "paseo por la ciudad",
    "recorrido por la ciudad",
    "ultimos paseos",
    "ultimas compras",
    "tiempo libre",
    "descanso",
    "caminata libre",
    "visita a cualquier lugar que no se haya visto",
    "visita a cualquier lugar",
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

// ✅ NUEVO: casi siempre queremos "X – Y" (Destino – Sub-parada / Tour – Sub-parada)
function _needsDashFormat_(activity) {
  const a = String(activity || "").trim();
  if (!a) return true;

  // Permitimos algunos casos raros, pero en general debe llevar " – "
  // (si el modelo quiere "Reykjavik – Auroras – Observación..." también vale)
  const allowNoDash = [
    /^check[-\s]?in\b/i,
    /^check[-\s]?out\b/i,
    /^traslado\b/i,
  ];

  if (allowNoDash.some((re) => re.test(a))) return false;
  return !a.includes("–") && !a.includes(" - ");
}

// ✅ NUEVO: detectar macro-tour por prefijo antes del dash
function _prefixBeforeDash_(activity) {
  const s = String(activity || "");
  const m = s.split("–");
  if (m.length >= 2) return String(m[0] || "").trim();
  const m2 = s.split(" - ");
  if (m2.length >= 2) return String(m2[0] || "").trim();
  return "";
}

// ✅ NUEVO: contar filas por día
function _countByDay_(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const d = Number(r?.day) || 1;
    map.set(d, (map.get(d) || 0) + 1);
  });
  return map;
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
    issues.push("hay placeholders genéricos en activity (ej. 'Últimos paseos', museo/parque/café/restaurante genérico).");

  // ✅ NUEVO: exigir formato con dash en la gran mayoría de filas
  if (rows.length && rows.some((r) => _needsDashFormat_(r.activity)))
    issues.push('hay filas sin formato "X – Y" en activity (obligatorio cuando tiene sentido).');

  // ✅ NUEVO: cada día debe tener sustancia (evita días con 1 sola fila floja)
  if (rows.length) {
    const byDay = _countByDay_(rows);
    for (let d = 1; d <= daysTotal; d++) {
      const n = byDay.get(d) || 0;
      if (n === 0) issues.push(`día ${d} sin filas.`);
      if (n === 1) issues.push(`día ${d} tiene solo 1 fila (itinerario insuficiente).`);
    }
  }

  /* =========================================================
     🆕 GUARD SEMÁNTICO — AURORAS
     ========================================================= */
  const auroraDays = rows
    .filter((r) => /auroras?|northern\s*lights/i.test(r.activity))
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
     🆕 GUARD SEMÁNTICO — MACRO-TOURS ÚNICOS + SUBPARADAS MÍNIMAS
     ========================================================= */
  const macroCanon = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

  // (A) macro repartido en varios días
  const macroDays = {};
  rows.forEach((r) => {
    const prefix = _prefixBeforeDash_(r.activity);
    const key = macroCanon(prefix);

    // Heurística: si el prefijo parece tour/zona (ej: "Círculo Dorado", "Península de Snæfellsnes")
    // o si el texto contiene señales de excursión.
    if (
      key &&
      (/\b(circulo\s*dorado|golden\s*circle|sn(a|æ)fellsnes|day\s*trip|excursion|tour)\b/i.test(key) ||
        /\b(circulo\s*dorado|golden\s*circle|sn(a|æ)fellsnes|day\s*trip|excursion|tour)\b/i.test(String(r.activity || "")))
    ) {
      macroDays[key] = macroDays[key] || new Set();
      macroDays[key].add(Number(r.day));
    }
  });

  Object.entries(macroDays).forEach(([k, days]) => {
    if (days.size > 1) {
      issues.push(`macro-tour "${k}" repartido en múltiples días (${[...days].join(", ")}).`);
    }
  });

  // (B) macro-tour debe tener 5+ subparadas en el día donde ocurre
  // Detectamos el "macro" por prefijo, y contamos cuántas filas hay con ese prefijo en ese día.
  try {
    const countByMacroDay = new Map(); // key: macro|day -> count
    rows.forEach((r) => {
      const d = Number(r.day) || 1;
      const prefix = _prefixBeforeDash_(r.activity);
      const key = macroCanon(prefix);
      if (!key) return;

      const isMacroLike =
        /\b(circulo\s*dorado|golden\s*circle|sn(a|æ)fellsnes|day\s*trip|excursion|tour)\b/i.test(key);

      if (!isMacroLike) return;

      const k = `${key}__${d}`;
      countByMacroDay.set(k, (countByMacroDay.get(k) || 0) + 1);
    });

    // Si hay un macro-like con menos de 5 filas, está mal (debe ser tour con sub-paradas)
    for (const [k, n] of countByMacroDay.entries()) {
      if (n > 0 && n < 5) {
        const parts = k.split("__");
        issues.push(`macro-tour "${parts[0]}" en día ${parts[1]} tiene solo ${n} filas (requiere 5–8 sub-paradas).`);
      }
    }
  } catch {}

  /* =========================================================
     🆕 GUARD SEMÁNTICO — DURACIÓN VS BLOQUE HORARIO
     ========================================================= */
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

/* ============== ✅ QUIRÚRGICO v43.6.1: Sanitizador de day_hours entrante ============== */
function _sanitizeIncomingDayHours_(day_hours, daysTotal) {
  try {
    if (!Array.isArray(day_hours) || !day_hours.length) return null;

    const need = Math.max(1, Number(daysTotal) || day_hours.length || 1);

    // Normalizar
    const norm = (t) => String(t || "").trim();
    const cleaned = day_hours.map((d, idx) => ({
      day: Number(d?.day) || idx + 1,
      start: norm(d?.start) || "",
      end: norm(d?.end) || "",
    }));

    // Si no hay ninguna hora real, no enviamos nada
    const hasAny = cleaned.some((d) => d.start || d.end);
    if (!hasAny) return null;

    // Si la longitud coincide con days y TODOS tienen start/end y son idénticos -> plantilla rígida -> eliminar
    if (cleaned.length === need) {
      const allHave = cleaned.every((d) => d.start && d.end);
      if (allHave) {
        const s0 = cleaned[0].start;
        const e0 = cleaned[0].end;
        const allSame = cleaned.every((d) => d.start === s0 && d.end === e0);
        if (allSame) return null;
      }
    }

    // Caso útil: ventanas parciales/diferentes -> se permiten como guía suave
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

    // Si hay filas, chequeos básicos (no destructivos)
    if (rows.length) {
      if (rows.some((r) => !_hasTwoLineDuration_(r?.duration))) {
        issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');
      }
      if (rows.some((r) => _isGenericPlaceholderActivity_(r?.activity))) {
        issues.push("hay placeholders genéricos en activity.");
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

/* ============== ✅ PLANNER determinista (SIN IA) ============== */

function _pad2_(n) {
  const x = String(n ?? "").trim();
  return x.length === 1 ? `0${x}` : x;
}

function _normHHMM_(t) {
  const s = String(t || "").trim();
  if (!s) return "";
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return `${_pad2_(hh)}:${_pad2_(mm)}`;
}

function _twoLineDurationOrFallback_(dur) {
  if (_hasTwoLineDuration_(dur)) return String(dur);
  return "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
}

function _isOutOfTown_(r) {
  const from = String(r?.from || "").trim();
  const to = String(r?.to || "").trim();
  if (from && to && _canonTxt_(from) !== _canonTxt_(to)) return true;

  // Heurística ligera: si el activity parece tour/excursión
  const a = String(r?.activity || "");
  if (/\b(circulo\s*dorado|golden\s*circle|sn(a|æ)fellsnes|day\s*trip|excursion|tour)\b/i.test(a)) return true;

  return false;
}

function _defaultTransport_(r) {
  if (String(r?.transport || "").trim()) return String(r.transport).trim();
  return _isOutOfTown_(r) ? "Vehículo alquilado o Tour guiado" : "A pie";
}

function _defaultNotes_(r) {
  const n = String(r?.notes || "").trim();
  if (n) return n;
  return "Actividad planificada. Confirma detalles/logística según tu ritmo.";
}

function _materializePlannerRowsDeterministic_(research, opts = {}) {
  const destination = String(research?.destination || research?.city || "Destino").trim() || "Destino";
  const sourceRows = Array.isArray(research?.rows_final)
    ? research.rows_final
    : Array.isArray(research?.rows_draft)
      ? research.rows_draft
      : [];

  if (!sourceRows.length) {
    return {
      destination,
      rows: [],
      followup: "⚠️ Falta rows_draft/rows_final en research_json. El Info Chat interno debe proveer rows_draft.",
    };
  }

  const targetDay = opts?.target_day != null ? Number(opts.target_day) : null;

  const rows = sourceRows
    .filter((r) => (targetDay ? Number(r?.day) === targetDay : true))
    .map((r) => {
      const day = Number(r?.day) || 1;
      const start = _normHHMM_(r?.start);
      const end = _normHHMM_(r?.end);

      return {
        day,
        start,
        end,
        activity: String(r?.activity || "").trim(),
        from: String(r?.from || "").trim(),
        to: String(r?.to || "").trim(),
        transport: _defaultTransport_(r),
        duration: _twoLineDurationOrFallback_(r?.duration),
        notes: _defaultNotes_(r),
        kind: String(r?.kind || "").trim(),
        zone: String(r?.zone || "").trim(),
        ...(r?._crossDay ? { _crossDay: r._crossDay } : {}),
      };
    });

  return { destination, rows, followup: "" };
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

REGLA MAESTRA 0 — FORMATO "DESTINO – SUB-PARADA" (CRÍTICO, APLICA A TODO):
- CADA fila debe tener activity en formato "X – Y" (con guion largo – preferido).
  Ejemplos:
  - "Reykjavik – Hallgrímskirkja (subida a la torre)"
  - "Círculo Dorado – Thingvellir (zona de grietas)"
  - "Península de Snæfellsnes – Kirkjufell (mirador)"
- NO uses actividades sueltas sin ese formato salvo excepciones muy raras (check-in/out).

REGLA MAESTRA 1 — IMPERDIBLES + ALCANCE REAL DEL VIAJE (CRÍTICO):
- Para cada ciudad base, identifica los **imperdibles reales** (POIs/experiencias icónicas) según temporada, clima probable, perfil del grupo (edades/movilidad), intereses y días disponibles.
- En estancias de varios días, diseña mezcla óptima de:
  (a) imperdibles urbanos y
  (b) day-trips/macro-rutas imperdibles desde la base,
  sin sacrificar lo esencial de la ciudad.
- Los imperdibles deben reflejarse en rows_draft y listarse también en imperdibles.
- Los day-trips elegidos deben listarse en macro_tours.

REGLA MAESTRA 2 — TRANSPORTE INTELIGENTE (CRÍTICO):
- Evalúa opciones reales (tren/metro/bus interurbano) y sugiérelas cuando aplique.
- Si no puedes determinar con confianza, usa EXACTAMENTE: "Vehículo alquilado o Tour guiado".
- Dentro de ciudad usa transporte coherente (a pie/metro/bus/taxi/uber) según zonas.

REGLA MAESTRA 3 — CLARIDAD TOTAL POR SUB-PARADAS (CRÍTICO):
- Para recorridos multi-parada (macro-tours o urbano), cada sub-parada es UNA fila.
- No entregues un macro-tour con 1 sola fila.

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
- Debe tener 5–8 sub-paradas (mínimo 5) con activity "Tour/Zona – Sub-parada".
- Incluye explícitamente al cierre una fila: "Regreso a {ciudad base}" (con duración 2 líneas).
- No colocar day-trips duros el último día.
- PROHIBIDO repartir el mismo macro-tour en múltiples días. Si aparece "Círculo Dorado", debe ocurrir en 1 solo día con sub-paradas dentro de ese día.

CENAS / COMIDAS:
- NO impongas ventanas rígidas. El agente debe sugerir de forma inteligente.
- Si incluyes cena, debe ir como "Ciudad – Cena en <nombre>" (y normalmente en ciudad base, no en medio de un tour lejano).

CALIDAD PREMIUM (PROHIBIDO GENÉRICO):
- Prohibido "Museo de Arte", "Parque local", "Café local", "Restaurante local", "Últimos paseos", "Tiempo libre" como actividad principal sin especificidad.
- Agrupa por zonas; evita “va y ven”.
- Si el usuario da referencias ("iglesia icónica"), infiere el POI más probable.

CRÍTICO — SALIDA:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días) con:
  day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone, opcional _crossDay.
- El Planner NO debe inventar.

NOTA day_hours:
- Si NO viene en el contexto del usuario, déjalo como [] (no lo inventes).
- Si SÍ viene, puedes devolverlo reflejando/ajustando (si extendiste noches por auroras/cenas show).

SALIDA (JSON) — estructura (sin texto fuera): (idéntica a la especificación original)
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
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"X – Y","from":"","to":"","transport":"","duration":"Transporte: ...\\nActividad: ...","notes":"...","kind":"","zone":""}
  ],
  "rows_skeleton":[
    {"day":1,"start":"","end":"","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}
  ]
}
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
- NO reescribas el texto de "activity": preserva el formato "X – Y" tal como viene.

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

      // ✅ QUIRÚRGICO v43.6.1: eliminar day_hours si parece plantilla rígida repetida
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
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.30, 3400);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.15, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Si parsea pero está flojo → Quality Gate + hasta 2 retries (quirúrgico)
      if (parsed) {
        const hintDays = context?.days_total || context?.days || context?.daysTotal || 1;
        let audit = _validateInfoResearch_(parsed, { days_total: hintDays });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA (QUALITY GATE):
Tu JSON anterior falló estas validaciones:
- ${audit.issues.join("\n- ")}

CORRIGE SIN TEXTO FUERA DEL JSON. REGLAS DURAS:
1) rows_draft debe cubrir todos los días 1..days_total y cada día debe tener un plan real (no 1 sola fila).
2) activity debe ser SIEMPRE "X – Y" (Destino – Sub-parada / Tour – Sub-parada). PROHIBIDO activity sin ese formato.
3) Prohibidos genéricos: "Últimos paseos", "Tiempo libre", "Restaurante local", etc.
4) Macro-tours: ocurren en 1 SOLO día y ese día debe tener mínimo 5 sub-paradas (ideal 6–8) + "Regreso a {ciudad base}" al final.
   Ejemplo correcto (mismo día): "Círculo Dorado – Thingvellir", "Círculo Dorado – Geysir", "Círculo Dorado – Gullfoss", ... + "Regreso a Reykjavik".
   Ejemplo incorrecto: repartir "Círculo Dorado" en día 2 y día 3.
5) Cenas: NO impongas ventanas rígidas. Si incluyes cena, debe ser "Reykjavik – Cena en <nombre>" y normalmente en la ciudad base.
6) duration SIEMPRE 2 líneas: "Transporte: ...\\nActividad: ..."

Responde SOLO JSON válido.
`.trim();

          // Retry 1
          const repairRaw1 = await callText([{ role: "system", content: repairPrompt }, infoUserMsg], 0.20, 3400);
          const repaired1 = cleanToJSONPlus(repairRaw1);
          if (repaired1) parsed = repaired1;

          audit = _validateInfoResearch_(parsed, { days_total: hintDays });

          // Retry 2 (último)
          if (!audit.ok) {
            const repairPrompt2 = `
${repairPrompt}

ÚLTIMO INTENTO: si no cumples, tu respuesta será descartada.
Asegura: macro-tours en 1 día con 5–8 filas + regreso; y TODOS los activity con formato "X – Y".
`.trim();

            const repairRaw2 = await callText([{ role: "system", content: repairPrompt2 }, infoUserMsg], 0.15, 3400);
            const repaired2 = cleanToJSONPlus(repairRaw2);
            if (repaired2) parsed = repaired2;
          }
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
      // ✅ QUIRÚRGICO v43.6.2: VALIDATE no debe llamar al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // ✅ v43.7.0: camino determinista (SIN IA) cuando viene research_json con rows_draft/rows_final
      if (research && (Array.isArray(research?.rows_draft) || Array.isArray(research?.rows_final))) {
        const out = _materializePlannerRowsDeterministic_(research, { target_day: body.target_day ?? null });

        // Validación local (no rompe)
        const audit = _validatePlannerOutput_({ rows: out.rows });
        if (!audit.ok) {
          // Si falla, aún devolvemos determinista + followup (no llamamos IA por estabilidad)
          out.followup = `⚠️ Planner determinista detectó issues: ${audit.issues.join(" | ")}`;
        }

        return res.status(200).json({
          text: JSON.stringify({
            destination: out.destination,
            rows: out.rows,
            followup: out.followup || "",
          }),
        });
      }

      // Camino legado (mensajes del cliente, sin research_json)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.30, 3000);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.15, 2600);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json directo) — si llega aquí es porque NO hay rows_draft/rows_final
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

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.30, 3000);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.15, 2600);
        parsed = cleanToJSONPlus(raw);
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
