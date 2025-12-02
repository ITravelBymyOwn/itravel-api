// /api/chat.js — v31.5 (ESM compatible en Vercel)
// Base: v31.4 con ajustes quirúrgicos: transporte inteligente, 2ª noche de auroras (si aplica),
// y regla de distancia por trayecto en el prompt (≤2h / ≤5 días; ≤3h / >5 días).
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
const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|kirkjufell|djúpalónssandur|puente\s+entre\s+continentes|parque\s+sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching)\b/i;

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
  const anyTrip = rowsOfDay.some(r => OUT_OF_TOWN_RE.test(`${r.activity||""} ${r.to||""}`));
  if (!anyTrip) return rowsOfDay;

  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    new RegExp(destination, "i").test(last.to || "");
  if (alreadyBack) return rowsOfDay;

  // crear regreso con buffer 30m
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
    transport:
      /tour|veh[ií]culo|auto/i.test(last.transport || "")
        ? "Vehículo alquilado o Tour guiado"
        : (last.transport || "Vehículo alquilado o Tour guiado"),
    duration: "1h 15m",
    notes: "Vuelta a la ciudad base para cerrar el recorrido del día.",
  };
  return [...rowsOfDay, back];
}

// Detección simple de ciudades aptas para auroras
function isAuroraCity(name = "") {
  const n = String(name || "").toLowerCase();
  return /(reykjav[ií]k|reikiavik|reykiavik|troms[oø]|tromso|abisko|rovaniemi)/i.test(n);
}

// Inyecta auroras si el itinerario plausible no las incluyó
function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraCity(dest)) return rows;

  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!days.length) return rows;

  const totalDays = days.length;
  const hasAurora = rows.some(r => AURORA_RE.test(r.activity || ""));
  if (hasAurora) return rows;

  // elegir días no consecutivos y evitando el último
  const candidate1 = days.find(d => d !== days[days.length - 1]) || days[0];
  const candidate2 =
    totalDays >= 4
      ? days.find(d => d !== candidate1 && d !== days[days.length - 1])
      : null;

  const makeAuroraRow = (day) => {
    // colocar al final del día, 21:30–23:30
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:45");
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
      notes: "Salida nocturna para intentar ver el cielo iluminado por auroras (horario orientativo).",
    });
  };

  let augmented = rows.slice();
  augmented.push(makeAuroraRow(candidate1));
  if (candidate2 && Math.abs(candidate2 - candidate1) > 1) {
    augmented.push(makeAuroraRow(candidate2));
  }

  // reordenar por día/hora tras insertar
  augmented.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));
  return augmented;
}

// ---- NUEVO: transporte inteligente para no priorizar "A pie" fuera de centro urbano
function smartTransport(city, row) {
  const context = `${city} ${row.from || ""} ${row.to || ""}`.toLowerCase();
  const isNordic = /(reykjav|islandia|iceland|troms|noruega|norway|rovaniemi|finland)/i.test(context);
  const text = `${row.activity || ""} ${row.to || ""}`;
  const isTrip = OUT_OF_TOWN_RE.test(text);
  let transport = (row.transport || "").trim();

  if (isTrip || isNordic) {
    if (!transport || /a pie/i.test(transport) || /bus|tren/i.test(transport)) {
      transport = "Vehículo alquilado o Tour guiado";
    }
    // Homogeneizar si viene "tour" suelto
    if (/tour/i.test(transport) && !/veh[ií]culo|auto/i.test(transport)) {
      transport = "Vehículo alquilado o Tour guiado";
    }
  }
  return { ...row, transport: transport || "Vehículo alquilado o Tour guiado" };
}

// Inyecta una 2ª noche de auroras si hay 4+ días y sólo 1 noche existente (no consecutiva)
function injectSecondAuroraIfSparse(dest, rows) {
  if (!isAuroraCity(dest)) return rows;

  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (days.length < 4) return rows;

  const auroraDays = days.filter(d => (byDay[d] || []).some(r => AURORA_RE.test(r.activity || "")));
  if (auroraDays.length !== 1) return rows;

  const first = auroraDays[0];
  const candidate = days.find(d => Math.abs(d - first) > 1) || (first > 2 ? first - 2 : first + 2);
  const lastRow = (byDay[candidate] || []).slice(-1)[0] || { end: "20:45" };
  const start = toHHMM(Math.max(toMinutes(lastRow.end || "20:45") + 30, toMinutes("21:30")));
  const end = toHHMM(Math.min(toMinutes(start) + 120, toMinutes("02:30")));
  const line = normalizeAuroraWindow({
    day: candidate,
    start,
    end,
    activity: "Caza de Auroras Boreales",
    from: dest,
    to: "Zona de caza",
    transport: "Vehículo alquilado o Tour guiado",
    duration: "2h",
    notes: "Noche adicional de auroras (no consecutiva). Sujeto a clima.",
  });

  const out = rows.concat(line);
  out.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));
  return out;
}

/** Normaliza una respuesta del modelo:
 *  - Si viene en formato C (destinations[]), lo transforma a formato B
 *  - Garantiza rows con campos mínimos y day numérico
 *  - Post-procesa auroras y línea de regreso
 *  - Fuerza transporte dual en day trips cuando el modelo lo omite
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
      let transport = ((r.transport || "").toString().trim());

      // Fuerza transporte dual en salidas fuera de ciudad si está vacío o genérico
      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()}`);
      if (isTrip && (!transport || /a pie|bus|tren/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      }

      return {
        day: dayNum,
        start,
        end,
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport: transport || "A pie",
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };
    })
    .slice(0, 120); // safety

  // Ajustes de auroras (ventanas plausibles)
  rows = rows.map(normalizeAuroraWindow);

  // Transporte inteligente global (evitar "A pie" fuera de centro urbano nórdico)
  const dest = parsed.destination || "Ciudad";
  rows = rows.map(r => smartTransport(dest, r));

  // Insertar "Regreso a <ciudad>" al final de días con day-trip si falta
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

  // Inyectar auroras si corresponde y no existen
  let withAuroras = injectAuroraIfMissing(dest, merged);
  // Si sólo hay 1 noche y 4+ días, inyectar una 2ª no consecutiva
  withAuroras = injectSecondAuroraIfSparse(dest, withAuroras);

  // Reordenar final por día/hora
  withAuroras.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));

  parsed.rows = withAuroras;
  return parsed;
}

// ==============================
// Prompt base mejorado ✨
// (horarios flex, cena NO obligatoria, auroras inteligentes,
// transporte dual en day trips, desglose de tours por paradas,
// obligación de agregar la fila de regreso y regla de distancia)
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
  "transport": "Transporte realista (A pie, Metro, Taxi, Bus, Auto, Ferry, Tour guiado)",
  "duration": "2h",
  "notes": "Descripción motivadora y breve"
}

🌌 AURORAS (si aplica por destino/temporada)
- Proponlas cuando sea plausible y evita noches consecutivas.
- Evita que la **única** noche sea el **último día**.
- En estancias de 4–5+ días, es razonable 2–3 noches **no consecutivas**.
- **Horarios plausibles**: inicia entre **21:30–22:30** y termina entre **00:00–02:30** (local). No antes de 21:00 ni después de 03:00.

🚗 ALCANCE DE RUTAS (tiempo máx. por trayecto)
- Si la estancia total es **≤ 5 días**: considera recorridos **hasta ~2 h por trayecto**.
- Si la estancia total es **> 5 días**: considera **hasta ~3 h por trayecto**.
- Objetivo: **no dejar por fuera** lo más espectacular dentro de ese radio.

🚆 TRANSPORTE Y TIEMPOS
- Horas ordenadas, **sin solaparse** y con buffers razonables.
- Si el usuario no indicó transporte y la actividad es fuera de la ciudad (day trip),
  usa **"Vehículo alquilado o Tour guiado"** (evita bus/tren si no es viable).
- En destinos nórdicos evita priorizar “A pie” fuera de zonas urbanas.

🧭 TOURS / DAY TRIPS — DESGLOSE, SUB-PARADAS Y REGRESO
- Cuando sea un recorrido típico, **divide en paradas/waypoints clave** como filas separadas,
  usando **“Destino — Subparada”** en **activity**.
  Ejemplos (Reykjavik):
  • **Círculo Dorado** — Thingvellir → Geysir → Gullfoss (y regreso).
  • **Costa Sur** — Seljalandsfoss → Skógafoss → Reynisfjara → Vík (y regreso).
  • **Snæfellsnes** — Kirkjufell → Djúpalónssandur → Parque Snæfellsjökull → Arnarstapi (y regreso).
  • **Reykjanes** — Laguna Azul → Puente entre continentes → Gunnuhver → Costa de Reykjanes (y regreso).
- **No mezcles** rutas icónicas incompatibles el mismo día (p.ej., Laguna Azul con Reynisfjara).
- **Obligatorio**: si el día salió fuera de la ciudad base, agrega una fila final clara de **"Regreso a <Ciudad base>"** con hora realista.

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
