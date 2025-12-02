// /api/chat.js — v31.1 (ESM compatible en Vercel, quirúrgico sobre v31.0)
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

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const cleaned = raw.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }
}

function fallbackJSON() {
  return {
    destination: "Desconocido",
    rows: [
      {
        day: 1,
        start: "09:00",
        end: "18:00",
        activity: "Itinerario base (fallback)",
        from: "",
        to: "",
        transport: "",
        duration: "",
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
      followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ⏱️ util mínima (no rompe nada): suma minutos a "HH:MM"
function addMinutesHHMM(hhmm = "00:00", minutes = 0) {
  const [h = "0", m = "0"] = String(hhmm).split(":");
  const base = parseInt(h, 10) * 60 + parseInt(m, 10);
  const t = Math.max(0, base + (isFinite(minutes) ? minutes : 0));
  const H = Math.floor(t / 60) % 24;
  const M = t % 60;
  return String(H).padStart(2, "0") + ":" + String(M).padStart(2, "0");
}

function norm(str = "") {
  return String(str)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

const OUT_OF_TOWN_RE = /\b(circulo\s*dorado|golden\s*circle|thingvellir|gullfoss|geysir|blue\s*lagoon|laguna\s*azul|reykjanes|costa\s*sur|seljalandsfoss|skogafoss|reynisfjara|vik|snaefellsnes|kirkjufell|glaciar|fiordo|parque\s*nacional|peninsula)\b/i;

// Post-proceso MUY ligero: añade “Regreso a <Ciudad>” al final de días que salen fuera
function ensureReturnRows(parsed) {
  const patchOne = (cityName, rows) => {
    if (!Array.isArray(rows) || !rows.length) return rows;

    const cityKey = norm(cityName);
    // agrupamos por día
    const byDay = new Map();
    for (const r of rows) {
      const d = Number(r.day) || 1;
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }

    const patched = [];
    for (const [day, list] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
      const dayRows = [...list];
      const hadOutOfTown =
        dayRows.some(
          (r) =>
            OUT_OF_TOWN_RE.test(String(r.activity || "")) ||
            /Vehículo alquilado o Tour guiado|Auto \(alquilado\) o Tour guiado/i.test(
              String(r.transport || "")
            )
        ) &&
        // heurística: algún "to" o "activity" que no mencione la ciudad
        dayRows.some((r) => !norm(r.to || r.activity || "").includes(cityKey));

      if (hadOutOfTown) {
        const last = dayRows[dayRows.length - 1] || {};
        const lastTo = norm(last.to || last.activity || "");
        const endsInCity = lastTo.includes(cityKey);

        if (!endsInCity) {
          const start = last.end || "17:30";
          const end = addMinutesHHMM(start, 90); // 1h30 de regreso por defecto
          dayRows.push({
            day,
            start,
            end,
            activity: `Regreso a ${cityName}`,
            from: last.to || last.activity || "",
            to: cityName,
            transport:
              last.transport ||
              "Vehículo alquilado o Tour guiado",
            duration: "1h30",
            notes:
              "Regresa a la ciudad para descansar y/o cenar con calma.",
          });
        }
      }
      patched.push(...dayRows);
    }
    return patched;
  };

  if (!parsed) return parsed;
  // Formato B
  if (parsed.destination && Array.isArray(parsed.rows)) {
    parsed.rows = patchOne(parsed.destination, parsed.rows);
  }
  // Formato C (múltiples)
  if (Array.isArray(parsed.destinations)) {
    parsed.destinations = parsed.destinations.map((d) => {
      const name = d.name || d.destination || "";
      return { ...d, rows: patchOne(name, d.rows || []) };
    });
  }
  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (flex hours, cena no obligatoria, auroras inteligentes)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas **realistas con flexibilidad**: no asumas una ventana fija (no fuerces 08:30–19:00).
  Si no hay información de horarios, distribuye en mañana / mediodía / tarde y, cuando tenga sentido, extiende la noche (cenas, shows, paseos, auroras).
  **No obligues la cena**: sugiérela sólo si aporta valor ese día.
- La respuesta debe poder renderizarse directamente en una UI web.
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Auto, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido, entusiasta y narrativo.
- Notas:
  • Explica en 1–2 líneas por qué la actividad es especial.
  • Transmite emoción (“Admira…”, “Descubre…”, “Siente…”).
  • Si falta info, usa un fallback inspirador (“Una parada ideal para disfrutar la esencia de este destino”).
- Personaliza según el tipo de actividad y **evita repetir** exactamente la misma nota.

🌌 AURORAS (si aplica por destino/temporada)
- Sugiere “caza de auroras” **solo** si es plausible.
- **Evita noches consecutivas** y **evita que la única noche de auroras sea el último día**.
- Distribución orientativa:
  • Estancias de 3 días: 1 noche (no el último día si es la única).
  • 4–5+ días: 2 noches no consecutivas, preferiblemente en los primeros 3–4 días.
- Evita programarlas justo después de jornadas de conducción muy largas.
- Ventana razonable de ejemplo: 20:30–23:30 (ajustable por contexto).

🚆 TRANSPORTE Y TIEMPOS
- Usa medios coherentes (a pie, metro, tren, taxi, bus, auto, ferry…).
- Si la actividad es **fuera de la ciudad** y el usuario no especificó transporte,
  asume **"Vehículo alquilado o Tour guiado"** (evita bus/tren donde no sea realista).
- Las horas deben estar ordenadas, sin solapes, con traslados y duraciones plausibles.

🧭 TOURS Y EXCURSIONES
- Desglosa los tours en **paradas/waypoints clave** como filas separadas (p. ej., “Thingvellir → Geysir → Gullfoss”, “Seljalandsfoss → Skógafoss → Reynisfjara → Vík”).
- **IMPORTANTE:** si un día incluye una excursión fuera de la ciudad, añade al final una fila:
  {"activity":"Regreso a <Ciudad>","from":"último punto","to":"<Ciudad>","transport":"Vehículo alquilado o Tour guiado","duration":"~1h–2h"} con horas consistentes.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (cafés, museos, experiencias).
- No incluyas precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no hay horas, distribuye lógicamente en mañana/mediodía/tarde; la noche es opcional.
- Mantén la secuencia cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Descripciones cortas y claras; variedad en las actividades.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas en varias actividades.

Ejemplo de nota motivadora correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 2200,
  });

  const text =
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    "";

  console.log("🛰️ RAW RESPONSE:", text);
  return text;
}

// ==============================
// Exportación ESM correcta
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body;
    const mode = body.mode || "planner"; // 👈 nuevo parámetro
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original con reglas flexibles
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]
    );
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.1
      );
      parsed = cleanToJSON(raw);
    }

    // ✅ Post-proceso quirúrgico sin romper la lógica: “Regreso a <Ciudad>”
    if (parsed) parsed = ensureReturnRows(parsed);

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
