// /api/chat.js — v30.1 (ESM compatible en Vercel)
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
// Prompt base mejorado ✨ (actualizado con lógica global)
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
- Usa horas realistas; permite cruce post-medianoche usando "_crossDay": true cuando aplique.
- La respuesta debe poder renderizarse directamente en una UI web.
- Nunca devuelvas "seed" ni dejes campos obligatorios vacíos.

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
  "notes": "Descripción motivadora y breve",
  "_crossDay": false   // Opcional; true si cruza medianoche
}

🧠 ESTILO Y EXPERIENCIA DE USUARIO
- Tono cálido, entusiasta y narrativo, con notas breves (máx. 2 líneas).
- Las notas deben:
  • Explicar por qué la actividad es especial.  
  • Transmitir emoción y motivación.  
  • Variar el lenguaje (evita notas idénticas).
- Si faltan datos, reparte lógicamente: mañana / mediodía / tarde / noche.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes con el contexto (A pie, Metro, Tren, Taxi, Bus, Auto, Ferry…).
- Horas ordenadas y sin solapes; buffers ≥15 min entre actividades.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere experiencias naturalmente vinculables a upsells (cafés, museos, tours), sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Si no especifica hora, distribuye en bloques lógicos.

🎨 UX Y NARRATIVA
- Cada día debe fluir: inicio → desarrollo → cierre.
- Mantén equilibrio entre experiencias, descanso y desplazamientos.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni texto fuera del JSON.
- No repitas notas idénticas.

────────────────────────────────────────────────────────────────
🌌 REGLAS GLOBALES — NOCTURNAS / AURORAS / OBSERVACIÓN DE CIELO (universales)
- Son válidas en cualquier destino o temporada cuando sea plausible (no limitar por países).
- **Ventana fija**: inicio 18:00, fin 01:00 (cruza de día) → usa "_crossDay": true.
- **Duración**: "Depende del tour".
- **Nota predefinida breve** (primera oración normal; lo demás en negrita):
  "Noche especial de caza de auroras. **Con cielos despejados y paciencia, podrás presenciar un espectáculo natural inolvidable. La hora de regreso al hotel dependerá del tour de auroras que se tome. Puedes optar por tour guiado o movilización por tu cuenta (es probable que debas conducir con nieve y de noche, investiga acerca de la seguridad en la época de tu visita).**"
- **Transporte**: “Tour guiado o Vehículo propio” si aplica.
- **Distribución (sin noches consecutivas, evitar última noche, priorizar noches tempranas/intermedias o “días ligeros”)**:
  Estancia 1–3d → 1 noche; 4–5d → 2; 6–7d → 3; 8–10d → 5; 11–15d → 7; >15d → 9 (máximo).
- Si el día combinó day-trip + aurora, asegura que el **Regreso a ciudad** concluya antes de ~18:00–18:30.
- Si la última actividad es esta nocturna extendida, **no** agregues "Regreso a hotel" (la nota ya lo implica).

🚗 REGLA GLOBAL DE TRANSPORTE “FUERA DE CIUDAD”
- Para actividades fuera del entorno urbano principal, asigna **"Vehículo alquilado o Tour guiado"**.
- Heurísticas: toponimia distinta a la base; rutas escénicas, cascadas, lagunas, montañas, fiordos, volcanes, zonas rurales.
- No priorices transporte público salvo evidencia clara de alta conectividad.

⬅️ REGRESO A CIUDAD BASE (cuando hubo salida fuera de ciudad)
- Inserta una actividad **"Regreso a <Ciudad>"**:
  • Inicio = fin de la última sub-parada fuera de ciudad.  
  • Fin = inicio + duración estimada (si no hay distancia, usa 60–90 min).  
  • Transporte = "Vehículo alquilado o Tour guiado".
- Tras este regreso:
  • Las actividades siguientes se tratan **como urbanas** (A pie, Taxi, Transporte público).  
  • No pueden heredar “Vehículo alquilado o Tour guiado”.  
  • No generes otro “Regreso a <Ciudad>” en el **mismo día**.

🧭 SUB-PARADAS EN RUTAS/DAY-TRIPS
- Si devuelves una jornada genérica sin detalle, **desglosa 3–6 sub-paradas** (orden lógico, sin duplicados).
- Patrones guía (no rígidos):  
  “Ruta Escénica — Lago / Cascada / Pueblo histórico”  
  “Tour de naturaleza — Mirador / Parque / Volcán / Baños termales”  
  “Costa — Playa / Faro / Acantilado / Pueblo costero”

✅ SECUENCIA UNIVERSAL DE OPTIMIZACIÓN DEL DÍA
1) Normaliza datos (nombres, alias, estructura).
2) Preserva filas protegidas (auroras existentes, experiencias únicas).
3) Deduplica (sinónimos).
4) Buffers ≥15 min.
5) Identifica nocturnas (ventana 18:00–01:00, _crossDay).
6) Desglosa sub-paradas cuando corresponda.
7) Aplica transporte: "Vehículo alquilado o Tour guiado" solo fuera de ciudad.
8) Inserta "Regreso a <Ciudad>" si hubo salida; luego desbloquea lógica urbana.
9) Añade "Regreso a hotel" solo si **no** hay nocturna extendida al final.
10) Permite cruce post-medianoche y corrige solapes.
11) Valida JSON (campos, tipos, _crossDay).

🧩 VALIDACIONES GLOBALES
- Horarios fluyen entre 08:00 y 01:00 máx. (no fuerces si _crossDay).
- Marca "_crossDay": true cuando una actividad cruza medianoche.
- Asegura transporte urbano tras el “Regreso a <Ciudad>”.
- Elimina regresos duplicados o fuera de secuencia.
- Si el día queda corto, añade “Tiempo libre” con nota inspiradora.

📌 CASOS LÍMITE Y FALLBACK
- Sin horas → bloques lógicos (mañana/mediodía/tarde/noche).
- Sin distancia → regreso 60–90 min estimados.
- Estancias >15 días → máximo 9 noches de auroras.
- Clima adverso/poca luz → prioriza seguridad/descanso.

📝 EJEMPLOS REFERENCIALES (no reglas rígidas)
- “Ciudad base — Ruta escénica — Cascada / Volcán / Pueblo — Regreso a ciudad — Cena local — Caza de auroras (18:00–01:00).”
- “Ciudad — Tour de naturaleza — Lago / Mirador / Parque — Regreso a ciudad — Paseo nocturno — Hotel.”
- “Ciudad — Excursión día completo — Sub-paradas — Regreso a ciudad — Cena — Hotel.”

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
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
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
    const mode = body.mode || "planner"; // 👈 modo
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — comportamiento original con prompt reforzado
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta. Usa "_crossDay": true si una actividad cruza medianoche, y sigue las reglas de nocturnas/auroras, transporte "fuera de ciudad", "Regreso a <Ciudad>" y sub-paradas.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad","_crossDay":false}]}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.1);
      parsed = cleanToJSON(raw);
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });

  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
