// /api/chat.js — v31.5 (ESM compatible en Vercel)
// Base: v31.4 + fixes quirúrgicos (rutas icónicas, transporte dual, auroras proactivas)
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

function stripCodeFences(text = "") {
  if (typeof text !== "string") return text;
  // elimina ```json ... ``` o ``` ... ```
  return text.replace(/^\s*```[\s\S]*?\n/, "").replace(/\n```[\s\S]*?$/m, "").trim();
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  const txt = stripCodeFences(raw);
  const attempts = [
    (s) => s,
    (s) => s.replace(/^[^\{]+/, "").replace(/[^\}]+$/, ""),
  ];
  for (const fn of attempts) {
    try {
      return JSON.parse(fn(txt));
    } catch (_) {}
  }
  return null;
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
        transport: "A pie",
        duration: "",
        notes:
          "Explora libremente la ciudad y descubre sus lugares más emblemáticos.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Normalización y post-procesos
// ==============================
const OUT_OF_TOWN_RE = /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|sk[oó]gafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|kirkjufell|blue\s*lagoon|laguna\s*azul|reykanes|reykjanes|puente\s*entre\s*continentes|d[jj]úpal[óo]nssandur|arnarstapi|snaefellsj[oó]kull|fiordo|glaciar|pen[ií]nsula|costa\s*sur)\b/i;
const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

function pad(n) { return n.toString().padStart(2, "0"); }

function toMinutes(hhmm = "00:00") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function toHHMM(mins = 0) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${pad(h)}:${pad(m)}`;
}

// Ajuste horario para actividades de auroras
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  // ventana plausible 21:30–02:30 (no antes de 21:00 ni después de 03:00)
  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");
  const MIN_START = toMinutes("21:00");
  const PREF_START = toMinutes("21:30");
  const MAX_END = toMinutes("03:00");
  if (s < MIN_START) s = PREF_START;
  if (e <= s) e = s + 120; // mínimo 2h
  if (e > MAX_END) e = MAX_END;
  return { ...row, start: toHHMM(s), end: toHHMM(e), transport: row.transport || "Vehículo alquilado o Tour guiado" };
}

// Transporte inteligente global
function smartTransport(city, row) {
  const isNordic = /reykjavik|troms|oslo|bergen|rovaniemi|iceland|islandia|noruega|norway|finland/i.test(
    `${city} ${row.from || ""} ${row.to || ""}`
  );
  const text = `${row.activity || ""} ${row.to || ""}`;
  const isTrip = OUT_OF_TOWN_RE.test(text);
  let transport = (row.transport || "").trim();

  // Day trips o clima severo: no priorizar "A pie"
  if (isTrip || isNordic) {
    if (!transport || /a pie/i.test(transport)) {
      transport = "Vehículo alquilado o Tour guiado";
    }
    // homogenizar variantes
    if (/tour/i.test(transport) && !/veh[ií]culo|auto/i.test(transport)) {
      transport = "Vehículo alquilado o Tour guiado";
    }
  }
  return { ...row, transport: transport || "Vehículo alquilado o Tour guiado" };
}

// Inserta “Regreso a <dest>” si hubo salida fuera de ciudad y el día no cierra con retorno
function ensureReturnLine(destination, rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  const anyTrip = rowsOfDay.some(r => OUT_OF_TOWN_RE.test(`${r.activity || ""} ${r.to || ""}`));
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    /centro|downtown|city|reykjavik|troms|oslo/i.test(last.to || "");
  if (alreadyBack) return rowsOfDay;

  const endMins = toMinutes(last.end || "18:00");
  const start = toHHMM(endMins + 15);
  const end = toHHMM(endMins + 90);
  const back = {
    day: last.day,
    start,
    end,
    activity: `Regreso a ${destination}`,
    from: last.to || last.activity || destination,
    to: destination,
    transport: "Vehículo alquilado o Tour guiado",
    duration: "1h 15m",
    notes: "Vuelta a la ciudad base para cerrar el recorrido del día.",
  };
  return [...rowsOfDay, back];
}

// Inserta una 2.ª noche de auroras si hay ≥4 días y solo 1 noche, en día no consecutivo
function injectSecondAuroraIfSparse(destination, rows) {
  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(n => +n).sort((a, b) => a - b);
  const totalDays = days.length;
  const auroraDays = days.filter(d => (byDay[d] || []).some(r => AURORA_RE.test(r.activity || "")));

  if (totalDays >= 4 && auroraDays.length === 1) {
    // escoger un día que no sea consecutivo al ya existente
    const first = auroraDays[0];
    const candidates = days.filter(d => Math.abs(d - first) > 1); // no consecutivo
    const target = candidates[0] || (first > 2 ? first - 2 : first + 2);
    const targetRows = byDay[target] || [];
    const last = targetRows[targetRows.length - 1] || { end: "20:30" };
    const start = toHHMM(Math.max(toMinutes(last.end || "20:30") + 30, toMinutes("21:30")));
    const end = toHHMM(Math.min(toMinutes(start) + 120, toMinutes("02:30")));
    const line = {
      day: target,
      start,
      end,
      activity: "Caza de Auroras Boreales",
      from: destination,
      to: "Zona de avistamiento",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "2h",
      notes: "Noche adicional de auroras (no consecutiva). Horario sujeto a clima.",
    };
    return [...rows, line].sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));
  }
  return rows;
}

/** Normaliza una respuesta del modelo:
 *  - Si viene en formato C (destinations[]), lo transforma a formato B
 *  - Garantiza rows con campos mínimos y day numérico
 *  - Post-procesa auroras, transporte y línea de regreso
 */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Aceptar formato C -> convertir al primero con rows
  if (!parsed.rows && Array.isArray(parsed.destinations)) {
    const first = parsed.destinations.find(
      (d) => Array.isArray(d.rows) && d.rows.length > 0
    );
    if (first) {
      parsed = {
        destination: first.name || first.city || first.destination || "Destino",
        rows: first.rows,
        followup: parsed.followup || "",
      };
    }
  }

  if (!Array.isArray(parsed.rows)) return null;

  // Sanitizar filas (sin cambiar la semántica)
  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum =
        Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 5);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      const transport = ((r.transport || "").toString().trim()) || "A pie";
      return {
        day: dayNum,
        start,
        end,
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport,
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };
    })
    .slice(0, 120); // safety

  // Ajustes de auroras (ventanas plausibles)
  rows = rows.map(normalizeAuroraWindow);

  // Transporte inteligente y homogenizado
  const dest = parsed.destination || "Ciudad";
  rows = rows.map(r => smartTransport(dest, r));

  // Insertar "Regreso a <ciudad>" al final de días con day-trip si falta
  const byDayTmp = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const merged = [];
  Object.keys(byDayTmp)
    .map((d) => +d)
    .sort((a, b) => a - b)
    .forEach((d) => {
      const fixed = ensureReturnLine(dest, byDayTmp[d]);
      merged.push(...fixed);
    });

  // Si hay solo 1 noche de auroras y 4+ días, inyectar una 2.ª no consecutiva
  const enriched = injectSecondAuroraIfSparse(dest, merged);

  parsed.rows = enriched;
  return parsed;
}

// ==============================
// Prompt base mejorado ✨
// (horarios flex, cena NO obligatoria, auroras inteligentes,
// transporte dual en day trips, desglose de tours por paradas,
// obligación de agregar la fila de regreso y guía de rutas icónicas)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** que describa un itinerario turístico inspirador y funcional.

📌 FORMATOS VÁLIDOS DE RESPUESTA
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Nada de texto fuera del JSON (sin explicaciones).
- 20 actividades máximo por día.
- Usa horas **realistas con flexibilidad**: NO asumas ventana fija (no fuerces 08:30–19:00).
  Si no hay horarios previos, distribuye lógicamente mañana/mediodía/tarde y, cuando tenga sentido,
  extiende la noche (cenas, shows, paseos, auroras).
- **No obligues la cena**: sugiérela sólo si aporta valor ese día.
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
  "transport": "Transporte realista (A pie, Metro, Taxi, Auto, Tour guiado, etc.)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🌌 AURORAS (si aplica por destino/temporada)
- Proponlas cuando sea plausible (p.ej., Islandia en invierno).
- **Evita noches consecutivas** y evita que la **única** noche sea el **último día**.
- En estancias de 4–5+ días, suele ser razonable **2–3 noches no consecutivas** (incentivo suave, no obligatorio).
- **Horarios plausibles**: inicia entre **21:30–22:30** y termina entre **00:00–02:30** (local). No antes de 21:00 ni después de 03:00.

🚗 ALCANCE DE RUTAS (regla de distancia por trayecto)
- Si la estancia total es **≤ 5 días**: considera recorridos **hasta ~2 h por trayecto**.
- Si la estancia total es **> 5 días**: considera **hasta ~3 h por trayecto**.
- El objetivo es **no dejar fuera** lo más espectacular dentro de ese radio.

🚆 TRANSPORTE Y TIEMPOS
- Medios coherentes (a pie, metro, taxi, auto, ferry…).
- **Islandia y Noruega**: no priorices "A pie" para traslados fuera del centro urbano o con clima severo.
- **Si el usuario no indicó transporte y la actividad es fuera de la ciudad (day trip)**:
  usa **"Vehículo alquilado o Tour guiado"** (evita bus/tren si no es viable).
- Horas ordenadas, **sin solaparse** y con buffers razonables.

🧭 TOURS / DAY TRIPS — DESGLOSE, SUB-PARADAS Y REGRESO
- Cuando sea un recorrido típico, **divide en paradas/waypoints clave** como filas separadas y usa el formato
  **"Ruta — Subparada"** en el campo "activity".
  Ejemplos para **Reykjavik (Islandia)**:
  • **Círculo Dorado**: Thingvellir → Geysir → Gullfoss (y regreso).
  • **Costa Sur**: Seljalandsfoss → Skógafoss → Reynisfjara → Vík (y regreso).
  • **Snæfellsnes**: Kirkjufell → Djúpalónssandur → Parque Snæfellsjökull → Arnarstapi (y regreso).
  • **Reykjanes**: Laguna Azul → Puente entre continentes → Gunnuhver → Costa de Reykjanes (y regreso).
- **No mezcles** rutas icónicas incompatibles el mismo día (p.ej., Reynisfjara con Laguna Azul).
- **Obligatorio**: si el día salió fuera de la ciudad base, **agrega una fila final** clara de **"Regreso a <Ciudad base>"** con hora realista.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (cafés, museos, experiencias locales) sin precios.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide “agregar un día”, “quitar actividad” o “ajustar horarios”, responde con el itinerario JSON actualizado.
- Mantén secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Notas cortas y motivadoras; varía el vocabulario.

🚫 ERRORES A EVITAR
- No devuelvas “seed”.
- No uses frases impersonales (“Esta actividad es…”).
- No incluyas saludos ni explicaciones fuera del JSON.
- No repitas notas idénticas en varias actividades.
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
// Exportación ESM
// ==============================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body || {};
    const mode = body.mode || "planner";
    const clientMessages = extractMessages(body);

    // 🧭 MODO INFO CHAT — sin JSON, texto libre
    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — con reglas flexibles
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = normalizeParsed(cleanToJSON(raw));

    // Pass 2: exige al menos 1 row
    const hasRows = parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0;
    if (!hasRows) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `\n\nOBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    // Pass 3: ejemplo mínimo
    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
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
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    if (!parsed) parsed = fallbackJSON();
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
