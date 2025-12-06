// /api/chat.js — v30.11 (ESM compatible en Vercel)
// Base exacta: v30.4.
// Reestructura anti-fallback:
// - Cambiamos a Chat Completions (más estable en prod) con response_format JSON.
// - Mensajes por rol (system/user), sin concatenar.
// - Parser robusto (objeto nativo, bloque {...}, fences).
// - Triple intento (normal → estricto → plantilla mínima).
// Mantiene tu lógica: subparadas ≤8, coerción transporte, auroras (paridad),
// limpieza de notas (sin “valid: ventana nocturna auroral…”, sin duplicar “min stay ~3h (ajustable)”).

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

function cleanToJSONPlus(raw) {
  if (!raw) return null;

  // 0) Ya viene como objeto
  if (typeof raw === "object") {
    const obj = raw;
    if (obj.rows || obj.destinations) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch {}
  }

  if (typeof raw !== "string") return null;
  let s = raw.trim();

  // Quitar fences ```json ... ```
  s = s.replace(/^```json/i, "```").replace(/^```/, "").replace(/```$/, "").trim();

  // 1) Intento directo
  try { return JSON.parse(s); } catch {}

  // 2) Primer { ... último }
  try {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(s.slice(first, last + 1));
    }
  } catch {}

  // 3) Limpieza de bordes agresiva
  try {
    const cleaned = s.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
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
  for (let d = start; out.length < count && d < totalDays; d += 2) out.push(d);
  return out;
}

const AURORA_NOTE_SHORT =
  "Noche especial de caza de auroras. Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. " +
  "La hora de regreso al hotel dependerá del tour de auroras que se tome. " +
  "Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche; investiga seguridad para tus fechas).";

function isAuroraRow(r) {
  const t = (r?.activity || "").toLowerCase();
  return t.includes("aurora");
}

const NO_BUS_TOPICS = [
  "círculo dorado", "thingvellir", "þingvellir", "geysir", "geyser",
  "gullfoss", "seljalandsfoss", "skógafoss", "reynisfjara",
  "vik", "vík", "snaefellsnes", "snæfellsnes", "blue lagoon",
  "reykjanes", "krýsuvík", "arnarstapi", "hellnar", "djúpalónssandur",
  "kirkjufell", "puente entre continentes"
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

function scrubAuroraValid(text = "") {
  if (!text) return text;
  return text.replace(/valid:[^.\n\r]*auroral[^.\n\r]*\.?/gi, "").trim();
}
function scrubBlueLagoon(text = "") {
  if (!text) return text;
  return text
    .replace(/(\s*[-–•·]\s*)?min\s*stay\s*~?3h\s*\(ajustable\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
        const isSub = aj.startsWith("visita")
          || aj.includes("cascada")
          || aj.includes("playa")
          || aj.includes("geysir")
          || aj.includes("thingvellir")
          || aj.includes("gullfoss")
          || aj.includes("kirkjufell")
          || aj.includes("arnarstapi")
          || aj.includes("hellnar")
          || aj.includes("djúpalónssandur")
          || aj.includes("djupalonssandur")
          || aj.includes("vík") || aj.includes("vik")
          || aj.includes("reynisfjara");
        if (isSub) { sub.push(rj?.to || rj?.activity || ""); j++; } else break;
      }
      if (sub.length) {
        const pretty = sub.filter(Boolean).map(s => s.replace(/^visita (a |al )?/i, "").trim()).join(" → ");
        const merged = { ...r, activity: (r.activity || "").replace(/\s—.*$/, "") + (pretty ? ` — ${pretty}` : "") };
        out.push(merged);
        for (let k = i + 1; k < i + 1 + sub.length; k++) out.push({ ...rows[k], notes: (rows[k].notes || "Parada dentro de la ruta.") });
        i = i + sub.length;
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

function ensureAuroras(parsed) {
  const dest = (parsed?.destination || parsed?.Destination || parsed?.city || parsed?.name || "").toString();
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

  let base = coerceTransport(compactSubstops(rows)).map(r => {
    let notes = scrubAuroraValid(r.notes);
    const inLagoon = ((r.to || "") + " " + (r.activity || "")).toLowerCase().includes("blue lagoon");
    if (inLagoon) notes = scrubBlueLagoon(notes);
    return { ...r, notes };
  });

  if (!isAuroraPlace) return normalizeShape(parsed, base);

  // Reinyectar auroras por paridad
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
  if (Array.isArray(parsed?.rows)) return { ...parsed, rows: rowsFixed };
  if (Array.isArray(parsed?.destinations)) {
    const name = parsed.destinations?.[0]?.name || parsed.destination || "Destino";
    return { destination: name, rows: rowsFixed, followup: parsed.followup || "" };
  }
  return { destination: parsed?.destination || "Destino", rows: rowsFixed, followup: parsed?.followup || "" };
}

// ==============================
// Prompt base (con conocimiento turístico global)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn. Eres un experto mundial en turismo.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**.

📌 FORMATO
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
  "activity": "Nombre claro y específico (permitido: 'Excursión — A → B → C')",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie, Metro, Tren, Auto, Taxi, Bus, Ferry, Vehículo alquilado o Tour guiado",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🌍 CONOCIMIENTO TURÍSTICO GLOBAL
- Usa tus conocimientos turísticos para estimar **tiempos y distancias reales** entre puntos.
- En Islandia para Círculo Dorado, Costa Sur y Snæfellsnes, prefiere **"Vehículo alquilado o Tour guiado"**.

🏔️ TOURS CLÁSICOS DESDE REYKJAVÍK (regresos habituales)
- **Círculo Dorado**: Thingvellir → Geysir → Gullfoss → regreso a Reykjavík (≈1h15m–1h45m).
- **Costa Sur**: Seljalandsfoss → Skógafoss → Reynisfjara → Vík → regreso a Reykjavík (≈2h30m–3h).
- **Snæfellsnes**: Kirkjufell / Arnarstapi / Hellnar / Djúpalónssandur → regreso (≈2h15m–3h).
- **Reykjanes / Blue Lagoon**: laguna como última parada → regreso (≈45m–1h).

🌌 AURORAS
- Noches alternas por paridad (par→1,3,5…; impar→2,4,6…), nunca el último día.
- Horario 18:00–01:00; transporte "Vehículo alquilado o Tour guiado".
- No incluyas “valid: ventana nocturna auroral (sujeto a clima)”.

🧩 DESTINO–SUBPARADAS
- Actividad madre “Excursión — …” + hasta 8 subparadas inmediatamente después.
`.trim();

// ==============================
// Llamadas al modelo (Chat Completions)
// ==============================
async function chatPlanner(messages, temperature = 0.35) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    response_format: { type: "json_object" },
    messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
    max_tokens: 3200,
  });

  const choice = resp?.choices?.[0];
  const text = choice?.message?.content?.trim() || "";
  return text;
}

async function chatInfo(messages, temperature = 0.5) {
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    messages: messages.map(m => ({ role: m.role, content: String(m.content ?? "") })),
    max_tokens: 3200,
  });
  return resp?.choices?.[0]?.message?.content?.trim() || "";
}

// ==============================
// Handler
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    if (mode === "info") {
      const raw = await chatInfo(clientMessages);
      return res.status(200).json({ text: raw || "⚠️ No se obtuvo respuesta." });
    }

    // PLANNER — forzamos JSON
    let raw = await chatPlanner([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], 0.35);
    let parsed = cleanToJSONPlus(raw);

    // Reintento estricto
    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve solo un JSON con "destination" y al menos 1 fila en "rows".`;
      raw = await chatPlanner([{ role: "system", content: strictPrompt }, ...clientMessages], 0.2);
      parsed = cleanToJSONPlus(raw);
    }

    // Último intento (plantilla mínima)
    const stillNo = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNo) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido estrictamente:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await chatPlanner([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
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
