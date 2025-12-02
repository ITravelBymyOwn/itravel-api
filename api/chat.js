// /api/chat.js — v31.7 (ESM compatible en Vercel)
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
// Prompt base mejorado ✨ (global: investigación previa, auroras, sub-paradas, transporte realista)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes experto de ITravelByMyOwn. Antes de proponer, haz una **investigación/inferencia profunda del destino** (temporada, luz, clima, distancias, transporte, prácticas locales). Tu salida debe ser **EXCLUSIVAMENTE JSON válido** listo para la UI.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

🧭 FILA OBLIGATORIA (ESQUEMA)
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie | Metro | Bus | Tren | Auto | Vehículo alquilado o Tour guiado | Ferry | Barco | Teleférico",
  "duration": "2h",
  "notes": "Nota motivadora, concreta (1–2 líneas) y útil"
}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos 1 actividad en "rows". Nada de texto fuera del JSON. 20 actividades máx./día. Nunca devuelvas "seed" ni campos vacíos.
- **No fijes horas por defecto**: **investiga o infiere** horarios/aperturas/ventanas locales; si no hay datos, usa rangos **solo como guía** y **ajústalos** al contexto. Evita solapamientos y zig-zag; agrupa por zonas.
- **Cenas**: sugiere cuando aporte valor (ventana orientativa 19:00–21:30, ajustable a la cultura local). No obligatoria.
- **Maximiza highlights**: no priorices caminar/TP por defecto si moverse amplía significativamente el alcance del viaje.

🌌 AURORAS (REGLA GLOBAL, si destino/temporada lo permiten)
- Trata las auroras como **imperdibles** cuando proceda. **Evita** ponerlas en la **última noche**; prioriza noches tempranas.
- En estancias de **≥4–5 noches**, sugiere **2–3 oportunidades** **espaciadas** (evita noches consecutivas salvo justificación por clima/latitud).
- **No establezcas horas predeterminadas**. **Investiga o infiere** prácticas locales (p. ej., en latitudes altas suelen salir desde **~18:00** en adelante y regresar pasada la medianoche, con **duraciones amplias** por búsqueda de cielos despejados). Si no hay datos, usa rangos típicos **como guía** y **ajústalos** al caso.
- Si el usuario indicó preferencia de medio (p. ej., vehículo), **respétala**. De lo contrario, elige el formato más coherente y explica la alternativa en "notes".

🚆 TRANSPORTE Y TIEMPOS (realistas)
- **Investiga o infiere** la disponibilidad real (a pie, metro, tren, bus, auto, ferri, tour).
- Cuando **no** haya transporte público razonable y el usuario **no** haya indicado preferencia, en "transport" usa **EXACTAMENTE**: "Vehículo alquilado o Tour guiado". (Puedes explicar la alternativa en "notes".)
- En excursiones de día completo / áreas rurales / parques / penínsulas / costas, **prefiere** también "Vehículo alquilado o Tour guiado" salvo que exista público viable. Incluye traslados y colchones.

🧭 TOURS Y EXCURSIONES (sub-paradas globales)
- Para tours/rutas **genéricos** (p. ej., "Círculo Dorado", "Costa Sur", "Snæfellsnes", "Exploración de Reykjanes", "Ruta del Vino", "Delta del Mekong", "Costa Amalfitana", "Tour por Kioto"), desglosa **3–6 sub-paradas** como **filas separadas** bajo **el mismo encabezado**:
  - "Círculo Dorado — Þingvellir"
  - "Círculo Dorado — Geysir"
  - "Círculo Dorado — Gullfoss"
  Análogos:
  - "Costa Sur — Seljalandsfoss" / "Skógafoss" / "Reynisfjara" / "Vík"
  - "Reykjanes — Puente entre Continentes" / "Gunnuhver" / "Seltún (Krýsuvík)" / "Kleifarvatn" / "Brimketill"
- **Incluye localidades clave** naturales de la ruta (p. ej., si aparece Reynisfjara, añade también **Vík**).

🧠 ESTILO Y EXPERIENCIA
- Tono cálido, motivador; notas en 1–2 líneas con el **porqué** (arquitectura, cultura, gastronomía, naturaleza). Evita repetir frases. Si falta dato, usa un fallback inspirador breve.

📝 EDICIÓN INTELIGENTE
- Ante “agregar/quitar/mover/ajustar”, devuelve el **JSON completo actualizado**, sin solapamientos y con transporte coherente.

✅ CHECKLIST ANTES DE RESPONDER
- JSON puro y parseable. Sin solapamientos.
- "transport" nunca vacío; usa literalmente "Vehículo alquilado o Tour guiado" cuando corresponda.
- Auroras: investigadas/inferidas, no en la última noche, oportunidades espaciadas, duración y regreso realistas (sin fijarlos por norma).
- Tours genéricos con sub-paradas (3–6) bajo un mismo encabezado.
- Flujo por zonas y colchones de traslado.
- Notas motivadoras y no repetidas.

Ejemplo mínimo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}
`.trim();

// ==============================
// Llamada al modelo
// ==============================
async function callStructured(messages, temperature = 0.35) {
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
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — reglas globales con investigación previa
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]
    );
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `
OBLIGATORIO: Responde SOLO con JSON válido y al menos 1 fila en "rows". Nada de texto meta.`;
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
Ejemplo válido mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}
Recuerda: JSON puro, sin explicaciones.`;
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
