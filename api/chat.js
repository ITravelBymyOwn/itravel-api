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

/**
 * Limpia y extrae de forma robusta el primer bloque JSON.
 * Maneja:
 * - ```json ... ``` o ``` ... ```
 * - BOM, backticks y texto antes/después
 * - Comas colgantes simples
 * - JSON parcial donde hay texto fuera
 */
function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;

  // 1) Strip fences y ruido común
  let s = raw
    .replace(/^\uFEFF/, "")                       // BOM
    .replace(/```json\s*|\s*```/gi, "")           // fences ```json ... ```
    .replace(/```/g, "")                          // fences simples
    .trim();

  // 2) Intento directo
  try { return JSON.parse(s); } catch {}

  // 3) Intento limpiando comas colgantes simples (antes de ] o })
  try {
    const s2 = s
      .replace(/,\s*([\]\}])/g, "$1")            // ,]  ,}
      .replace(/:\s*undefined\b/gi, ": null");   // valores 'undefined'
    return JSON.parse(s2);
  } catch {}

  // 4) Recortar primer gran bloque {...} balanceando llaves
  try {
    const start = s.indexOf("{");
    const endLast = s.lastIndexOf("}");
    if (start !== -1 && endLast !== -1 && endLast > start) {
      const cut = s.slice(start, endLast + 1);
      // balanceo básico por conteo de llaves
      let bal = 0, end = -1;
      for (let i = 0; i < cut.length; i++) {
        const c = cut[i];
        if (c === "{") bal++;
        else if (c === "}") {
          bal--;
          if (bal === 0) { end = i; break; }
        }
      }
      const cand = end !== -1 ? cut.slice(0, end + 1) : cut;
      const cand2 = cand.replace(/,\s*([\]\}])/g, "$1");
      return JSON.parse(cand2);
    }
  } catch {}

  // 5) Último intento: quitar texto fuera de llaves
  try {
    const cleaned = s.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
    return JSON.parse(cleaned);
  } catch {
    return null;
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
// Prompt base mejorado ✨ (investigar primero, sub-paradas, transporte coherente,
// auroras posibles desde ≥18:00, evitar última noche; sin fijar horas rígidas)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Antes de proponer, **investiga o infiere** prácticas locales (luz, temporadas, distancias, demanda, accesos). Luego devuelve **EXCLUSIVAMENTE un JSON válido** con el itinerario.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON. Sin saludos ni explicaciones.
- 20 actividades máximo por día.
- **No fijes una ventana rígida**; evita forzar 08:30–19:00. Si no hay información de horarios:
  reparte lógica de mañana / mediodía / tarde y extiende la noche *cuando tenga sentido* (cenas, shows, paseos, auroras).
- **La cena no es obligatoria**: propónla sólo si aporta valor ese día.
- La salida debe poder renderizarse en una UI web (campos completos).
- Nunca devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Tren, Bus, Auto, Tour guiado, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🧠 ESTILO Y EXPERIENCIA
- Tono cálido y narrativo.
- Notas en 1–2 líneas con emoción (“Admira…”, “Descubre…”, “Siente…”).
- Si falta un dato, usa un fallback inspirador (“Una parada ideal…”).
- Varía vocabulario; personaliza por tipo de actividad.

🌌 AURORAS (si el destino/temporada lo permiten)
- Considera ventanas **posibles desde ≥18:00**; evita fijarlas de manera rígida.
- **Evita** programarlas en la **última noche**; prioriza noches tempranas.
- Para estancias de ≥4–5 noches, sugiere **2–3 oportunidades** espaciadas (no noches consecutivas salvo justificación).
- Si el usuario indicó preferencia de vehículo, respétala; si no, sugiere la alternativa más coherente (tour vs. auto) y menciónala en "notes".

🚆 TRANSPORTE Y ALCANCE
- **No priorices** caminar ni transporte público por defecto: considera el mayor alcance si ello habilita lugares espectaculares.
- Cuando el transporte público no sea razonable o el contexto sea rural, usa **EXACTAMENTE** en "transport":
  **"Vehículo alquilado o Tour guiado"** (explica en "notes" la alternativa elegida).
- Ordena horarios sin solapes; incluye duraciones y traslados.

🎫 TOURS Y SUB-PARADAS (claridad máxima)
- En tours de jornada completa o de nombre genérico (p.ej., “Círculo Dorado”, “Costa Sur”, “Snæfellsnes”, “Reykjanes”, “Tour por Kioto”, etc.),
  divide en sub-paradas como **actividades separadas** con el mismo título principal (3–6 hitos representativos).
  Ejemplos:
    "Círculo Dorado — Þingvellir"
    "Círculo Dorado — Geysir"
    "Círculo Dorado — Gullfoss"
  Análogos:
    "Costa Sur — Seljalandsfoss" / "Skógafoss" / "Reynisfjara" / "Vík"
    "Reykjanes — Puente entre Continentes" / "Gunnuhver" / "Seltún (Krýsuvík)" / "Kleifarvatn" / "Brimketill"

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere experiencias naturalmente monetizables (museos, cafés, actividades), sin precios ni marcas.

📝 EDICIÓN INTELIGENTE
- Ante “agregar día/quitar/ajustar”, responde con el JSON actualizado.
- Si no hay hora, reparte lógicamente mañana/mediodía/tarde y, si corresponde, noche.
- Mantén la secuencia cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como historia (inicio, desarrollo, cierre), variado y claro.

🚫 ERRORES A EVITAR
- No “seed”, no frases impersonales, no saludos, no repetir notas idénticas.

Ejemplo de nota correcta:
“Descubre uno de los rincones más encantadores de la ciudad y disfruta su atmósfera única.”
`.trim();

// ==============================
// Llamada al modelo (forzado JSON + mayor margen de tokens)
// ==============================
async function callStructured(messages, temperature = 0.4) {
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    // Forzamos JSON nativo del modelo
    response_format: { type: "json_object" },
    input: messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
    max_output_tokens: 3500,
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

    // 🧭 MODO PLANNER — respuesta en JSON
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages]);
    let parsed = cleanToJSON(raw);

    const hasRows = parsed && (parsed.rows || parsed.destinations);
    if (!hasRows) {
      const strictPrompt = SYSTEM_PROMPT + `
OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.25);
      parsed = cleanToJSON(raw);
    }

    const stillNoRows = !parsed || (!parsed.rows && !parsed.destinations);
    if (stillNoRows) {
      const ultraPrompt = SYSTEM_PROMPT + `
Ejemplo válido:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"A pie","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
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
