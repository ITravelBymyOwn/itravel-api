// /api/chat.js — v30.2 (ESM compatible en Vercel)
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

function stripFences(s = "") {
  // Elimina ```json, ``` y espacios raros/BOM
  return String(s)
    .replace(/^\uFEFF/, "")
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function sliceToJsonBraces(s = "") {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;

  // 1) Intento directo tras limpiar fences
  const noFences = stripFences(raw);
  try {
    return JSON.parse(noFences);
  } catch (_) {
    // 2) Recortar a primer { … último }
    const sliced = sliceToJsonBraces(noFences) || sliceToJsonBraces(raw);
    if (!sliced) return null;
    try {
      return JSON.parse(sliced);
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
        start: "08:30",
        end: "19:00",
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
// Prompt base mejorado ✨ (ajustado sin comentarios en JSON)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido**. **No uses markdown, ni fences, ni comentarios. Solo comillas ASCII rectas.**

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON. Ninguna explicación adicional.
- Máximo 20 actividades por día.
- Usa horas realistas; si una actividad cruza medianoche, añade "_crossDay": true.
- Nunca devuelvas "seed" ni dejes campos obligatorios vacíos.
- Usa comillas rectas ASCII en todo el JSON.

🧭 ESTRUCTURA DE CADA ACTIVIDAD (sin comentarios)
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "A pie | Metro | Tren | Taxi | Bus | Auto | Ferry",
  "duration": "2h",
  "notes": "Descripción breve y motivadora (máx. 2 líneas)",
  "_crossDay": false
}

🧠 ESTILO Y UX
- Tono cálido y narrativo, pero conciso (notas máx. 2 líneas).
- Si faltan datos, reparte lógicamente: mañana / mediodía / tarde / noche.

🚆 TIEMPOS Y BUFFERS
- Horas ordenadas, sin solapes; buffers ≥15 min entre actividades.
- Si "_crossDay" es true, el fin puede ser "01:00".

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugerir experiencias aptas para upsell (cafés, museos, tours) sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide "agregar un día", "quitar actividad" o "ajustar horarios", responde con el itinerario JSON actualizado.

🎨 FLUJO NARRATIVO
- Cada día fluye: inicio → desarrollo → cierre, con equilibrio entre experiencias, descanso y traslados.

🚫 ERRORES A EVITAR
- No uses markdown, no fences, no comentarios, no texto fuera del JSON, no notas repetidas.

────────────────────────────────────────────────────────────────
🌌 NOCTURNAS / AURORAS / OBSERVACIÓN DE CIELO (reglas globales)
- Aplicables en cualquier destino cuando sea plausible (no limitar por país).
- Ventana fija: inicio 18:00, fin 01:00, "_crossDay": true, "duration": "Depende del tour".
- Nota predefinida (primera oración normal; resto en negrita):
  "Noche especial de caza de auroras. **Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. La hora de regreso al hotel dependerá del tour de auroras que se tome. Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche, investiga acerca de la seguridad en la época de tu visita).**"
- Transporte: "Tour guiado o Vehículo propio" si aplica.
- Distribución de noches (sin consecutivas, evitar última noche, favorecer noches tempranas o días “ligeros”):
  1–3 días → 1; 4–5 → 2; 6–7 → 3; 8–10 → 5; 11–15 → 7; >15 → 9 (máximo).
- Si hay day-trip + aurora el mismo día, el "Regreso a <Ciudad>" termina antes de ~18:00–18:30.
- Si la última actividad es nocturna extendida, no agregues "Regreso a hotel" (la nota lo implica).

🚗 TRANSPORTE FUERA DE CIUDAD (regla global)
- Toda actividad fuera del entorno urbano principal usa "Vehículo alquilado o Tour guiado".
- Heurísticas: toponimia distinta a la base; rutas escénicas, cascadas, lagunas, montañas, fiordos, volcanes, zonas rurales.
- No priorices transporte público salvo conectividad clara.

⬅️ REGRESO A CIUDAD BASE
- Tras actividades fuera de ciudad, inserta "Regreso a <Ciudad>":
  • Inicio = fin de la última sub-parada.  
  • Fin = inicio + duración estimada (si no hay distancia, 60–90 min).  
  • Transporte = "Vehículo alquilado o Tour guiado".
- Después del regreso:
  • Actividades siguientes son urbanas (A pie, Taxi, Transporte público).  
  • No heredar "Vehículo alquilado o Tour guiado".  
  • No generar otro "Regreso a <Ciudad>" en el mismo día.

🧭 SUB-PARADAS EN RUTAS/DAY-TRIPS
- Si una jornada llega “genérica”, desglosa 3–6 sub-paradas (orden lógico, sin duplicados).
- Patrones guía:
  "Ruta Escénica — Lago / Cascada / Pueblo histórico"
  "Tour de naturaleza — Mirador / Parque / Volcán / Baños termales"
  "Costa — Playa / Faro / Acantilado / Pueblo costero"

✅ SECUENCIA UNIVERSAL DEL DÍA
1) Normaliza datos (nombres, alias, estructura).
2) Preserva protegidas (auroras existentes, experiencias únicas).
3) Deduplica (sinónimos).
4) Buffers ≥15 min.
5) Identifica nocturnas (18:00–01:00, "_crossDay": true).
6) Desglosa sub-paradas cuando aplique.
7) Transporte “Vehículo alquilado o Tour guiado” solo fuera de ciudad.
8) Inserta "Regreso a <Ciudad>" si hubo salida; luego lógica urbana.
9) Añade "Regreso a hotel" solo si no hay nocturna extendida al final.
10) Permite cruce post-medianoche y corrige solapes.
11) Valida JSON (campos, tipos, "_crossDay").

🧩 VALIDACIONES GLOBALES
- Horarios entre 08:00 y 01:00 máx. (si "_crossDay" es true, puede cerrar a 01:00).
- Asegura transporte urbano tras el “Regreso a <Ciudad>”.
- Elimina regresos duplicados o fuera de secuencia.
- Si el día queda corto, añade "Tiempo libre" con nota inspiradora.

📌 CASOS LÍMITE Y FALLBACK
- Sin horas → dividir en bloques (mañana/mediodía/tarde/noche).
- Sin distancia → regreso 60–90 min.
- Estancias >15 días → máx. 9 noches de auroras.
- Clima adverso/poca luz → prioriza seguridad/descanso.
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
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // MODO INFO CHAT — texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // MODO PLANNER — solo JSON
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]
    );
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Solo JSON puro, sin comentarios, sin fences, sin texto extra, comillas ASCII.`;
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
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad","_crossDay":false}]}`;
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
