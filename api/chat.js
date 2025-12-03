// /api/chat.js — v36.7 (ESM compatible en Vercel) — ajustes quirúrgicos anti-fallback + lógica reforzada
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
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function tryExtractJSONObject(s = "") {
  const txt = String(s || "");
  const start = txt.indexOf("{");
  const end = txt.lastIndexOf("}");
  if (start >= 0 && end > start) return txt.slice(start, end + 1);
  return null;
}

function tryRepairJsonMinor(raw = "") {
  // Reparaciones mínimas sin riesgo: comillas uniformes y remoción de trailing commas simples
  let t = String(raw || "");
  // Quita backticks sobrantes y marca de codefence
  t = stripCodeFences(t);
  // Elimina comas simples antes de ] o } más comunes
  t = t.replace(/,\s*([\]}])/g, "$1");
  return t;
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
    // Reparación menor y reintento
    try {
      const repaired = tryRepairJsonMinor(c);
      const j2 = JSON.parse(repaired);
      if (j2 && typeof j2 === "object") return j2;
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
    replace: false,
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// ==============================
// Normalización y post-procesos
// ==============================

const OUT_OF_TOWN_RE =
  /\b(thingvellir|þingvellir|gullfoss|geysir|golden\s*circle|círculo\s*dorado|seljalandsfoss|skógafoss|skogafoss|reynisfjara|v[ií]k|sn[aá]efellsnes|kirkjufell|djúpalónssandur|puente\s+entre\s+continentes|sn[aá]efellsj[oö]kull|blue\s*lagoon|laguna\s*azul|reykjanes|costa\s*sur|pen[ií]nsula|fiordo|glaciar|volc[aá]n|cueva\s+de\s+hielo|ice\s*cave|whale\s*watching)\b/i;

const AURORA_RE = /\b(auroras?|northern\s*lights?)\b/i;

const AURORA_CITY_RE =
  /(reykjav[ií]k|reikiavik|reykiavik|akureyri|troms[oø]|tromso|alta|bod[oø]|narvik|lofoten|abisko|kiruna|rovaniemi|yellowknife|fairbanks|murmansk|iceland|islandia|lapland|laponia)/i;

function pad(n) { return n.toString().padStart(2, "0"); }
function toMinutes(hhmm = "00:00") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function toHHMM(mins = 0) {
  const mm = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60); // wrap seguro
  const h = Math.floor(mm / 60);
  const m = mm % 60;
  return `${pad(h)}:${pad(m)}`;
}

// Clave de orden por minuto que tolera actividades nocturnas/cruce de medianoche
function sortKeyMinutes(row) {
  const s = toMinutes(row.start || "00:00");
  const e = toMinutes(row.end || row.start || "00:00");
  let key = s;

  // Si end < start y es claramente nocturna (ej. auroras), empujar al final (+24h)
  if (AURORA_RE.test(row.activity || "") && e <= s) key = s + 1440;

  // "Regreso a hotel" de madrugada: después
  if (/regreso\s+a\s+hotel/i.test(row.activity || "") && s < 240) key = s + 1440;

  return key;
}

// Normaliza ventana de auroras (≥18:00; ideal 21:30–00:30; mínimo 2h, preferible 4h)
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  const MIN_EVENING = toMinutes("18:00");
  const PREF_START = toMinutes("21:30");
  const PREF_END = toMinutes("00:30");
  const MAX_END = toMinutes("01:30");

  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");

  if (s < MIN_EVENING) s = PREF_START;
  if (e <= s) e = s + 120; // mínimo 2h
  // preferir 21:30–00:30 pero permitir hasta 01:30
  if (e > MAX_END) e = Math.min(PREF_END, MAX_END);

  // transporte por defecto coherente
  const transport = row.transport || "Vehículo alquilado o Tour guiado";

  // duración textual si falta
  const durMin = Math.max(120, e - s);
  const durTxt = durMin >= 60 ? `${Math.floor(durMin/60)}h${(durMin%60? " "+(durMin%60)+"m" : "")}` : `${durMin}m`;

  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e),
    transport,
    duration: row.duration || durTxt,
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
  const alreadyBack =
    /regreso\s+a/i.test(last.activity || "") ||
    new RegExp(destination, "i").test(last.to || "");
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
    transport: "Vehículo alquilado o Tour guiado",
    duration: "1h 10m",
    notes: "Retorno a la ciudad base para cerrar el día.",
  };
  return [...rowsOfDay, back];
}

// Regreso a hotel tras auroras si no existe
function ensureHotelReturnAfterAurora(rowsOfDay) {
  if (!Array.isArray(rowsOfDay) || !rowsOfDay.length) return rowsOfDay;
  const last = rowsOfDay[rowsOfDay.length - 1] || {};
  if (!AURORA_RE.test(last.activity || "")) return rowsOfDay;

  const alreadyBack = /regreso\s+a\s+(hotel|alojamiento)/i.test(last.activity || "");
  if (alreadyBack) return rowsOfDay;

  const endMins = toMinutes(last.end || "00:30");
  const start = toHHMM(endMins + 5);
  const end = toHHMM(endMins + 45);

  const back = {
    day: last.day,
    start,
    end,
    activity: "Regreso a hotel",
    from: last.to || "Zona de observación",
    to: "Hotel",
    transport: "Tour guiado",
    duration: "0.75h",
    notes: "Finaliza la noche con un retorno cómodo al alojamiento.",
  };
  return [...rowsOfDay, back];
}

function isAuroraEligibleCity(name = "") {
  return AURORA_CITY_RE.test(String(name || ""));
}

// Inyecta 1–2 noches de auroras si falta, evitando la última noche y noches consecutivas
function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraEligibleCity(dest)) return rows;

  // ya hay auroras?
  const hasAurora = rows.some(r => AURORA_RE.test(r.activity || ""));
  if (hasAurora) return rows;

  // Agrupar por día
  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!days.length) return rows;

  const last = days[days.length - 1];
  // elegir d1 que no sea el último
  const d1 = days.find(d => d !== last) || days[0];
  // si hay al menos 4 días, elegir d2 no contiguo a d1 ni al último
  const d2 = days.length >= 4
    ? days.find(d => d !== d1 && d !== last && Math.abs(d - d1) > 1)
    : null;

  const makeAuroraRow = (day) => {
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:30");
    const s = Math.max(endLast + 30, toMinutes("21:30"));
    const e = s + 240; // preferencia 4h
    return normalizeAuroraWindow({
      day,
      start: toHHMM(s),
      end: toHHMM(e),
      activity: "Caza de Auroras Boreales",
      from: dest,
      to: "Zona de observación",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "4h",
      notes: "Salida nocturna para intentar ver auroras (horario orientativo).",
    });
  };

  const augmented = rows.slice();
  augmented.push(makeAuroraRow(d1));
  if (d2) augmented.push(makeAuroraRow(d2));

  augmented.sort((a, b) => (a.day - b.day) || (sortKeyMinutes(a) - sortKeyMinutes(b)));
  return augmented;
}

// Relaja la mañana posterior a una noche de auroras
function relaxNextMorningIfAurora(byDay) {
  const dayNums = Object.keys(byDay).map(Number).sort((a,b)=>a-b);
  const auroraDays = new Set(
    dayNums.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")))
  );
  const MIN_START = toMinutes("10:30");

  for (const d of dayNums) {
    if (!auroraDays.has(d - 1)) continue;
    const rows = byDay[d];
    if (!rows || !rows.length) continue;

    let firstStart = Math.min(...rows.map(r => toMinutes(r.start || "23:59")));
    if (firstStart >= MIN_START) continue;
    const shift = MIN_START - firstStart;

    for (const r of rows) {
      const s = toMinutes(r.start || "00:00") + shift;
      const e = toMinutes(r.end || r.start || "00:00") + shift;
      r.start = toHHMM(s);
      r.end = toHHMM(e);
    }
  }
}

// Tope global de auroras 1–2 noches, nunca consecutivas, y evita que la única sea el último día
function enforceAuroraCapGlobal(rows) {
  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(n=>+n).sort((a,b)=>a-b);
  const stay = days.length;
  const cap = stay >= 5 ? 2 : (stay >= 3 ? 1 : 1);

  // Lista de días con aurora
  let auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));

  // Evitar consecutivas: si hay consecutivas, elimina la 2ª
  auroraDays.sort((a,b)=>a-b);
  for (let i=1; i<auroraDays.length; i++){
    if (auroraDays[i] === auroraDays[i-1] + 1) {
      // eliminar auroras del día actual
      byDay[auroraDays[i]] = (byDay[auroraDays[i]]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
    }
  }

  // Recalcular después de filtrar consecutivas
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));

  // Evitar que la única aurora sea el último día
  if (auroraDays.length === 1 && auroraDays[0] === days[days.length-1]) {
    // quita la aurora del último día
    const last = days[days.length-1];
    byDay[last] = (byDay[last]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
  }

  // Aplicar tope global
  auroraDays = days.filter(d => (byDay[d]||[]).some(r => AURORA_RE.test(r.activity||"")));
  if (auroraDays.length > cap) {
    // Mantener las primeras según carga más ligera (simple: por índice)
    const keep = auroraDays.slice(0, cap);
    for (const d of auroraDays) {
      if (!keep.includes(d)) {
        byDay[d] = (byDay[d]||[]).filter(r=>!AURORA_RE.test(r.activity||""));
      }
    }
  }

  // Reconstruir plano
  const merged = [];
  days.forEach(d=>{
    (byDay[d]||[]).forEach(r=>merged.push(r));
  });
  return merged;
}

/** Normaliza la respuesta del modelo */
function normalizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Aceptar formato C y convertir a B si aplica
  if (!parsed.rows && Array.isArray(parsed.destinations)) {
    const first = parsed.destinations.find(
      (d) => Array.isArray(d.rows) && d.rows.length > 0
    );
    if (first) {
      parsed = {
        destination: first.name || first.city || first.destination || "Destino",
        rows: first.rows,
        followup: parsed.followup || "",
        replace: parsed.replace ?? false,
      };
    }
  }

  if (!Array.isArray(parsed.rows)) return null;

  // Asegurar replace:false si falta
  if (typeof parsed.replace === "undefined") parsed.replace = false;

  // Normalización de filas
  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum = Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 7);
      const start = (r.start || "").toString().trim() || "09:00";
      const endRaw = (r.end || "").toString().trim() || "";
      const activity = (r.activity || "").toString().trim() || "Actividad";
      let transport = ((r.transport || "").toString().trim());

      // Day trips: si no hay transporte o puso “A pie”, forzamos la dupla
      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()}`);
      if (isTrip && (!transport || /a pie/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      } else if (!isTrip && !transport) {
        transport = "Taxi";
      }

      const base = {
        day: dayNum,
        start,
        end: endRaw || "", // lo corregimos luego
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport,
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };

      // Si end está vacío o anterior a start, generar duración razonable (60–120m)
      const s = toMinutes(base.start);
      const e = endRaw ? toMinutes(endRaw) : null;
      if (e === null || e <= s) {
        const dur = AURORA_RE.test(activity) ? 240 : 90;
        base.end = toHHMM(s + dur);
        if (!base.duration) {
          base.duration = dur >= 60 ? `${Math.floor(dur/60)}h${dur%60? " "+(dur%60)+"m":""}` : `${dur}m`;
        }
      }

      return base;
    })
    .slice(0, 180);

  // Ajuste auroras (ventana y duración)
  rows = rows.map(normalizeAuroraWindow);

  const dest = parsed.destination || "Ciudad";

  // Agrupar por día para aplicar líneas de regreso y orden estable
  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});

  // Orden + regreso ciudad/hotel
  const mergedOrdered = [];
  Object.keys(byDay)
    .map((d) => +d)
    .sort((a, b) => a - b)
    .forEach((d) => {
      byDay[d].sort((a,b) => sortKeyMinutes(a) - sortKeyMinutes(b));
      let fixed = ensureReturnLine(dest, byDay[d]);
      fixed = ensureHotelReturnAfterAurora(fixed);
      // Reordenar después de insertar la línea de regreso
      fixed.sort((a,b) => sortKeyMinutes(a) - sortKeyMinutes(b));
      byDay[d] = fixed;
      mergedOrdered.push(...fixed);
    });

  // Relajar mañana tras aurora
  const byDay2 = mergedOrdered.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  relaxNextMorningIfAurora(byDay2);

  // Reconstruir nuevamente tras la relajación
  const afterRelax = [];
  Object.keys(byDay2).map(Number).sort((a,b)=>a-b).forEach(d=>{
    byDay2[d].sort((a,b)=>sortKeyMinutes(a)-sortKeyMinutes(b));
    afterRelax.push(...byDay2[d]);
  });

  // Inyección de auroras si aplica (y cap global no consecutivo)
  let withAuroras = injectAuroraIfMissing(dest, afterRelax);
  withAuroras = enforceAuroraCapGlobal(withAuroras);

  withAuroras.sort((a, b) => (a.day - b.day) || (sortKeyMinutes(a) - sortKeyMinutes(b)));

  parsed.rows = withAuroras;
  if (typeof parsed.followup !== "string") parsed.followup = "";
  return parsed;
}

// ==============================
// Prompt base (reglas del agente)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con un itinerario inspirador y funcional.

📌 FORMATOS VÁLIDOS
B) {"destination":"City","rows":[{...}],"followup":"texto breve","replace":false}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos 1 actividad en "rows".
- Nada de texto fuera del JSON (sin explicaciones).
- Máximo 20 actividades por día.
- Horarios **flexibles y realistas**; permite extender la noche cuando aporte valor (cenas, shows, auroras) y tolera cruce de medianoche.
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
- Identifica **recorridos icónicos** (day-trips: penínsulas, cascadas, volcanes, rutas escénicas).
- Si la estancia es **≤ 5 días**, prioriza lo mejor dentro de **~2h–2h30 por trayecto**; si es **> 5 días**, permite **~3h**.
- Desglosa **sub-paradas** con el formato **"Destino — Subparada"** (p.ej., "Costa Sur — Seljalandsfoss", "Círculo Dorado — Geysir").
- **No priorices "A pie" por inercia**: elige el medio que maximiza experiencia (clima, distancia, confort).
- Si existe **transporte público eficiente** para un day trip, puedes usarlo; si no, usa **"Vehículo alquilado o Tour guiado"**.

🌌 AURORAS — **REGLA DURA**
- Sugiere auroras sólo si latitud ≥ ~55°N y fecha en temporada (fin de ago–mediados de abr).
- Horarios **≥ 18:00**, ideal **21:30–00:30** (no más tarde de ~01:30).
- Evita noches consecutivas y que la única sea el último día.
- Tras una noche de auroras, **día siguiente inicia ≥10:30** con plan urbano/cercano.

🚆 TRANSPORTE Y TIEMPOS
- Orden sin solapes y con buffers razonables.
- En day trips sin preferencia explícita del usuario, usa **"Vehículo alquilado o Tour guiado"** salvo que el transporte público sea **claramente** eficiente.
- Incluye tiempos aproximados de actividad y traslados.

🔁 REGRESO
- Si hubo salida fuera de la ciudad base, agrega **"Regreso a <Ciudad base>"** al final.
- En noches de auroras, finaliza con **"Regreso a hotel"**.

📝 EDICIÓN
- Si el usuario pide agregar/quitar/ajustar, responde con el **JSON actualizado**.

🎨 ESTILO
- Cada día fluye como una historia; notas cortas y motivadoras.
`.trim();

// ==============================
// Llamada al modelo (triple intento con refuerzo)
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

    if (mode === "info") {
      const raw = await callStructured(clientMessages);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // ---- Intento 1
    let raw = await callStructured(
      [{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages],
      0.4
    );
    let parsed = normalizeParsed(cleanToJSON(raw));

    // ---- Intento 2 (refuerzo: obligatorio al menos 1 fila)
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

    // ---- Intento 3 (plantilla mínima válida)
    const stillNoRows = !parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0;
    if (stillNoRows) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `
Ejemplo VÁLIDO de formato mínimo:
{"destination":"CITY","rows":[{"day":1,"start":"09:00","end":"10:00","activity":"Actividad","from":"","to":"","transport":"Taxi","duration":"60m","notes":"Explora un rincón único de la ciudad"}],"replace":false}`;
      raw = await callStructured(
        [{ role: "system", content: ultraPrompt }, ...clientMessages],
        0.1
      );
      parsed = normalizeParsed(cleanToJSON(raw));
    }

    if (!parsed) parsed = fallbackJSON();
    // Salida final (string JSON)
    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
