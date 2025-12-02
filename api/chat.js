// /api/chat.js — v31.0 (ESM compatible en Vercel) — patch quirúrgico
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

// ==============================
// Prompt base mejorado ✨ (investigación previa, auroras ≥18:00, sub-paradas, transporte realista)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows". Nada de texto fuera del JSON. Máx. 20 actividades por día.
- **No fijes horas predefinidas**: primero **investiga o infiere** horarios reales (según prácticas locales: luz, distancias, clima, demanda).
  Si faltan datos, distribuye mañana / mediodía / tarde y extiende a la noche solo si tiene sentido (cenas, shows, paseos, auroras).
- **No obligues la cena**: sugiérela únicamente cuando aporte valor.
- La respuesta debe poder renderizarse directamente en una UI web. No incluir "seed" ni campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "HH:MM",
  "end": "HH:MM",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie / Metro / Tren / Bus / Auto / Tour guiado / Vehículo alquilado o Tour guiado",
  "duration": "ej. 2h",
  "notes": "Descripción motivadora y breve (1–2 líneas)"
}

🧠 ESTILO Y EXPERIENCIA
- Tono cálido y experto; notas con emoción (“Admira…”, “Descubre…”). Evita repetir textos.

🌌 AURORAS (si el destino/época lo permiten)
- Trátalas como **imperdibles** cuando proceda, pero **evita ponerlas en la última noche**.
- Distribuye 1–2 (hasta 3 si la estancia ≥5 noches), **sin noches consecutivas** salvo justificación de clima/latitud.
- **Ventana flexible local:** pueden **empezar desde las 18:00** en algunos destinos/épocas; duración **≥4h**; retorno típico ≥00:30.
- Si generas <3h30m corrígelo a ≥4h; si iniciaste antes de 18:00, reajusta a ≥18:00.
- Respeta preferencias del usuario si existen (vehículo propio vs tour); si no, elige lo más coherente y menciona la alternativa en "notes".

🚆 TRANSPORTE Y TIEMPOS
- **No priorices por defecto** “A pie” ni transporte público. Valora explorar más allá del centro.
- Para excursiones de día completo o zonas rurales usa **exactamente** en "transport": **"Vehículo alquilado o Tour guiado"** (literal).
- Ordena horarios sin superposiciones; incluye duraciones y traslados plausibles.

🎫 TOURS Y SUB-PARADAS (modelo global)
- Antes de proponer, realiza una **investigación rápida** de imperdibles en la ciudad y su entorno de 1 día.
- En tours genéricos/jornada completa, **desglosa sub-paradas** como actividades separadas bajo el mismo título (3–6 hitos):
  "Círculo Dorado — Þingvellir"
  "Círculo Dorado — Geysir"
  "Círculo Dorado — Gullfoss"
  Análogos: "Costa Sur — Seljalandsfoss / Skógafoss / Reynisfjara / Vík",
            "Snæfellsnes — Arnarstapi / Djúpalónssandur / Kirkjufell",
            "Reykjanes — Puente entre Continentes / Gunnuhver / Seltún (Krýsuvík) / Kleifarvatn / Brimketill".
- Incluye localidades clave naturales de la ruta cuando corresponda.

💰 MONETIZACIÓN FUTURA (sin marcas ni precios)
- Sugiere experiencias propicias a upsells (museos, cafés, actividades).

📝 EDICIÓN INTELIGENTE
- Ante “agregar día/quitar/ajustar”, responde con el JSON actualizado, mantén secuencia cronológica y evita duplicados.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio–desarrollo–cierre), variado y claro.

🚫 EVITA
- Semillas, saludos o texto fuera de JSON; notas repetidas; bloques únicos gigantes para tours completos.
`.trim();

// ==============================
// Llamada al modelo (robusta: messages + JSON forzado)
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens: 2400,
    response_format: { type: "json_object" },
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });

  // Compatibilidad y limpieza de posibles fences
  let text = "";
  if (resp?.output_text) {
    text = resp.output_text.trim();
  } else if (Array.isArray(resp?.output)) {
    const chunk = resp.output.find(x => x?.content?.[0]?.type === "output_text");
    text = (chunk?.content?.[0]?.text || "").trim();
  } else {
    text = "";
  }
  if (/^```/m.test(text)) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

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
    const mode = body.mode || "planner";
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
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.1
      );
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
