// /api/chat.js — v58.1 (quirúrgico) — añade ui_labels table headers multi-idioma
// ✅ Mantiene interfaz v58: recibe {mode, input/history/messages} y responde { text: "<string>" }.
// ✅ NO rompe modo "info": devuelve texto libre.
// ✅ Planner/Info responden en idioma REAL del usuario (cualquier idioma).
// ✅ Nuevo: Planner devuelve ui_labels (etiquetas tabla) en el mismo idioma real del usuario.
// ✅ Soporta override explícito vía body.target_lang (o body.lang).

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

function _lastUserText_(messages = []) {
  try {
    for (let i = (messages?.length || 0) - 1; i >= 0; i--) {
      const m = messages[i];
      if (String(m?.role || "").toLowerCase() === "user") {
        return String(m?.content || "");
      }
    }
  } catch {}
  return "";
}

// Detección simple multi-idioma (quirúrgica): SOLO para fallback/guardrails cuando el modelo no responde.
// Nota: NO afecta el contenido normal (el modelo decide idioma por prompt).
function detectUserLang(messages = []) {
  const t = _lastUserText_(messages).trim();
  if (!t) return "es";

  const s = t.toLowerCase();

  // Señales fuertes de español
  if (/[¿¡ñáéíóúü]/i.test(t)) return "es";
  const esHits = (s.match(/\b(el|la|los|las|de|que|y|para|con|por|una|un|como|donde|qué|cuál|cuáles|cómo)\b/g) || []).length;

  // Señales fuertes de inglés
  const enHits = (s.match(/\b(the|and|for|with|to|from|what|which|how|where|when|please)\b/g) || []).length;

  // Señales fuertes de francés
  const frHits = (s.match(/\b(le|la|les|des|de|du|et|pour|avec|sans|où|quoi|quel|quelle|quels|quelles|s\'il|vous)\b/g) || []).length;

  // Señales fuertes de italiano
  const itHits = (s.match(/\b(il|lo|la|i|gli|le|di|che|e|per|con|senza|dove|cosa|quale|quali|grazie)\b/g) || []).length;

  // Señales fuertes de alemán
  const deHits = (s.match(/\b(der|die|das|und|für|mit|ohne|wo|was|welche|welcher|bitte|danke)\b/g) || []).length;

  // Señales fuertes de portugués
  const ptHits = (s.match(/\b(o|a|os|as|de|que|e|para|com|sem|onde|qual|quais|obrigado|por favor)\b/g) || []).length;

  const scores = [
    ["en", enHits],
    ["es", esHits],
    ["fr", frHits],
    ["it", itHits],
    ["de", deHits],
    ["pt", ptHits],
  ];

  scores.sort((a, b) => (b?.[1] || 0) - (a?.[1] || 0));
  const top = scores[0];
  const topLang = String(top?.[0] || "es");
  const topScore = Number(top?.[1] || 0);

  // Si no hay señales claras, conserva default ES (para tu fallback actual)
  if (!topScore) return "es";
  return topLang;
}

// ✅ QUIRÚRGICO: normaliza override de idioma (acepta códigos o nombres)
function normalizeLangOverride(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  const low = s.toLowerCase();

  // códigos comunes
  const base = low.split(/[-_]/)[0];

  // acepta cualquier idioma "conocido por el modelo" si viene como nombre (ej: "italian", "français", "deutsch", "日本語")
  // pero para prompts usamos una forma “segura”:
  // - si parece código (2-5 chars alfanum), usamos base
  // - si no, usamos el texto tal cual (recortado) como nombre
  if (/^[a-z]{2,5}$/.test(base)) return base;

  // nombres
  if (s.length > 40) return s.slice(0, 40); // guardrail mínimo
  return s;
}

// ✅ QUIRÚRGICO: convierte override a instrucción humana para el prompt
function langLabelForPrompt(lang) {
  const L = String(lang || "").trim();
  if (!L) return "";

  const low = L.toLowerCase();
  const map = {
    en: "English",
    es: "Spanish",
    fr: "French",
    it: "Italian",
    de: "German",
    pt: "Portuguese",
    nl: "Dutch",
    sv: "Swedish",
    no: "Norwegian",
    da: "Danish",
    fi: "Finnish",
    pl: "Polish",
    cs: "Czech",
    hu: "Hungarian",
    tr: "Turkish",
    el: "Greek",
    ru: "Russian",
    uk: "Ukrainian",
    ar: "Arabic",
    he: "Hebrew",
    ja: "Japanese",
    ko: "Korean",
    zh: "Chinese",
  };

  if (map[low]) return map[low];

  // si es un nombre (“italiano”, “français”, “Deutsch”), lo usamos como nombre
  return L;
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

// ✅ QUIRÚRGICO: fallback mínimo de ui_labels (EN/ES; otros -> EN)
function fallbackUILabels(lang = "en") {
  const L = String(lang || "").toLowerCase();
  const useES = L === "es";
  if (useES) {
    return {
      day: "Día",
      start: "Hora inicio",
      end: "Hora final",
      activity: "Actividad",
      from: "Desde",
      to: "Hacia",
      transport: "Transporte",
      duration: "Duración",
      notes: "Notas",
    };
  }
  return {
    day: "Day",
    start: "Start time",
    end: "End time",
    activity: "Activity",
    from: "From",
    to: "To",
    transport: "Transport",
    duration: "Duration",
    notes: "Notes",
  };
}

function fallbackJSON(lang = "es") {
  const L = String(lang || "").toLowerCase();
  const isES = L === "es";
  // Para otros idiomas: fallback en inglés (quirúrgico; no inventamos traducciones aquí)
  const useEN = !isES;

  return {
    destination: isES ? "Desconocido" : "Unknown",
    ui_labels: fallbackUILabels(isES ? "es" : "en"),
    city_day: [
      {
        city: isES ? "Desconocido" : "Unknown",
        day: 1,
        rows: [
          {
            day: 1,
            start: "09:30",
            end: "11:00",
            activity: isES ? "Desconocido – Itinerario base (fallback)" : "Unknown – Base itinerary (fallback)",
            from: "Hotel",
            to: isES ? "Centro" : "Center",
            transport: isES ? "A pie o Transporte local (según ubicación)" : "Walk or local transport (depending on location)",
            duration: isES
              ? "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat"
              : "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat",
            notes: isES
              ? "⚠️ No pude generar el itinerario. Revisa API key/despliegue y vuelve a intentar."
              : "⚠️ I couldn't generate the itinerary. Check your API key/deployment and try again.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: isES
      ? "⚠️ Fallback local: revisa configuración de Vercel o API Key."
      : "⚠️ Local fallback: check your Vercel config or API key.",
  };
}

// Guard-rail: evita tabla en blanco si el modelo falla en planner
function skeletonCityDay(destination = "Destino", daysTotal = 1, lang = "es") {
  const L = String(lang || "").toLowerCase();
  const isES = L === "es";

  const city = String(destination || (isES ? "Destino" : "Destination")).trim() || (isES ? "Destino" : "Destination");
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
          activity: isES ? `${city} – Reintentar generación (itinerario pendiente)` : `${city} – Retry generation (itinerary pending)`,
          from: "Hotel",
          to: isES ? "Centro" : "Center",
          transport: isES ? "A pie o Transporte local (según ubicación)" : "Walk or local transport (depending on location)",
          duration: isES
            ? "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat"
            : "Transport: Check duration in Info Chat\nActivity: Check duration in Info Chat",
          notes: isES
            ? "⚠️ No se obtuvo un itinerario válido en este intento. Reintenta o ajusta condiciones; cuando funcione, aquí verás el plan final."
            : "⚠️ No valid itinerary was produced in this attempt. Retry or adjust conditions; when it works, you’ll see the final plan final here.",
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
    // Prefer city_day
    if (Array.isArray(parsed.city_day)) {
      const dest = String(parsed?.destination || "").trim();
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
    }

    // rows legacy
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

    // ✅ QUIRÚRGICO: normaliza ui_labels si viene (sin imponer idioma)
    if (parsed.ui_labels && typeof parsed.ui_labels === "object") {
      const o = parsed.ui_labels || {};
      parsed.ui_labels = {
        day: String(o.day ?? "").trim(),
        start: String(o.start ?? "").trim(),
        end: String(o.end ?? "").trim(),
        activity: String(o.activity ?? "").trim(),
        from: String(o.from ?? "").trim(),
        to: String(o.to ?? "").trim(),
        transport: String(o.transport ?? "").trim(),
        duration: String(o.duration ?? "").trim(),
        notes: String(o.notes ?? "").trim(),
      };
    }
  } catch {}

  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (PLANNER) — Ajustado a reglas v52.5 + ui_labels
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser EXCLUSIVAMENTE un JSON válido (sin markdown, sin backticks, sin texto fuera).

IDIOMA (CRÍTICO, MULTI-IDIOMA REAL):
- Responde SIEMPRE en el idioma REAL en el que el usuario escribió su información (cualquier idioma).
- En Planner, el mensaje del usuario puede incluir texto de plantilla/labels del sistema (por ejemplo: "Preferencias", "Restricciones", "Start time", etc.).
  Esos labels NO deben determinar el idioma de salida.
- Determina el idioma objetivo por el contenido escrito por el usuario (sus frases, restricciones, gustos, condiciones, etc.) y úsalo en TODO el JSON.
- Si el usuario mezcla idiomas:
  • Prioriza el idioma dominante del contenido escrito por el usuario.
  • Si no hay dominante claro, usa el idioma del último párrafo/entrada del usuario.
- NO traduzcas al idioma del sitio ni al idioma del sistema, a menos que el usuario explícitamente pida traducción.

ETIQUETAS DE TABLA (CRÍTICO):
- Además del itinerario, debes incluir SIEMPRE un objeto "ui_labels" con las etiquetas de la tabla en el MISMO idioma objetivo.
- "ui_labels" debe contener EXACTAMENTE estas llaves: day, start, end, activity, from, to, transport, duration, notes.
- Los valores deben ser traducciones naturales y cortas (1–3 palabras), en el idioma objetivo.

USO DE CONTEXTO (CRÍTICO):
- Debes usar TODA la información provista por el usuario en el tab del Planner.
- ESPECIALMENTE: Preferencias / Restricciones / Condiciones especiales (aplícalas en cada decisión: ritmo, horarios, movilidad, presupuesto, comidas, accesibilidad, intereses, seguridad, etc.).
- Si el usuario provee información de viajeros (edades, niños, adultos mayores, movilidad, intereses), incorpórala activamente en: horarios, descansos, duración de bloques, transporte, tipo de actividades y notas.
- Si hay conflicto entre preferencias (por ejemplo, “cero caminata” pero “tour de senderismo”), prioriza seguridad/viabilidad y ofrece alternativa equivalente.
- Si falta un dato crítico para cumplir una restricción, asume lo mínimo posible y refleja la condición en notes (ej.: "Confirmar horarios/entradas") sin romper el itinerario.

FORMATO PREFERIDO (tabla-ready):
A) {
  "destination":"Ciudad",
  "days_total":N,
  "ui_labels":{"day":"..","start":"..","end":"..","activity":"..","from":"..","to":"..","transport":"..","duration":"..","notes":".."},
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
B) {"destination":"City","ui_labels":{...},"rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","ui_labels":{...},"rows":[{...}]}],"followup":"texto breve"}

REGLA DE ORO:
- Debe ser LISTO PARA TABLA: cada fila trae TODO lo necesario.
- Devuelve SIEMPRE al menos 1 fila renderizable (nunca tabla en blanco).
- Incluye SIEMPRE "ui_labels".
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
  IMPORTANTE (GLOBAL):
  - "DESTINO" NO es siempre la ciudad:
    • Si la fila pertenece a un DAY TRIP / MACRO-TOUR, "DESTINO" debe ser el NOMBRE del macro-tour (ej. "Círculo Dorado", "Costa Sur", "Toledo", "Sinaí", "Giza").
    • Si NO es day trip, "DESTINO" puede ser la ciudad base.
  - Esto aplica también a traslados y regresos:
    • Ejemplo day trip: "Costa Sur – Regreso a Reykjavik"
    • Ejemplo ciudad: "Budapest – Regreso a hotel"
- duration: 2 líneas EXACTAS con salto \\n:
  "Transporte: <estimación realista o ~rango>"
  "Actividad: <estimación realista o ~rango>"
  PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- notes: obligatorias (>=20 caracteres), motivadoras y útiles:
  1) 1 frase emotiva (Admira/Descubre/Siente…)
  2) 1 tip logístico (mejor hora, reservas, tickets, vista, etc.)
  + condición/alternativa si aplica
  + (cuando aplique) agrega "Relacionado: <spot cercano/pareja lógica>" para no omitir imperdibles relacionados

COMIDAS (Regla flexible):
- NO son obligatorias.
- Inclúyelas SOLO si aportan valor real al flujo.
- Si se incluyen, NO genéricas (ej. "cena en restaurante local" prohibido).

HORARIOS / CIERRES (GLOBAL, anti-horarios imposibles):
- Para lugares con horario típico (museos, castillos, monumentos interiores, termas, mercados), NO programes visitas fuera de un rango diurno razonable.
  Guía si no estás 100% seguro: 10:00–17:00 para interiores / museos.
- Si el lugar puede estar cerrado ciertos días (p.ej. lunes) y NO estás seguro, evita programarlo en franja extrema y agrega en notes: "Horario exacto a confirmar (puede cerrar algunos días)".
- Para miradores/puentes/zonas exteriores, puedes ser más flexible.

TOURS NOCTURNOS (GLOBAL, cuando aplique):
- Si el destino tiene un ícono que brilla de noche o experiencia nocturna clásica, incluye AL MENOS 1 actividad nocturna icónica.
- Mantén horarios realistas (p.ej. 19:00–23:30) y notes con tip logístico.

AURORAS (Regla flexible + NEGATIVA fuerte):
- SOLO sugerir auroras si SON plausibles por latitud/temporada.
- Si NO es zona auroral típica, NO las sugieras.
- Si son plausibles: evitar días consecutivos; evitar el último día; horario nocturno típico local.
- Notes deben incluir: "valid:" + (clima/nubosidad) + alternativa low-cost cercana.

DAY-TRIPS / MACRO-TOURS:
- Si haces una excursión/“day trip”, debes desglosarla en 5–8 sub-paradas (filas).
- Siempre cerrar con una fila propia de regreso: "<Macro-tour> – Regreso a {Ciudad base}".
- Evitar último día si hay opciones.
- En day trips, evita tiempos optimistas: el regreso desde el ÚLTIMO punto debe ser realista/conservador.

SEGURIDAD / COHERENCIA GLOBAL:
- No propongas cosas inviables por distancia/tiempo/temporada o riesgos evidentes.
- Prioriza opciones plausibles, seguras y razonables.

EDICIÓN INTELIGENTE:
- Si el usuario pide agregar/quitar/ajustar horarios, devuelve el JSON actualizado y consistente.
- Por defecto, mantén coherencia global del itinerario.

Responde SOLO JSON válido.
`.trim();

// ==============================
// Prompt base ✨ (INFO CHAT LIBRE) — como ChatGPT: cualquier tema + contexto + idioma real del usuario
// ==============================
const SYSTEM_PROMPT_INFO = `
Eres Astra, un asistente conversacional general (como ChatGPT) dentro de ITravelByMyOwn.

OBJETIVO:
- Responder de forma útil, honesta y completa sobre CUALQUIER tema.
- Mantener el contexto de la conversación usando el historial provisto (messages/history).
- Si falta información para responder bien, pregunta 1–2 cosas clave (no hagas 10 preguntas).
- No inventes datos; si algo no es seguro, dilo.

IDIOMA (CRÍTICO, MULTI-IDIOMA REAL):
- Responde SIEMPRE en el idioma REAL del contenido del último mensaje del usuario (cualquier idioma).
- Si el mensaje incluye texto de plantilla/labels del sistema, NO uses esos labels para decidir el idioma.
- Si el usuario mezcla idiomas, prioriza el idioma dominante del contenido escrito por el usuario.

FORMATO:
- Responde en texto natural (no JSON).
- Usa estructura clara (párrafos cortos, listas cuando convenga).
`.trim();

// ✅ QUIRÚRGICO: inyecta override de idioma en un prompt dado (sin reescribir SYSTEM_PROMPT)
function applyLangOverrideToPrompt(basePrompt, langOverride = "") {
  const L = normalizeLangOverride(langOverride);
  if (!L) return basePrompt;

  const label = langLabelForPrompt(L);
  if (!label) return basePrompt;

  const injection = `
IDIOMA OVERRIDE (CRÍTICO):
- El cliente ha especificado el idioma objetivo: ${label}.
- Debes responder COMPLETAMENTE en ${label} (incluye destination/city/activity/notes/followup, ui_labels y cualquier texto).
- Ignora el idioma de labels/plantillas del sistema si entran en otro idioma.
`.trim();

  return `${basePrompt}\n\n${injection}`;
}

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

    const text = resp?.output_text?.trim() || resp?.output?.[0]?.content?.[0]?.text?.trim() || "";

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

    // ✅ QUIRÚRGICO: override explícito de idioma (opcional) desde frontend
    const langOverride = normalizeLangOverride(body?.target_lang || body?.lang || "");
    const langFallback = detectUserLang(clientMessages);

    // 🧭 MODO INFO CHAT — texto libre
    if (mode === "info") {
      const sys = applyLangOverrideToPrompt(SYSTEM_PROMPT_INFO, langOverride);
      const raw = await callStructured([{ role: "system", content: sys }, ...clientMessages], 0.45, 2600, 70000);
      const text = (raw || "").trim() || "⚠️ No response was obtained from the assistant.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — reglas fuertes
    const sysPlanner = applyLangOverrideToPrompt(SYSTEM_PROMPT, langOverride);

    let raw = await callStructured([{ role: "system", content: sysPlanner }, ...clientMessages], 0.28, 3200, 90000);
    let parsed = cleanToJSON(raw);

    // 1) Retry: strict
    const hasSome = parsed && (Array.isArray(parsed.city_day) || Array.isArray(parsed.rows) || Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictPrompt =
        sysPlanner +
        `

OBLIGATORIO:
- Responde SOLO JSON válido.
- Debe traer city_day (preferido) o rows (legacy) con al menos 1 fila.
- Debe incluir ui_labels.
- Nada de meta ni texto fuera.`;
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.22, 3400, 95000);
      parsed = cleanToJSON(raw);
    }

    // 2) Retry: ultra con ejemplo mínimo
    const stillBad = !parsed || (!Array.isArray(parsed.city_day) && !Array.isArray(parsed.rows) && !Array.isArray(parsed.destinations));

    if (stillBad) {
      const ultraPrompt =
        sysPlanner +
        `

Ejemplo válido mínimo (NO lo copies literal; solo guía de formato):
{
  "destination":"CITY",
  "days_total":1,
  "ui_labels":{"day":"Day","start":"Start time","end":"End time","activity":"Activity","from":"From","to":"To","transport":"Transport","duration":"Duration","notes":"Notes"},
  "city_day":[{"city":"CITY","day":1,"rows":[
    {"day":1,"start":"09:30","end":"11:00","activity":"CITY – Punto icónico","from":"Hotel","to":"Center","transport":"Walk","duration":"Transporte: ~10m\\nActividad: ~90m","notes":"Descubre un rincón emblemático y llega temprano para evitar filas. Tip: lleva agua y revisa horarios.","kind":"","zone":""}
  ]}],
  "followup":""
}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.14, 3600, 95000);
      parsed = cleanToJSON(raw);
    }

    // 3) Normalización + guard-rails anti-tabla-en-blanco
    const fbLang = langOverride || langFallback;

    if (!parsed) parsed = fallbackJSON(fbLang);

    parsed = normalizeParsed(parsed);

    // ✅ QUIRÚRGICO: si faltan ui_labels, inyecta fallback mínimo para que el front pueda renderizar headers
    try {
      const ul = parsed?.ui_labels;
      const hasAll =
        ul &&
        typeof ul === "object" &&
        ["day", "start", "end", "activity", "from", "to", "transport", "duration", "notes"].every((k) => String(ul?.[k] || "").trim());
      if (!hasAll) {
        parsed.ui_labels = fallbackUILabels(fbLang === "es" ? "es" : "en");
      }
    } catch {
      parsed.ui_labels = fallbackUILabels(fbLang === "es" ? "es" : "en");
    }

    // Guard-rail final: si city_day existe pero viene vacío/sin filas, inyecta skeleton
    try {
      const dest = String(parsed?.destination || "Destination").trim() || "Destination";
      const daysTotal = Math.max(1, Number(parsed?.days_total || 1));

      if (Array.isArray(parsed.city_day)) {
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
        if (!_hasAnyRows_(parsed.city_day)) {
          parsed.city_day = skeletonCityDay(dest, daysTotal, fbLang);
          parsed.followup =
            (parsed.followup ? parsed.followup + " | " : "") +
            "⚠️ Guard-rail: empty city_day or no rows. Returned skeleton to avoid a blank table.";
        }
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);

    // En caso de excepción, intentamos responder en el idioma del usuario basándonos en el body (solo para fallback).
    try {
      const body = req?.body || {};
      const clientMessages = extractMessages(body);
      const langFallback = detectUserLang(clientMessages);
      const langOverride = normalizeLangOverride(body?.target_lang || body?.lang || "");
      const fbLang = langOverride || langFallback;
      return res.status(200).json({ text: JSON.stringify(fallbackJSON(fbLang)) });
    } catch {
      return res.status(200).json({ text: JSON.stringify(fallbackJSON("es")) });
    }
  }
}
