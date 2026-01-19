// /api/chat.js — v58 (ajustado quirúrgicamente según reglas v52.5) — ESM compatible en Vercel
// ✅ Mantiene interfaz v58: recibe {mode, input/history/messages} y responde { text: "<string>" }.
// ✅ NO rompe modo "info": devuelve texto libre.
// ✅ Ajusta SOLO el prompt del planner + parse/guardrails para cumplir reglas fuertes (city_day preferido, duración 2 líneas, auroras, macro-tours, etc.).

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// Helpers
// ==============================
function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// v52.5-style robust JSON extraction (quirúrgico: reemplaza cleanToJSON sin cambiar uso externo)
function cleanToJSON(raw = "") {
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
            start: "09:30",
            end: "11:00",
            activity: "Desconocido – Itinerario base (fallback)",
            from: "Hotel",
            to: "Centro",
            transport: "A pie o Transporte local (según ubicación)",
            duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
            notes: "⚠️ No pude generar el itinerario. Revisa API key/despliegue y vuelve a intentar.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// Guard-rail: evita tabla en blanco si el modelo falla en planner
function skeletonCityDay(destination = "Destino", daysTotal = 1) {
  const city = String(destination || "Destino").trim() || "Destino";
  const n = Math.max(1, Number(daysTotal) || 1);
  const blocks = [];
  for (let d = 1; d <= n; d++) {
    blocks.push({
      city,
      day: d,
      rows: [
        {
          day: d,
          start: "09:30",
          end: "11:00",
          activity: `${city} – Reintentar generación (itinerario pendiente)`,
          from: "Hotel",
          to: "Centro",
          transport: "A pie o Transporte local (según ubicación)",
          duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
          notes:
            "⚠️ No se obtuvo un itinerario válido en este intento. Reintenta o ajusta condiciones; cuando funcione, aquí verás el plan final.",
          kind: "",
          zone: "",
        },
      ],
    });
  }
  return blocks;
}

function _normalizeDurationText_(txt) {
  const s = String(txt ?? "").trim();
  if (!s) return s;

  // "Transporte: X, Actividad: Y" => 2 líneas
  if (/Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && s.includes(",")) {
    return s.replace(/\s*,\s*Actividad\s*:/i, "\nActividad:");
  }

  // si viene en una sola línea sin saltos pero tiene ambos labels, intenta forzar split con separadores comunes
  if (/Transporte\s*:/i.test(s) && /Actividad\s*:/i.test(s) && !s.includes("\n")) {
    const tmp = s.replace(/\s*\|\s*/g, ", ").replace(/\s*;\s*/g, ", ");
    if (tmp.includes(",")) return tmp.replace(/\s*,\s*Actividad\s*:/i, "\nActividad:");
  }

  return s;
}

function _hasAnyRows_(city_day) {
  if (!Array.isArray(city_day) || !city_day.length) return false;
  return city_day.some((b) => Array.isArray(b?.rows) && b.rows.length > 0);
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
    b.rows = (Array.isArray(b.rows) ? b.rows : []).map((r) => ({
      ...r,
      day: Number(r?.day) || b.day,
      duration: _normalizeDurationText_(r?.duration),
      kind: r?.kind ?? "",
      zone: r?.zone ?? "",
    }));
  });

  return out;
}

function normalizeParsed(parsed) {
  if (!parsed) return parsed;

  try {
    // Prefer city_day; si llega rows legacy, lo dejamos para compat pero el frontend idealmente usa city_day
    if (Array.isArray(parsed.city_day)) {
      const dest = String(parsed?.destination || "").trim();
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
    }

    // Si por alguna razón el modelo devolvió "rows" legacy, normaliza duración/kind/zone también
    if (Array.isArray(parsed.rows)) {
      parsed.rows = parsed.rows.map((r) => ({
        ...r,
        duration: _normalizeDurationText_(r?.duration),
        kind: r?.kind ?? "",
        zone: r?.zone ?? "",
      }));
    }

    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => ({
        ...d,
        rows: Array.isArray(d?.rows)
          ? d.rows.map((r) => ({
              ...r,
              duration: _normalizeDurationText_(r?.duration),
              kind: r?.kind ?? "",
              zone: r?.zone ?? "",
            }))
          : d.rows,
        city_day: Array.isArray(d?.city_day) ? _normalizeCityDayShape_(d.city_day, d?.name || d?.destination || "") : d.city_day,
      }));
    }
  } catch {}

  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (PLANNER) — Ajustado a reglas v52.5
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser EXCLUSIVAMENTE un JSON válido (sin markdown, sin backticks, sin texto fuera).

FORMATO PREFERIDO (nuevo, tabla-ready):
A) {
  "destination":"Ciudad",
  "days_total":N,
  "city_day":[
    {"city":"Ciudad","day":1,"rows":[
      {
        "day":1,
        "start":"09:30",
        "end":"11:00",
        "activity":"DESTINO – SUB-PARADA",
        "from":"Lugar de partida",
        "to":"Lugar de destino",
        "transport":"Transporte realista",
        "duration":"Transporte: ...\\nActividad: ...",
        "notes":"(>=20 chars) 1 frase emotiva + 1 tip logístico (+ alternativa/condición si aplica)",
        "kind":"",
        "zone":""
      }
    ]}
  ],
  "followup":"texto breve"
}

FORMATOS LEGACY (solo si te lo piden / por compat):
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

REGLA DE ORO:
- Debe ser LISTO PARA TABLA: cada fila trae TODO lo necesario.
- Devuelve SIEMPRE al menos 1 fila renderizable (nunca tabla en blanco).
- Nada de texto fuera del JSON.

REGLAS GENERALES:
- Máximo 20 filas por día.
- Horas realistas locales; si el usuario no da horas, decide como experto.
- Las horas deben estar ordenadas y NO superponerse.
- from/to/transport: NUNCA vacíos.
- NO devuelvas "seed" ni notes vacías.

CONTRATO OBLIGATORIO DE CADA ROW:
- day (número)
- start/end en HH:MM (hora local)
- activity: SIEMPRE "DESTINO – SUB-PARADA" (– o - con espacios). Prohibido genérico tipo "museo", "parque", "restaurante local".
- duration: 2 líneas EXACTAS con salto \\n:
  "Transporte: <estimación realista o ~rango>"
  "Actividad: <estimación realista o ~rango>"
  PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- notes: obligatorias (>=20 caracteres), motivadoras y útiles:
  1) 1 frase emotiva (Admira/Descubre/Siente…)
  2) 1 tip logístico (mejor hora, reservas, tickets, vista, etc.)
  + condición/alternativa si aplica

COMIDAS (Regla flexible):
- NO son obligatorias.
- Inclúyelas SOLO si aportan valor real al flujo.
- Si se incluyen, NO genéricas (ej. "cena en restaurante local" prohibido).

AURORAS (Regla flexible + inferencia):
- Solo sugerir si plausibles por latitud/temporada.
- Evitar días consecutivos si hay opciones.
- Evitar el último día; si SOLO cabe ahí, marcarlo como condicional en notes.
- Debe ser horario nocturno típico local.
- Notes deben incluir: "valid:" + (clima/nubosidad) + alternativa low-cost cercana.

DAY-TRIPS / MACRO-TOURS:
- Si haces una excursión/“day trip”, debes desglosarla en 5–8 sub-paradas (filas).
- Siempre cerrar con una fila propia: "Regreso a {Ciudad base}".
- Evitar último día si hay opciones.

SEGURIDAD / COHERENCIA GLOBAL:
- No propongas cosas inviables por distancia/tiempo/temporada o riesgos evidentes.
- Prioriza opciones plausibles, seguras y razonables.

EDICIÓN INTELIGENTE:
- Si el usuario pide agregar/quitar/ajustar horarios, devuelve el JSON actualizado y consistente.
- Por defecto, mantén coherencia global del itinerario.

Responde SOLO JSON válido.
`.trim();

// ==============================
// Llamada al modelo (con timeout suave)
// ==============================
async function callStructured(messages, temperature = 0.28, max_output_tokens = 2600, timeoutMs = 90000) {
  const input = (messages || []).map((m) => `${String(m.role || "user").toUpperCase()}: ${m.content}`).join("\n\n");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await client.responses.create(
      {
        model: "gpt-4o-mini",
        temperature,
        input,
        max_output_tokens,
      },
      { signal: controller.signal }
    );

    const text =
      resp?.output_text?.trim() ||
      resp?.output?.[0]?.content?.[0]?.text?.trim() ||
      "";

    console.log("🛰️ RAW RESPONSE:", text);
    return text;
  } catch (e) {
    console.warn("callStructured error:", e?.message || e);
    return "";
  } finally {
    clearTimeout(t);
  }
}

// ==============================
// Exportación ESM correcta
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner"; // 👈 parámetro existente
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — texto libre (NO rompemos v58)
    if (mode === "info") {
      const raw = await callStructured(clientMessages, 0.25, 1400, 70000);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — con reglas fuertes del v52.5 (solo via prompt + guardrails)
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], 0.28, 3200, 90000);
    let parsed = cleanToJSON(raw);

    // 1) Retry: strict (si no parsea o no trae city_day/rows/destinations)
    const hasSome =
      parsed && (Array.isArray(parsed.city_day) || Array.isArray(parsed.rows) || Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `

OBLIGATORIO:
- Responde SOLO JSON válido.
- Debe traer city_day (preferido) o rows (legacy) con al menos 1 fila.
- Nada de meta ni texto fuera.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.22, 3400, 95000);
      parsed = cleanToJSON(raw);
    }

    // 2) Retry: ultra con ejemplo mínimo (solo si aún falla)
    const stillBad =
      !parsed || (!Array.isArray(parsed.city_day) && !Array.isArray(parsed.rows) && !Array.isArray(parsed.destinations));

    if (stillBad) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `

Ejemplo válido mínimo (NO lo copies literal; solo guía de formato):
{
  "destination":"CITY",
  "days_total":1,
  "city_day":[{"city":"CITY","day":1,"rows":[
    {"day":1,"start":"09:30","end":"11:00","activity":"CITY – Punto icónico","from":"Hotel","to":"Centro","transport":"A pie","duration":"Transporte: ~10m\\nActividad: ~90m","notes":"Descubre un rincón emblemático y llega temprano para evitar filas. Tip: lleva agua y revisa horarios.","kind":"","zone":""}
  ]}],
  "followup":""
}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.14, 3600, 95000);
      parsed = cleanToJSON(raw);
    }

    // 3) Normalización + guard-rails anti-tabla-en-blanco
    if (!parsed) parsed = fallbackJSON();

    // Prefer city_day: si el modelo devolvió rows legacy, lo dejamos; pero si devolvió city_day, lo normalizamos.
    parsed = normalizeParsed(parsed);

    // Guard-rail final: si city_day existe pero viene vacío/sin filas, inyecta skeleton
    try {
      const dest = String(parsed?.destination || "Destino").trim() || "Destino";
      const daysTotal = Math.max(1, Number(parsed?.days_total || 1));

      if (Array.isArray(parsed.city_day)) {
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
        if (!_hasAnyRows_(parsed.city_day)) {
          parsed.city_day = skeletonCityDay(dest, daysTotal);
          parsed.followup =
            (parsed.followup ? parsed.followup + " | " : "") +
            "⚠️ Guard-rail: city_day vacío o sin filas. Se devolvió skeleton para evitar tabla en blanco.";
        }
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
