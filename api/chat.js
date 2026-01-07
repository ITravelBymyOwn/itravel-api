// /api/chat.js — v43.6.9 (ESM, Vercel)
// Basado EXACTAMENTE en v43.6.2 (tu código) + cambios quirúrgicos:
// 1) PLANNER determinista si hay rows_draft/rows_final (cero llamadas al modelo).
// 2) INFO auto-completa SOLO días faltantes (target_day) si rows_draft no cubre 1..days_total.
// 3) Prompts más cortos y tokens más bajos para reducir tiempo.
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).

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
async function callText(messages, temperature = 0.25, max_output_tokens = 2400) {
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const resp = await client.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
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

    // Si viene como "Transporte: ...\nActividad: ...", dejar intacto
    if (/^Transporte\s*:/i.test(s) || /^Actividad\s*:/i.test(s)) return s;

    // No tocar si empieza con "~"
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
  const need = Math.max(1, Number(daysTotal) || 1);
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
  if (rows.length && !_rowsHaveCoverage_(rows, daysTotal))
    issues.push("rows_draft no cubre todos los días 1..days_total.");

  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration)))
    issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad") en una o más filas.');

  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity)))
    issues.push("hay placeholders genéricos en activity (ej. museo/parque/café/restaurante genérico).");

  // Guard auroras (igual que v43.6.2)
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
  if (auroraDays.includes(daysTotal)) issues.push("auroras programadas en el último día (no permitido).");

  return { ok: issues.length === 0, issues };
}

/* ============== ✅ v43.6.1: Sanitizador de day_hours entrante (igual) ============== */
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

/* ============== ✅ Planner validator (igual) ============== */
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

/* ============== Helpers extra (quirúrgicos) ============== */
function _missingDays_(rows, daysTotal) {
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set((rows || []).map((r) => Number(r?.day) || 1));
  const miss = [];
  for (let d = 1; d <= need; d++) if (!present.has(d)) miss.push(d);
  return miss;
}

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

function _hasTwoLineOrDefault_(d) {
  return _hasTwoLineDuration_(d)
    ? String(d)
    : "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat";
}

function _canon_(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function _isOutOfTown_(r) {
  const from = _canon_(r?.from);
  const to = _canon_(r?.to);
  if (from && to && from !== to) return true;

  const a = _canon_(r?.activity);
  if (/\b(day\s*trip|excursion|tour|golden\s*circle|circulo\s*dorado|sn(a|æ)fellsnes|south\s*coast)\b/i.test(a))
    return true;

  return false;
}

function _defaultTransport_(r) {
  const t = String(r?.transport || "").trim();
  if (t) return t;
  return _isOutOfTown_(r) ? "Vehículo alquilado o Tour guiado" : "A pie";
}

function _defaultNotes_(r) {
  const n = String(r?.notes || "").trim();
  return n || "Actividad planificada. Ajusta según tu ritmo.";
}

function _sortRows_(rows) {
  const toMin = (hhmm) => {
    const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return 99999;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  return [...rows].sort((a, b) => {
    const da = Number(a?.day) || 1;
    const db = Number(b?.day) || 1;
    if (da !== db) return da - db;
    return toMin(a?.start) - toMin(b?.start);
  });
}

// PLANNER determinista (si ya hay rows_draft/rows_final)
function _materializePlannerDeterministic_(research, target_day = null) {
  const destination = String(research?.destination || research?.city || "Destino").trim() || "Destino";
  const sourceRows = Array.isArray(research?.rows_final)
    ? research.rows_final
    : Array.isArray(research?.rows_draft)
      ? research.rows_draft
      : [];

  const td = target_day != null ? Number(target_day) : null;

  const rows = (sourceRows || [])
    .filter((r) => (td ? Number(r?.day) === td : true))
    .map((r) => ({
      day: Number(r?.day) || 1,
      start: _normHHMM_(r?.start),
      end: _normHHMM_(r?.end),
      activity: String(r?.activity || "").trim(),
      from: String(r?.from || "").trim(),
      to: String(r?.to || "").trim(),
      transport: _defaultTransport_(r),
      duration: _hasTwoLineOrDefault_(r?.duration),
      notes: _defaultNotes_(r),
      kind: String(r?.kind || "").trim(),
      zone: String(r?.zone || "").trim(),
      ...(r?._crossDay ? { _crossDay: r._crossDay } : {}),
    }));

  return { destination, rows, followup: "" };
}

/* ============== Prompts del sistema (MÁS CORTOS) ============== */

const SYSTEM_INFO = `
Eres el Info Chat interno premium de ITravelByMyOwn.
Devuelve SOLO 1 JSON válido (sin texto fuera).

OBLIGATORIO:
- rows_draft completo: cubre días 1..days_total (varias filas por día).
- activity con formato "Destino – Sub-parada" (no genérico).
- duration SIEMPRE 2 líneas:
  "Transporte: ...\\nActividad: ..."
- Si no sabes, usa "Verificar duración en el Info Chat" manteniendo 2 líneas.
- Si NO viene day_hours del usuario, NO lo inventes (devuelve []).
- Day-trips: 5–8 sub-paradas + última fila "Regreso a {ciudad base}". No último día.
- Auroras: no consecutivas, no último día, ventana nocturna.
`.trim();

const SYSTEM_PLANNER = `
Eres Astra Planner. NO creatividad.
Si research_json trae rows_draft/rows_final, úsalo como verdad:
solo normaliza HH:MM y completa campos faltantes (transport/notes/duration).
Salida SOLO JSON: { destination, rows, followup }.
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

      if (!context && Array.isArray(body.messages) && body.messages.length) context = { messages: body.messages };
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // Sanitizar day_hours rígido prellenado
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

      const daysTotalHint = Number(context?.days_total || context?.days || context?.daysTotal || 1);
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) Intento principal (rápido)
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.25, 2400);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto (1 sola vez)
      if (!parsed) {
        const strict = SYSTEM_INFO + "\nOBLIGATORIO: SOLO JSON válido.";
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.15, 2200);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Si parsea pero NO cubre días: completar SOLO faltantes (target_day)
      if (parsed) {
        const rows0 = Array.isArray(parsed?.rows_draft) ? parsed.rows_draft : [];
        const miss = _missingDays_(rows0, parsed?.days_total || daysTotalHint);

        if (miss.length) {
          const merged = [...rows0];

          for (const d of miss) {
            const perDayContext = {
              ...context,
              target_day: d,
            };

            const perDayMsg = { role: "user", content: JSON.stringify({ context: perDayContext }, null, 2) };

            const perDayPrompt = `
${SYSTEM_INFO}

MODO target_day OBLIGATORIO:
- Responde SOLO JSON válido.
- rows_draft debe contener SOLO filas con day=${d}.
- 4–7 filas reales (no genéricas).
- duration 2 líneas y activity "Destino – Sub-parada".
`.trim();

            const rawDay = await callText([{ role: "system", content: perDayPrompt }, perDayMsg], 0.18, 1400);
            const parsedDay = cleanToJSONPlus(rawDay);
            const dayRows = Array.isArray(parsedDay?.rows_draft)
              ? parsedDay.rows_draft.filter((r) => Number(r?.day) === d)
              : [];

            if (dayRows.length) merged.push(...dayRows);
          }

          parsed.rows_draft = _sortRows_(merged);
        }

        // Audit final (sin reintentos largos)
        const audit = _validateInfoResearch_(parsed, { days_total: parsed?.days_total || daysTotalHint });
        if (!audit.ok) {
          const prev = String(parsed?.followup || "").trim();
          const msg = `⚠️ INFO QualityGate: ${audit.issues.join(" | ")}`;
          parsed.followup = prev ? `${prev}\n${msg}` : msg;
        }
      }

      // 4) Fallback mínimo
      if (!parsed) {
        parsed = {
          destination: context?.city || "Destino",
          country: context?.country || "",
          days_total: daysTotalHint,
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
      // ✅ v43.6.2: validate no llama al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

      // ✅ CAMBIO CLAVE: si ya hay rows_draft/rows_final => determinista (cero modelo)
      if (research && (Array.isArray(research?.rows_draft) || Array.isArray(research?.rows_final))) {
        const out = _materializePlannerDeterministic_(research, body.target_day ?? null);

        const audit = _validatePlannerOutput_({ rows: out.rows });
        if (!audit.ok) out.followup = `⚠️ Planner determinista: ${audit.issues.join(" | ")}`;

        const finalObj = { destination: out.destination, rows: out.rows, followup: out.followup || "" };
        return res.status(200).json({ text: JSON.stringify(finalObj) });
      }

      // Camino legado (mensajes sin research_json)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.25, 2000);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + "\nOBLIGATORIO: SOLO JSON válido.";
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.15, 1800);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // research_json directo pero sin rows_draft/rows_final -> (último recurso) modelo
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

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.25, 2000);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + "\nOBLIGATORIO: SOLO JSON válido.";
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.15, 1800);
        parsed = cleanToJSONPlus(raw);
      }

      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);
        if (!audit.ok) {
          const prev = String(parsed?.followup || "").trim();
          const msg = `⚠️ Planner QualityGate: ${audit.issues.join(" | ")}`;
          parsed.followup = prev ? `${prev}\n${msg}` : msg;
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
