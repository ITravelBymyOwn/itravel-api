// /api/chat.js — v36.4 (ESM compatible en Vercel)
// Cambios v36.4 (ultra-quirúrgicos):
// - callStructured simplificado y robusto (3 intentos, sin response_format).
// - cleanToJSON vuelve al enfoque tolerante de v31.2 + 1 pasada extra opcional.
// - Se mantiene TODA la lógica nueva: auroras (regla dura horarios ≥18:00), “Vehículo alquilado o Tour guiado” en day-trips,
//   sub-paradas "Destino — Subparada", regreso a ciudad base, radio ≤2h (≤5d) o ≤3h (>5d), no priorizar “A pie” por inercia.
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
  // Remueve cercas si vinieran, pero sin vaciar todo si no existen
  const t = text.trim();
  if (/^```/m.test(t) && /```$/m.test(t)) {
    return t.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return t;
}

function cleanToJSON(raw = "") {
  if (!raw || typeof raw !== "string") return null;

  // Enfoque v31.2 (tolerante) + una pasada extra opcional
  const txt = stripCodeFences(raw);

  // 1) parse directo
  try {
    return JSON.parse(txt);
  } catch {}

  // 2) recorta basura antes/después del primer/último brace (v31.2 style)
  try {
    const cleaned = txt.replace(/^[^\{]+/, "").replace(/[^\}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}

  // 3) pasada opcional: toma el mayor bloque { ... } si existiera
  try {
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}

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

function escapeRegExp(str = "") {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ==============================
// Normalización y post-procesos
// ==============================
const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|kirkjufell|djúpalónssandur|puente\s+entre\s+continentes|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching)\b/i;

const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|inuvik|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;

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

// ≥18:00; preferible 21:30–02:30
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;

  const MIN_EVENING = toMinutes("18:00");
  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");
  const PREF_START = toMinutes("21:30");
  const MAX_END = toMinutes("03:00");
  if (s < MIN_EVENING) s = PREF_START;
  if (e <= s) e = s + 120;
  if (e > MAX_END) e = MAX_END;

  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e),
    transport: row.transport || "Vehículo alquilado o Tour guiado",
  };
}

function ensureReturnLine(destination, rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;

  const anyTrip = rowsOfDay.some(r =>
    OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`)
  );
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const safeDest = escapeRegExp(destination || "");
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    (safeDest ? new RegExp(safeDest, "i").test(last.to || "") : false);
  if (alreadyBack) return rowsOfDay;

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

function isAuroraEligibleCity(name = "") {
  return AURORA_CITY_RE.test(String(name || ""));
}

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

function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

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

  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum = Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 7);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      let transport = ((r.transport || "").toString().trim());

      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()}`);
      if (isTrip && (!transport || /a pie|bus|tren/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      }
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
    .slice(0, 120);

  rows = rows.map(normalizeAuroraWindow);

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

  const withAuroras = injectAuroraIfMissing(dest, merged);

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
// Llamada al modelo (3 intentos seguros)
// ==============================
async function callStructured(messages, temperature = 0.4) {
  // 1) intento normal (como v31.2)
  try {
    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      temperature,
      input: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
      max_output_tokens: 3200,
    });
    const text =
      resp?.output_text?.trim() ||
      resp?.output?.[0]?.content?.[0]?.text?.trim() ||
      "";
    if (text) return text;
  } catch (e) {
    console.warn("callStructured#1", e?.message || e);
  }

  // 2) intento estricto: SOLO JSON
  try {
    const forced = [
      { role: "system", content: "Devuelve EXCLUSIVAMENTE un JSON válido del itinerario solicitado. Ningún texto fuera del JSON." },
      ...messages,
    ];
    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      temperature: 0.25,
      input: forced.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
      max_output_tokens: 3200,
    });
    const text =
      resp?.output_text?.trim() ||
      resp?.output?.[0]?.content?.[0]?.text?.trim() ||
      "";
    if (text) return text;
  } catch (e) {
    console.warn("callStructured#2", e?.message || e);
  }

  // 3) intento con ejemplo de FORMATO mínimo (no contenido)
  try {
    const exemplar = [
      ...messages,
      {
        role: "system",
        content:
          'Ejemplo VÁLIDO de formato mínimo:\n{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"Taxi","duration":"60m","notes":"Explora un rincón único de la ciudad"}]}',
      },
    ];
    const resp = await client.responses.create({
      model: "gpt-4o-mini",
      temperature: 0.1,
      input: exemplar.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
      max_output_tokens: 3200,
    });
    const text =
      resp?.output_text?.trim() ||
      resp?.output?.[0]?.content?.[0]?.text?.trim() ||
      "";
    if (text) return text;
  } catch (e) {
    console.warn("callStructured#3", e?.message || e);
  }

  return "";
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
