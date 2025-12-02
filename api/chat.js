// /api/chat.js — v36.2 (ESM compatible en Vercel)
// FIX: paréntesis extra en extractMessages (provocaba fallback inmediato).
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
  const userText = typeof input === "string" ? input : ""; // ✅ fix aquí
  return [...prev, { role: "user", content: userText }];
}

function stripCodeFences(text = "") {
  if (typeof text !== "string") return text;
  // elimina ```json ... ``` o ``` ... ```
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryExtractJSONObject(s = "") {
  const txt = String(s);
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start >= 0 && end > start) return txt.slice(start, end + 1);
  return null;
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;
  const candidates = [];

  const stripped = stripCodeFences(raw);
  if (stripped) candidates.push(stripped);

  const fenced = (raw.match(/```(?:json)?([\s\S]*?)```/i) || [])[1];
  if (fenced) candidates.push(fenced.trim());

  const sliced = tryExtractJSONObject(raw);
  if (sliced) candidates.push(sliced);

  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      if (j && typeof j === "object") return j;
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
        end: "10:00",
        activity: "Actividad",
        from: "",
        to: "",
        transport: "Taxi",
        duration: "1h",
        notes: "Explora un rincón de la ciudad.",
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// Escapar texto para usarlo dentro de un RegExp literal sin romperlo
function escapeRegExp(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ==============================
// Normalización y post-procesos
// ==============================

// Heurística para detectar salidas fuera de ciudad (day-trips conocidos/semánticos)
const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|kirkjufell|djúpalónssandur|puente\s+entre\s+continentes|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching)\b/i;

const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

// Ciudades/regiones típicas de latitud >= ~55°N (heurístico)
const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|ivattilo|inuvik|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;

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

// Ajuste horario para actividades de auroras (>=18:00; óptimo 21:30–02:30)
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;

  // Duro: nunca antes de 18:00. Óptimo 21:30–02:30
  const MIN_EVENING = toMinutes("18:00");
  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");
  const PREF_START = toMinutes("21:30");
  const MAX_END = toMinutes("03:00");
  if (s < MIN_EVENING) s = PREF_START;
  if (e <= s) e = s + 120; // mínimo 2h
  if (e > MAX_END) e = MAX_END;

  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e),
    transport: row.transport || "Vehículo alquilado o Tour guiado",
  };
}

// Inserta “Regreso a <dest>” si hubo salida fuera de ciudad y el día no cierra con retorno
function ensureReturnLine(destination, rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;

  const anyTrip = rowsOfDay.some(r =>
    OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`)
  );
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};

  // ⛑️ Escapar el destino antes de compilar el RegExp
  const safeDest = escapeRegExp(destination || "");
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    (safeDest ? new RegExp(safeDest, "i").test(last.to || "") : false);
  if (alreadyBack) return rowsOfDay;

  // crear regreso con buffer 20–90m
  const endMins = toMinutes(last.end || "18:00");
  const start = toHHMM(endMins + 20);
  const end = toHHMM(endMins + 90);
  const back = {
    day: last.day,
    start,
    end,
    activity: `Regreso a ${destination}`,
    from: last.to || last.activity || destination,
    to: destination,
    transport:
      /tour|veh[ií]culo|auto/i.test(last.transport || "")
        ? "Vehículo alquilado o Tour guiado"
        : (last.transport || "Vehículo alquilado o Tour guiado"),
    duration: "1h 10m",
    notes: "Retorno a la ciudad base para cerrar el día.",
  };
  return [...rowsOfDay, back];
}

// Detección simple de ciudades aptas para auroras por nombre (lat >= ~55°N)
function isAuroraEligibleCity(name = "") {
  return AURORA_CITY_RE.test(String(name || ""));
}

// Inyecta auroras si el itinerario plausible no las incluyó (no consecutivas, evitando sólo el último día)
function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraEligibleCity(dest)) return rows;

  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!days.length) return rows;

  const hasAurora = rows.some(r => AURORA_RE.test(r.activity || ""));
  if (hasAurora) return rows;

  const last = days[days.length - 1];
  const d1 = days.find(d => d !== last) || days[0];
  const d2 = days.length >= 4
    ? days.find(d => d !== d1 && d !== last && Math.abs(d - d1) > 1)
    : null;

  const makeAuroraRow = (day) => {
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:30");
    const s = Math.max(endLast + 30, toMinutes("21:30"));
    const e = s + 120;
    return normalizeAuroraWindow({
      day,
      start: toHHMM(s),
      end: toHHMM(e),
      activity: "Caza de Auroras Boreales",
      from: dest,
      to: "Zona de caza",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "2h",
      notes: "Salida nocturna para intentar ver auroras (horario orientativo).",
    });
  };

  const augmented = rows.slice();
  augmented.push(makeAuroraRow(d1));
  if (d2) augmented.push(makeAuroraRow(d2));

  augmented.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));
  return augmented;
}

/** Normaliza la respuesta del modelo:
 *  - Acepta formato C (destinations[]) y lo convierte a B
 *  - Sanitiza filas
 *  - Postprocesa transporte, auroras y línea de regreso
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
      const dayNum = Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 7);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      let transport = ((r.transport || "").toString().trim());

      // Day trip: fuerza transporte dual si está vacío / no viable
      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()}`);
      if (isTrip && (!transport || /a pie|bus|tren/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      }

      // En urbano: no priorizar "A pie" por defecto; si el modelo lo puso, se respeta.
      if (!isTrip && !transport) {
        transport = "Taxi";
      }

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

  // Insertar "Regreso a <ciudad>" al final de días con day-trip si falta
  const dest = parsed.destination || "Ciudad";
  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const merged = [];
  Object.keys(byDay)
    .map((d) => +d)
    .sort((a, b) => a - b)
    .forEach((d) => {
      const fixed = ensureReturnLine(dest, byDay[d]);
      merged.push(...fixed);
    });

  // Inyectar auroras si corresponde y no existen (ciudades elegibles)
  const withAuroras = injectAuroraIfMissing(dest, merged);

  // Reorden final por día/hora
  withAuroras.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));

  parsed.rows = withAuroras;
  return parsed;
}

// ==============================
// Prompt base (reglas del agente)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con un itinerario inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows".
- Cero texto fuera del JSON (sin explicaciones).
- Máximo 20 actividades por día.
- Horarios **flexibles y realistas** (no asumas ventana fija). Distribuye mañana/mediodía/tarde y extiende la noche cuando aporte valor (cenas, shows, auroras).
- Cenas **opcionales**, no obligatorias.
- No devuelvas "seed" ni dejes campos vacíos.

🧭 ESTRUCTURA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (A pie, Metro, Taxi, Bus, Auto, Ferry, Tour guiado)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🌟 IMPERDIBLES Y RADIO DE COBERTURA
- Con tu conocimiento general, **identifica recorridos icónicos** del destino (day-trips, penínsulas, cascadas, volcanes, rutas escénicas, etc.).
- Si la estancia es **≤ 5 días**, prioriza lo mejor **dentro de ~2h por trayecto** desde la ciudad base; si es **> 5 días**, permite **hasta ~3h** por trayecto.
- Cuando el recorrido lo amerite, desglosa en **sub-paradas** con el formato **"Destino — Subparada"** (p.ej., "Costa Sur — Seljalandsfoss", "Círculo Dorado — Geysir").
- **No priorices "A pie" por inercia**: elige el medio que maximiza la experiencia (clima, distancias, confort).

🌌 AURORAS — **REGLA DURA**
- **Solo** sugiérelas cuando el destino esté en **latitudes ≥ ~55°N** **y** la fecha esté en **temporada auroral** (aprox. **finales de agosto a mediados de abril**).
- Horarios **siempre ≥ 18:00**, preferiblemente **21:30–02:30**.
- Evita noches consecutivas y evita que la única noche sea el último día; en 4–5+ días, 2–3 noches es razonable.

🚆 TRANSPORTE Y TIEMPOS
- Horas ordenadas, **sin solapes**, con buffers razonables.
- En **day trips** cuando el usuario no especifica, usa **"Vehículo alquilado o Tour guiado"** (evita bus/tren si no es viable).
- Incluye tiempos aproximados de actividad y traslados.

🔁 REGRESO
- Si el día salió fuera de la ciudad base, **agrega** al final **"Regreso a <Ciudad base>"** con hora realista.

📝 EDICIÓN
- Si el usuario pide agregar/quitar/ajustar, responde con el **JSON actualizado**.

🎨 ESTILO
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Notas cortas y motivadoras; vocabulario variado.

🚫 EVITA
- saludos, meta-explicaciones, "seed", notas repetidas, frases impersonales.
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
        `

OBLIGATORIO: Devuelve al menos 1 fila en "rows". Nada de meta.`;
      raw = await callStructured(
        [{ role: "system", content: strictPrompt }, ...clientMessages],
        0.25
      );
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    // Pass 3: ejemplo mínimo (solo formato; sin predefinir contenido)
    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo VÁLIDO de formato mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"Taxi","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}`;
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
