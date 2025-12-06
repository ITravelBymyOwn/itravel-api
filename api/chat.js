// /api/chat.js — v30.4 (ESM compatible en Vercel)
// Base exacta: v30.3. Cambios:
// - Prompt reforzado con conocimiento turístico completo (como el info chat).
// - Eliminación automática de "valid: ventana nocturna auroral (sujeto a clima)".
// - Mantiene flujo estable anti-fallback.

import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function cleanToJSONPlus(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try { return JSON.parse(raw); } catch {}
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const sliced = raw.slice(first, last + 1);
      return JSON.parse(sliced);
    }
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
        duration: "",
        notes: "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// LÓGICA POST-PROCESO (auroras, transporte, subparadas)
// ==============================
const AURORA_DESTINOS = [
  "reykjavik", "reykjavík", "tromso", "tromsø", "rovaniemi", "kiruna",
  "abisko", "alta", "ivalo", "yellowknife", "fairbanks", "akureyri"
];

function auroraNightsByLength(totalDays) {
  if (totalDays <= 2) return 1;
  if (totalDays <= 4) return 2;
  if (totalDays <= 6) return 2;
  if (totalDays <= 9) return 3;
  return 3;
}

function planAuroraDays(totalDays, count) {
  const start = (totalDays % 2 === 0) ? 1 : 2;
  const out = [];
  let d = start;
  while (out.length < count && d < totalDays) {
    out.push(d);
    d += 2;
  }
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour de auroras que se tome. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche; investiga seguridad para tus fechas).";

function scrubAuroraValid(text = "") {
  if (!text) return text;
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara",
  "vik", "vík", "snaefellsnes", "snæfellsnes", "blue lagoon",
  "reykjanes", "krýsuvík", "arnarstapi"
];

function needsVehicleOrTour(row) {
  const a = (row.activity || "").toLowerCase();
  const to = (row.to || "").toLowerCase();
  return NO_BUS_TOPICS.some(k => a.includes(k) || to.includes(k));
}

function coerceTransport(rows) {
  return rows.map(r => {
    const transport = (r.transport || "").toLowerCase();
    if (transport.includes("bus") && needsVehicleOrTour(r)) {
      return { ...r, transport: "Vehículo alquilado o Tour guiado" };
    }
    return r;
  });
}

function compactSubstops(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const act = (r.activity || "").toLowerCase();
    if (act.startsWith("excursión") || act.includes("costa sur") || act.includes("península") || act.includes("círculo dorado")) {
      const sub = [];
      let j = i + 1;
      while (j < rows.length && sub.length < 8) {
        const rj = rows[j];
        const aj = (rj?.activity || "").toLowerCase();
        if (aj.startsWith("visita") || aj.includes("cascada") || aj.includes("playa") || aj.includes("geysir") || aj.includes("thingvellir") || aj.includes("gullfoss")) {
          sub.push(rj?.to || rj?.activity || "");
          j++;
        } else break;
      }
      if (sub.length) {
        const pretty = sub.filter(Boolean)
          .map(s => s.replace(/^visita (a |al )?/i, "").trim())
          .join(" → ");
        const merged = {
          ...r,
          activity: (r.activity || "").replace(/\s—.*$/, "") + (pretty ? ` — ${pretty}` : "")
        };
        out.push(merged);
        for (let k = i + 1; k < i + 1 + sub.length; k++) {
          const rr = rows[k];
          out.push({ ...rr, notes: (rr.notes || "Parada dentro de la ruta.") });
        }
        i = i + sub.length;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

function ensureAuroras(parsed) {
  const dest =
    (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
  const destName = dest || (parsed?.destinations?.[0]?.name || "");
  const low = destName.toLowerCase();
  const rows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : Array.isArray(parsed?.destinations?.[0]?.rows)
      ? parsed.destinations[0].rows
      : [];

  if (!rows.length) return parsed;

  const totalDays = Math.max(...rows.map(r => Number(r.day) || 1));
  const isAuroraPlace = AURORA_DESTINOS.some(x => low.includes(x));

  let base = coerceTransport(compactSubstops(rows))
    .map(r => ({ ...r, notes: scrubAuroraValid(r.notes) }));

  if (!isAuroraPlace) return normalizeShape(parsed, base);

  base = base.filter(r => !isAuroraRow(r));
  const targetCount = auroraNightsByLength(totalDays);
  const targetDays = planAuroraDays(totalDays, targetCount);

  for (const d of targetDays) {
    base.push({
      day: d,
      start: "18:00",
      end: "01:00",
      activity: "Caza de auroras boreales",
      from: "Hotel",
      to: "Puntos de observación (variable)",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "~7h",
      notes: AURORA_NOTE_SHORT,
    });
  }

  base.sort((a, b) => (a.day - b.day) || (a.start || "").localeCompare(b.start || ""));
  return normalizeShape(parsed, base);
}

function normalizeShape(parsed, rowsFixed) {
  if (Array.isArray(parsed?.rows)) {
    return { ...parsed, rows: rowsFixed };
  }
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompt base con conocimiento turístico global
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn. Eres un experto mundial en turismo.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

📌 FORMATOS
{"destination":"City","rows":[{...}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- Máx. 20 actividades por día.
- Usa horas realistas (08:30–19:00 si no hay otras).
- No devuelvas "seed" ni campos vacíos.

🧭 ESTRUCTURA
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Bus, Vehículo alquilado o Tour guiado, etc.",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🌍 CONOCIMIENTO TURÍSTICO GLOBAL
- Considera siempre tus conocimientos sobre destinos, distancias y tiempos reales entre lugares turísticos.
- Puedes usar información geográfica mundial, guías oficiales o referencias de viajes típicos para calcular traslados.
- Si el destino no cuenta con red pública eficiente, utiliza **"Vehículo alquilado o Tour guiado"**.

🏔️ TOURS CLÁSICOS DESDE REYKJAVÍK
- **Círculo Dorado**: Thingvellir → Geysir → Gullfoss → regreso (≈1h15m–1h45m).
- **Costa Sur**: Seljalandsfoss → Skógafoss → Reynisfjara → Vík → regreso (≈2h30m–3h).
- **Península de Snæfellsnes**: Kirkjufell, Arnarstapi, Hellnar, Djúpalónssandur → regreso (≈2h15m–3h).
- **Reykjanes / Blue Lagoon**: parada final en la laguna → regreso (≈45m–1h).
- Determina y aplica duraciones realistas de traslado según tus conocimientos turísticos.

🌌 AURORAS
- Noches alternas según paridad de días (par→1,3,5…; impar→2,4,6…), nunca el último día.
- Horario 18:00–01:00, transporte "Vehículo alquilado o Tour guiado".
- No incluyas frases como "valid: ventana nocturna auroral (sujeto a clima)".

🧩 DESTINO–SUBPARADAS
- Excursiones con varias paradas: actividad madre “Excursión — …” + hasta 8 subparadas.
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3000,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.json?.trim() ||
    "";

  return text;
}

// ==============================
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const body = req.body;
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
    }

    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSONPlus(raw);

    if (!parsed || (!parsed.rows && !parsed.destinations)) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo JSON con al menos 1 fila en "rows".`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSONPlus(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    const finalJSON = ensureAuroras(parsed);

    return res.status(200).json({ text: JSON.stringify(finalJSON) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
