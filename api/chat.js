// /api/chat.js — v43.6 (ESM, Vercel)
// Doble etapa: (1) INFO (decide) → (2) PLANNER (estructura).
// Respuestas SIEMPRE como { text: "<JSON>" }.
// ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
//
// ✅ v43.6 — Fix principal:
// - Reduce probabilidad de TIMEOUT en INFO (prompt más compacto + menos tokens + menos reintentos).
// - Fuerza salida JSON (response_format json_object) para bajar parse/repair.
// - Mantiene contratos (rows_draft / rows) y Quality Gate, pero más eficiente.

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

/**
 * Llamada unificada a Responses API:
 * - input consolidado (texto)
 * - fuerza JSON cuando se pide (response_format json_object)
 */
async function callText(messages, temperature = 0.25, max_output_tokens = 2400, forceJson = false) {
  const inputStr = messages
    .map((m) => {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${String(m.role || "user").toUpperCase()}: ${c}`;
    })
    .join("\n\n");

  const payload = {
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: inputStr,
  };

  // Enforce JSON si el SDK/endpoint lo soporta
  if (forceJson) {
    payload.response_format = { type: "json_object" };
  }

  const resp = await client.responses.create(payload);

  return resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";
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
  const need = Number(daysTotal) || 1;

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
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push('duration no cumple formato 2 líneas ("Transporte" + "Actividad").');
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("hay placeholders genéricos en activity.");

  return { ok: issues.length === 0, issues };
}

function _validatePlannerOutput_(parsed) {
  const issues = [];
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];

  if (!rows.length) issues.push("rows vacío o ausente.");
  if (rows.length && rows.some((r) => !_hasTwoLineDuration_(r.duration))) issues.push("duration no cumple 2 líneas.");
  if (rows.length && rows.some((r) => _isGenericPlaceholderActivity_(r.activity))) issues.push("hay placeholders genéricos en activity.");

  return { ok: issues.length === 0, issues };
}

/* ============== Prompts del sistema ============== */

/* =======================
   SISTEMA — INFO CHAT (interno) (COMPACTO)
   ======================= */
const SYSTEM_INFO = `
Eres el **Info Chat interno** de ITravelByMyOwn (experto mundial en turismo, criterio premium).
Debes devolver **SOLO UN JSON VÁLIDO** (sin texto fuera) listo para tabla.

OBJETIVO:
- Construir itinerario realista, secuencial y optimizado para **days_total** días.
- Incluir imperdibles + (si aplica) day-trips/macro-rutas, sin sacrificar lo esencial.

REGLAS DURAS:
1) Debes incluir SIEMPRE "rows_draft" con TODAS las filas de TODOS los días (day 1..days_total).
2) Cada fila trae: day,start,end,activity,from,to,transport,duration,notes,kind,zone.
3) duration SIEMPRE exactamente 2 líneas:
   "Transporte: <tiempo>\\nActividad: <tiempo>"
4) Prohibido genérico: NO "Museo de Arte", NO "Parque local", NO "Café local", NO "Restaurante local".
5) Para recorridos multi-parada usa activity tipo "Destino – Sub-parada".
6) Macro-tour/day-trip fuerte: 5–8 sub-paradas + última fila "Regreso a {ciudad base}".
7) Auroras SOLO si plausible; máximo 1 por día; NO consecutivas; NO último día.
8) Lagunas termales mínimo 3h de actividad efectiva.

INPUT:
Recibirás { context: {...} } con city, country, days_total, day_hours (si existe), transport_preference, travelers, preferences, special_conditions.
Respeta day_hours si viene (puedes extender noche SOLO si hace falta para auroras/show/cena icónica, sin solapes).
`.trim();

/* =======================
   SISTEMA — PLANNER (estructurador)
   ======================= */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes "research_json" del Info Chat interno.
El Info Chat YA DECIDIÓ: actividades, orden, tiempos, transporte y notas.
Tu trabajo es **estructurar y validar** para renderizar en tabla. **NO aportes creatividad.**

CONTRATO:
- Si research_json incluye rows_draft (o rows_final), esas filas son la verdad.
  Usa esas filas y SOLO:
  (a) normaliza HH:MM,
  (b) buffers >=15m cuando falten,
  (c) corrige solapes pequeños moviendo minutos,
  (d) completa campos faltantes SIN inventar POIs/actividades.

- NO reescribas "activity" (preserva "Destino – Sub-parada").
- duration 2 líneas obligatorias:
  "Transporte: Xm\\nActividad: Ym"

SALIDA ÚNICA (JSON):
{ "destination":"", "rows":[ ... ], "followup":"" }

MODO ACOTADO:
- Si viene "target_day", devuelve SOLO filas de ese día.

Responde SOLO JSON.
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

      const daysHint = context?.days_total || context?.days || context?.daysTotal || 1;
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      // 1) Primer intento (JSON forzado)
      let raw = await callText([{ role: "system", content: SYSTEM_INFO }, infoUserMsg], 0.22, 2400, true);
      let parsed = cleanToJSONPlus(raw);

      // 2) Si no parsea, intento estricto mínimo (JSON forzado, menos tokens)
      if (!parsed) {
        const strict = SYSTEM_INFO + `\nOBLIGATORIO: responde solo JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.15, 2000, true);
        parsed = cleanToJSONPlus(raw);
      }

      // 3) Quality Gate + 1 repair (más corto)
      if (parsed) {
        const audit = _validateInfoResearch_(parsed, { days_total: daysHint });

        if (!audit.ok) {
          const repairPrompt = `
${SYSTEM_INFO}

REPARACIÓN OBLIGATORIA:
Tu JSON falló:
- ${audit.issues.join("\n- ")}

Corrige y responde SOLO JSON válido.
Prioridad:
- rows_draft cubre days 1..days_total
- duration 2 líneas
- sin genéricos
`.trim();

          const repairRaw = await callText(
            [{ role: "system", content: repairPrompt }, infoUserMsg],
            0.18,
            2200,
            true
          );
          const repaired = cleanToJSONPlus(repairRaw);
          if (repaired) parsed = repaired;
        }
      }

      if (!parsed) {
        parsed = {
          destination: context?.city || "Destino",
          country: context?.country || "",
          days_total: Number(daysHint) || 1,
          hotel_base: context?.hotel_address || context?.hotel_base || "",
          rationale: "Fallback mínimo.",
          imperdibles: [],
          macro_tours: [],
          in_city_routes: [],
          meals_suggestions: [],
          aurora: { plausible: false, suggested_days: [], window_local: { start: "", end: "" }, transport_default: "", note: "", duration: "" },
          constraints: { max_substops_per_tour: 8, respect_user_preferences_and_conditions: true, thermal_lagoons_min_stay_minutes: 180 },
          day_hours: Array.isArray(context?.day_hours) ? context.day_hours : [],
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

        let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages], 0.22, 2200, true);
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo JSON válido.`;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.15, 1800, true);
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

      let raw = await callText([{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg], 0.22, 2200, true);
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + `\nOBLIGATORIO: responde solo JSON válido.`;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.15, 1800, true);
        parsed = cleanToJSONPlus(raw);
      }

      if (parsed) {
        const audit = _validatePlannerOutput_(parsed);

        if (!audit.ok) {
          const repairPlanner = `
${SYSTEM_PLANNER}

REPARACIÓN:
Fallos:
- ${audit.issues.join("\n- ")}

Recuerda: NO inventes. Usa research_json.rows_draft como verdad.
Devuelve SOLO JSON.
`.trim();

          const repairRaw = await callText(
            [{ role: "system", content: repairPlanner }, plannerUserMsg],
            0.18,
            2000,
            true
          );
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
