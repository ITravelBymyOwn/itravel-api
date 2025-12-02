// /api/chat.js — v31.6 (ESM compatible en Vercel)
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
// Prompt base mejorado ✨ (global: investigación previa, auroras 18:00+, sub-paradas, transporte realista)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows". Nada de texto fuera del JSON.
- Máx. 20 actividades por día.
- **No fijes horas predefinidas**: investiga/infiere horarios reales y distribuye mañana/mediodía/tarde; extiende a la noche solo si tiene sentido (cenas, shows, paseos, auroras).
- No obligues cena; propónla cuando aporte valor.
- Respuesta renderizable en UI web. Sin "seed" ni campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "HH:MM",
  "end": "HH:MM",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie / Metro / Tren / Bus / Auto / Tour guiado / Vehículo alquilado o Tour guiado",
  "duration": "ej. 2h",
  "notes": "Descripción breve y motivadora (1–2 líneas)"
}

🧠 ESTILO
- Tono cálido y experto, notas con emoción. Evita repetir frases.

🌌 AURORAS (si el destino/época lo permiten)
- Son imperdibles cuando proceda.
- **No** programarlas en la **última noche**; prioriza noches tempranas y distribuye 2–3 oportunidades en estancias ≥4–5 noches (evita noches consecutivas salvo justificación).
- **Ventana flexible y local**: pueden **empezar desde las 18:00** si la latitud/estación lo justifican; duración realista **≥ 4h**; retorno habitual ≥ 00:30.
- Si detectas que propusiste < 3h30m, **autocorrige** a ≥ 4h. Si iniciaste antes de 18:00, **reajusta** a ≥ 18:00.
- Respeta preferencia del usuario si existe (vehículo propio, tour); si no, sugiere el formato más coherente y menciona la alternativa en "notes".

🚆 TRANSPORTE Y TIEMPOS (investiga; no inventes redes)
- Investiga o infiere disponibilidad real (a pie, metro, tren, bus, auto, ferry, tour).
- **No priorices caminar ni transporte público por defecto.** Para excursiones fuera de ciudad y zonas rurales usa:
  **"Vehículo alquilado o Tour guiado"** en "transport" (literal).
- Ordena horarios sin superposiciones e incluye duraciones y traslados.

🎫 TOURS Y ACTIVIDADES (investigación previa y sub-paradas)
- Haz primero una **investigación rápida** de qué es imperdible en la ciudad y su entorno (luz, distancias, clima, demanda).
- En **tours de jornada completa o genéricos** desglosa **sub-paradas** como actividades separadas bajo el mismo título principal (3–6 hitos):
  "Círculo Dorado — Þingvellir"
  "Círculo Dorado — Geysir"
  "Círculo Dorado — Gullfoss"
  Ejemplos análogos:
  "Costa Sur — Seljalandsfoss" / "Skógafoss" / "Reynisfjara" / "Vík"
  "Snæfellsnes — Arnarstapi" / "Djúpalónssandur" / "Kirkjufell"
  "Reykjanes — Puente entre Continentes" / "Gunnuhver" / "Seltún (Krýsuvík)" / "Kleifarvatn" / "Brimketill"
- Incluye localidades clave naturales de la ruta.

💰 MONETIZACIÓN FUTURA
- Sugiere experiencias naturalmente monetizables (museos, cafés, actividades), sin marcas ni precios.

📝 EDICIÓN INTELIGENTE
- Ante “agregar día/quitar/ajustar”, responde con el JSON actualizado, secuencia cronológica, sin duplicados.

🎨 UX Y NARRATIVA
- Cada día debe fluir como historia (inicio–desarrollo–cierre), variado y claro.

🚫 EVITA
- Semillas, saludos, textos fuera de JSON, notas copiadas, horas incongruentes o bloques únicos gigantes para tours completos.
`.trim();

// ==============================
// Llamada al modelo (robusta, fuerza JSON)
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens: 2400,
    response_format: { type: "json_object" },
    messages: messages.map(m => ({ role: m.role, content: m.content }))
  });

  let text = "";
  if (resp?.output_text) {
    text = resp.output_text.trim();
  } else if (Array.isArray(resp?.output)) {
    const chunk = resp.output.find(x => x?.content?.[0]?.type === "output_text");
    text = (chunk?.content?.[0]?.text || "").trim();
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
