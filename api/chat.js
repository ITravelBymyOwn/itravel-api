// /api/chat.js — v43.7.1 (ESM, Vercel)
// Doble etapa: (1) INFO (investiga y decide) → (2) PLANNER (estructura/valida).
// Respuestas SIEMPRE como { text: "<JSON|texto>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v43.7.1 — FIX QUIRÚRGICO (tu error actual):
// - INFO SIEMPRE entrega rows_draft (no vacío) con cobertura 1..days_total.
//   Aunque el modelo falle, devuelva "rows" o devuelva un JSON incompleto.
//
// (Mantiene v43.7.0)
// 1) Respuestas API robusto: responses.create -> chat.completions.
// 2) PLANNER si falla: construye rows LOCALMENTE desde research_json.rows_draft.
// 3) Fallback INFO real (rows_draft por día).
// 4) Catch respeta mode y devuelve fallback correcto por modo.
// 5) validate=true en planner: no llama al modelo.

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

/* ✅ Fallback INFO real (rows_draft 1..days_total) */
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
      notes: "⚠️ El Info Chat interno no pudo generar este día. Revisa despliegue / SDK / OPENAI_API_KEY.",
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
    followup: "⚠️ Fallback INFO: revisa despliegue / SDK / OPENAI_API_KEY.",
  };
}

/* ============== OpenAI call robusto ============== */
async function callText(messages, temperature = 0.35, max_output_tokens = 3200) {
  const inputStr = (Array.isArray(messages) ? messages : [])
    .map((m) => {
      const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
      return `${String(m?.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  try {
    if (client?.responses?.create) {
      const resp = await client.responses.create({
        model: "gpt-4o-mini",
        temperature,
        max_output_tokens,
        input: inputStr,
      });

      const out =
        resp?.output_text?.trim() ||
        resp?.output?.[0]?.content?.[0]?.text?.trim() ||
        "";
      if (out) return out;
    }
  } catch {}

  try {
    const cmessages = (Array.isArray(messages) ? messages : []).map((m) => ({
      role: m?.role === "system" ? "system" : m?.role === "assistant" ? "assistant" : "user",
      content: typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""),
    }));

    const resp2 = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature,
      max_tokens: Math.min(4096, Math.max(256, Number(max_output_tokens) || 1200)),
      messages: cmessages,
    });

    return resp2?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    throw e;
  }
}

/* ============== Normalizador de duraciones ============== */
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
  } catch {}

  return parsed;
}

/* ============== Helpers / validaciones ============== */
function _hasTwoLineDuration_(duration) {
  const s = String(duration || "");
  return /Transporte\s*:\s*.*\nActividad\s*:\s*/i.test(s);
}

function _rowsHaveCoverage_(rows, daysTotal) {
  if (!Array.isArray(rows) || !rows.length) return false;
  const need = Math.max(1, Number(daysTotal) || 1);
  const present = new Set(rows.map((r) => Number(r?.day) || 1));
  for (let d = 1; d <= need; d++) {
    if (!present.has(d)) return false;
  }
  return true;
}

/* ============== v43.6.1: Sanitizador de day_hours entrante ============== */
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

/* =======================
   ✅ v43.7.1: ENFORCER rows_draft SIEMPRE
   ======================= */
function _ensureInfoRowsDraft_(parsed, context = {}) {
  const ctx = context && typeof context === "object" ? context : {};
  const city = String(parsed?.destination || ctx?.city || ctx?.destination || "Destino").trim() || "Destino";
  const country = String(parsed?.country || ctx?.country || "").trim();
  const daysTotal = Math.max(1, Number(parsed?.days_total || ctx?.days_total || ctx?.days || ctx?.daysTotal || 1));

  // 1) Si no hay parsed, fallback total
  if (!parsed || typeof parsed !== "object") {
    return fallbackInfoJSON({ city, country, days_total: daysTotal });
  }

  // 2) Si el modelo devolvió "rows" en vez de "rows_draft", lo convertimos
  if ((!Array.isArray(parsed.rows_draft) || !parsed.rows_draft.length) && Array.isArray(parsed.rows) && parsed.rows.length) {
    parsed.rows_draft = parsed.rows.map((r) => ({
      day: Number(r?.day) || 1,
      start: String(r?.start || ""),
      end: String(r?.end || ""),
      activity: String(r?.activity || ""),
      from: String(r?.from || ""),
      to: String(r?.to || ""),
      transport: String(r?.transport || ""),
      duration: String(r?.duration || "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat"),
      notes: String(r?.notes || ""),
      kind: String(r?.kind || ""),
      zone: String(r?.zone || ""),
    }));
  }

  // 3) Si sigue vacío/ausente, lo construimos mínimo por día
  if (!Array.isArray(parsed.rows_draft) || !parsed.rows_draft.length) {
    const fb = fallbackInfoJSON({ city, country, days_total: daysTotal });
    // conservamos algunos campos si existen
    return {
      ...fb,
      destination: city,
      country,
      days_total: daysTotal,
      hotel_base: String(parsed?.hotel_base || fb.hotel_base || ""),
      rationale: String(parsed?.rationale || fb.rationale || "Fallback mínimo (INFO)."),
      imperdibles: Array.isArray(parsed?.imperdibles) ? parsed.imperdibles : fb.imperdibles,
      macro_tours: Array.isArray(parsed?.macro_tours) ? parsed.macro_tours : fb.macro_tours,
      in_city_routes: Array.isArray(parsed?.in_city_routes) ? parsed.in_city_routes : fb.in_city_routes,
      meals_suggestions: Array.isArray(parsed?.meals_suggestions) ? parsed.meals_suggestions : fb.meals_suggestions,
      aurora: parsed?.aurora && typeof parsed.aurora === "object" ? parsed.aurora : fb.aurora,
      constraints: parsed?.constraints && typeof parsed.constraints === "object" ? parsed.constraints : fb.constraints,
      day_hours: Array.isArray(parsed?.day_hours) ? parsed.day_hours : [],
      followup: String(parsed?.followup || fb.followup || ""),
    };
  }

  // 4) Forzar days_total y cobertura 1..daysTotal
  parsed.destination = city;
  parsed.country = country;
  parsed.days_total = daysTotal;

  // Normalizar duration a 2 líneas siempre
  parsed.rows_draft = parsed.rows_draft.map((r) => {
    const dur = String(r?.duration || "");
    return {
      day: Number(r?.day) || 1,
      start: String(r?.start || ""),
      end: String(r?.end || ""),
      activity: String(r?.activity || ""),
      from: String(r?.from || city),
      to: String(r?.to || ""),
      transport: String(r?.transport || ""),
      duration: _hasTwoLineDuration_(dur)
        ? dur
        : "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
      notes: String(r?.notes || ""),
      kind: String(r?.kind || ""),
      zone: String(r?.zone || ""),
    };
  });

  // Si faltan días, añadimos 1 fila por día faltante (mínimo renderizable)
  if (!_rowsHaveCoverage_(parsed.rows_draft, daysTotal)) {
    const present = new Set(parsed.rows_draft.map((r) => Number(r?.day) || 1));
    for (let d = 1; d <= daysTotal; d++) {
      if (!present.has(d)) {
        parsed.rows_draft.push({
          day: d,
          start: "",
          end: "",
          activity: `Fallback – Día ${d} pendiente`,
          from: city,
          to: city,
          transport: "",
          duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
          notes: "⚠️ Día faltante generado por enforcer (INFO).",
          kind: "",
          zone: "",
        });
      }
    }
  }

  // rows_skeleton mínimo coherente
  if (!Array.isArray(parsed.rows_skeleton)) parsed.rows_skeleton = [];
  if (!parsed.rows_skeleton.length) {
    parsed.rows_skeleton = parsed.rows_draft.map((r) => ({
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
    }));
  }

  // day_hours: NO inventar
  if (!Array.isArray(parsed.day_hours)) parsed.day_hours = [];

  return parsed;
}

/* ============== Prompts (idénticos a tu base) ============== */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn: un **experto mundial en turismo** con criterio premium para diseñar itinerarios que se sientan como un **sueño cumplido**.
Tu objetivo es entregar un plan **impactante, optimizado, realista, secuencial y altamente claro**, maximizando el valor del viaje.
Tu salida será consumida por un Planner que **no inventa nada**: solo estructura y renderiza lo que tú decidas.
Por eso debes devolver **UN ÚNICO JSON VÁLIDO** (sin texto fuera) listo para usarse en tabla.

✅ ARQUITECTURA (OPCIÓN A):
- Tú (INFO) eres la **fuente de verdad** de los horarios: start/end por fila en rows_draft.
- El Planner solo valida/ajusta solapes pequeños; NO genera ventanas ni rellena horarios por defecto.

CRÍTICO — SALIDA PARA EVITAR REGRESIONES DEL PLANNER:
- Incluye SIEMPRE rows_draft completo (todas las filas de todos los días) con:
  day, start, end, activity, from, to, transport, duration(2 líneas), notes, kind, zone, opcional _crossDay.

NOTA day_hours:
- Si NO viene en el contexto del usuario, déjalo como [] (no lo inventes).
`.trim();

const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un objeto "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo es **estructurar y validar** para renderizar en tabla. **NO aportes creatividad.**

SALIDA ÚNICA (JSON):
{
  "destination":"Ciudad",
  "rows":[
    {"day":1,"start":"HH:MM","end":"HH:MM","activity":"","from":"","to":"","transport":"","duration":"","notes":"","kind":"","zone":""}
  ],
  "followup":""
}
`.trim();

/* ============== Local planner builder (igual que v43.7.0) ============== */
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

function _buildPlannerRowsFromResearch_(research, target_day = null) {
  const dest = String(research?.destination || research?.city || "Destino").trim() || "Destino";
  const rowsDraft = Array.isArray(research?.rows_draft)
    ? research.rows_draft
    : Array.isArray(research?.rows_final)
      ? research.rows_final
      : [];

  if (!rowsDraft.length) {
    return { destination: dest, rows: fallbackJSON().rows, followup: "⚠️ PLANNER fallback: research_json sin rows_draft." };
  }

  let rows = rowsDraft.map((r) => ({
    day: Number(r?.day) || 1,
    start: String(r?.start || ""),
    end: String(r?.end || ""),
    activity: String(r?.activity || ""),
    from: String(r?.from || ""),
    to: String(r?.to || ""),
    transport: String(r?.transport || ""),
    duration: String(r?.duration || "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat"),
    notes: String(r?.notes || ""),
    kind: String(r?.kind || ""),
    zone: String(r?.zone || ""),
  }));

  if (target_day != null && Number.isFinite(Number(target_day))) {
    const td = Number(target_day);
    rows = rows.filter((r) => Number(r.day) === td);
  }

  rows = _fillFromToFromActivity_(rows);

  rows = rows.map((r) => {
    const dur = String(r.duration || "");
    if (_hasTwoLineDuration_(dur)) return r;
    return { ...r, duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat" };
  });

  return { destination: dest, rows, followup: "" };
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

      if (mode === "planner" && body?.research_json) {
        const local = _buildPlannerRowsFromResearch_(body.research_json, body?.target_day ?? null);
        return res.status(200).json({ text: JSON.stringify(local) });
      }

      return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
    }

    /* --------- INFO --------- */
    if (mode === "info") {
      let context = body.context;

      if (!context && Array.isArray(body.messages) && body.messages.length) {
        context = { messages: body.messages };
      }
      if (!context && !Array.isArray(body.messages)) {
        const { mode: _m, ...rest } = body || {};
        context = rest;
      }

      // v43.6.1: day_hours sanitizado
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

      let raw = "";
      let parsed = null;

      // 1) intento normal
      try {
        raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.35, 3800);
        parsed = cleanToJSONPlus(raw);
      } catch {
        parsed = null;
      }

      // 2) intento estricto si no parsea
      if (!parsed) {
        try {
          const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3600);
          parsed = cleanToJSONPlus(raw);
        } catch {
          parsed = null;
        }
      }

      // 3) ENFORCER: SIEMPRE rows_draft + cobertura
      parsed = _ensureInfoRowsDraft_(parsed, context || {});
      parsed = normalizeDurationsInParsed(parsed);

      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- PLANNER --------- */
    if (mode === "planner") {
      // validate=true no llama al modelo
      try {
        if (body && body.validate === true && Array.isArray(body.rows)) {
          const out = { allowed: body.rows, rejected: [] };
          return res.status(200).json({ text: JSON.stringify(out) });
        }
      } catch {}

      const research = body.research_json || null;

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

      const plannerUserPayload = {
        research_json: research,
        target_day: body.target_day ?? null,
        day_hours: body.day_hours ?? null,
        existing_rows: body.existing_rows ?? null,
      };

      const plannerUserMsg = { role: "user", content: JSON.stringify(plannerUserPayload, null, 2) };

      let raw = "";
      let parsed = null;

      try {
        raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.35, 3600);
        parsed = cleanToJSONPlus(raw);
      } catch {
        parsed = null;
      }

      if (!parsed) {
        try {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo un JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3200);
          parsed = cleanToJSONPlus(raw);
        } catch {
          parsed = null;
        }
      }

      // Si el modelo falla o rows viene vacío => builder local desde research_json
      if (!parsed || !Array.isArray(parsed?.rows) || !parsed.rows.length) {
        const local = _buildPlannerRowsFromResearch_(research, body?.target_day ?? null);
        const out = normalizeDurationsInParsed(local);
        return res.status(200).json({ text: JSON.stringify(out) });
      }

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

      if (safeMode === "planner" && safeBody?.research_json) {
        const local = _buildPlannerRowsFromResearch_(safeBody.research_json, safeBody?.target_day ?? null);
        return res.status(200).json({ text: JSON.stringify(local) });
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
