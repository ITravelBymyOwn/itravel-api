// /api/chat.js — v36 (ESM compatible en Vercel)
// Basado quirúrgicamente en v31.2, con mejoras puntuales solicitadas.
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
  // remove ```json ... ``` or ``` ... ```
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
// Normalización y post-procesos (quirúrgicos)
// ==============================

// Detección de destinos fuera de la ciudad (ampliada)
const OUT_OF_TOWN_RE = new RegExp(
  [
    // Círculo Dorado
    "thingvellir","þingvellir","gullfoss","geysir","golden\\s*circle","c[ií]rculo\\s*dorado",
    // Costa Sur
    "seljalandsfoss","sk[óo]gafoss","reynisfjara","v[ií]k","costa\\s*sur",
    // Reykjanes
    "reykjanes","puente\\s+entre\\s+continentes","bridge\\s+between\\s+continents","gunnuhver","brimketill","blue\\s*lagoon","laguna\\s*azul",
    // Snæfellsnes
    "sn[aá]efellsnes","kirkjufell","dj[uú]pal[oó]nssandur","parque\\s+sn[aá]efellsj[oö]kull","arnarstapi","hellnar",
    // genéricos
    "fiordo","glaciar","pen[íi]nsula","ice\\s*cave","cueva\\s+de\\s+hielo","volc[aá]n","whale\\s*watching"
  ].join("|"),
  "i"
);

// Marcadores por zona para formatear "Destino — Subparada"
const ZONES = [
  {
    zone: "Círculo Dorado",
    tokens: /(thingvellir|þingvellir|geysir|gullfoss)/i,
    submap: [
      { re: /thingvellir|þingvellir/i, label: "Þingvellir" },
      { re: /geysir/i, label: "Geysir" },
      { re: /gullfoss/i, label: "Gullfoss" },
    ],
  },
  {
    zone: "Costa Sur",
    tokens: /(seljalandsfoss|sk[óo]gafoss|reynisfjara|v[ií]k|costa\s*sur)/i,
    submap: [
      { re: /seljalandsfoss/i, label: "Seljalandsfoss" },
      { re: /sk[óo]gafoss/i, label: "Skógafoss" },
      { re: /reynisfjara/i, label: "Reynisfjara" },
      { re: /v[ií]k/i, label: "Vík" },
    ],
  },
  {
    zone: "Reykjanes",
    tokens: /(reykjanes|gunnuhver|brimketill|puente\s+entre\s+continentes|bridge\s+between\s+continents|laguna\s*azul|blue\s*lagoon)/i,
    submap: [
      { re: /puente\s+entre\s+continentes|bridge\s+between\s+continents/i, label: "Puente entre Continentes" },
      { re: /gunnuhver/i, label: "Gunnuhver" },
      { re: /brimketill/i, label: "Brimketill" },
      { re: /laguna\s*azul|blue\s*lagoon/i, label: "Laguna Azul" },
    ],
  },
  {
    zone: "Snæfellsnes",
    tokens: /(sn[aá]efellsnes|kirkjufell|dj[uú]pal[oó]nssandur|parque\s+sn[aá]efellsj[oö]kull|arnarstapi|hellnar)/i,
    submap: [
      { re: /kirkjufell/i, label: "Kirkjufell" },
      { re: /dj[uú]pal[oó]nssandur/i, label: "Djúpalónssandur" },
      { re: /parque\s+sn[aá]efellsj[oö]kull/i, label: "Parque Snæfellsjökull" },
      { re: /arnarstapi|hellnar/i, label: "Arnarstapi" },
    ],
  },
];

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

// --- Aurora helpers (regla dura) ---
function isAuroraCity(name = "") {
  // Lista mínima de ciudades/zonas de latitud alta conocidas (sin web)
  return /(reykjav[ií]k|reikiavik|troms[oø]|tromso|abisko|rovaniemi|iceland|islandia)/i.test(String(name||""));
}
function isAuroraMonth(dateStr = "") {
  // Acepta Sep–Mar aproximadamente
  // Si no hay fecha, permitimos por defecto (modelo ya propone).
  // El planner suele no pasar fechas por actividad; rely on destino/temporada textual.
  return true;
}

// Ventana preferida 21:30–02:30, pero fuerza >=18:00 como mínimo.
function normalizeAuroraWindow(row) {
  if (!AURORA_RE.test(row.activity || "")) return row;
  const MIN_VISIBLE = toMinutes("18:00");
  let s = toMinutes(row.start || "21:30");
  let e = toMinutes(row.end || "00:30");
  const PREF_START = toMinutes("21:30");
  const MAX_END = toMinutes("03:00");

  if (s < MIN_VISIBLE) s = PREF_START;
  if (e <= s) e = s + 120; // mínimo 2h
  if (e > MAX_END) e = MAX_END;

  return {
    ...row,
    start: toHHMM(s),
    end: toHHMM(e),
    transport: row.transport || "Vehículo alquilado o Tour guiado",
    duration: row.duration || "2h",
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
      /tour|veh[ií]culo|auto|car/i.test(last.transport || "")
        ? "Vehículo alquilado o Tour guiado"
        : (last.transport || "Vehículo alquilado o Tour guiado"),
    duration: "1h 15m",
    notes: "Vuelta a la ciudad base para cerrar el recorrido del día.",
  };
  return [...rowsOfDay, back];
}

// Intenta formatear "Destino — Subparada" si se detecta una zona/parada típica
function enforceSubstopFormat(activity = "") {
  const act = String(activity || "");
  for (const z of ZONES) {
    if (z.tokens.test(act)) {
      for (const s of z.submap) {
        if (s.re.test(act)) return `${z.zone} — ${s.label}`;
      }
      // Si sólo dice la zona sin subparada:
      return act.includes("—") ? act : `${z.zone} — Parada`;
    }
  }
  // También si el act contiene sólo el token de la subparada sin zona, añade zona:
  for (const z of ZONES) {
    for (const s of z.submap) {
      if (s.re.test(act) && !/—/.test(act)) {
        return `${z.zone} — ${s.label}`;
      }
    }
  }
  return act;
}

// Inyecta auroras no consecutivas y evita sólo el último día
function injectAuroraIfMissing(dest, rows) {
  if (!isAuroraCity(dest) || !isAuroraMonth()) return rows;

  const byDay = rows.reduce((acc, r) => {
    (acc[r.day] = acc[r.day] || []).push(r);
    return acc;
  }, {});
  const days = Object.keys(byDay).map(Number).sort((a, b) => a - b);
  if (!days.length) return rows;

  const hasAurora = rows.some(r => AURORA_RE.test(r.activity || ""));
  if (hasAurora) return rows;

  const totalDays = days.length;
  // Evita último día como único
  const candidate1 = days.find(d => d !== days[days.length - 1]) || days[0];
  const candidate2 =
    totalDays >= 4
      ? days.find(d => d !== candidate1 && d !== days[days.length - 1] && Math.abs(d - candidate1) > 1)
      : null;

  const makeAuroraRow = (day) => {
    // Colocar al final del día (>=21:30), ajustando buffers
    const endLast = toMinutes((byDay[day].slice(-1)[0]?.end) || "20:45");
    const startM = Math.max(endLast + 30, toMinutes("21:30"));
    const row = {
      day,
      start: toHHMM(startM),
      end: toHHMM(startM + 120),
      activity: "Caza de Auroras Boreales",
      from: dest,
      to: "Zona de caza",
      transport: "Vehículo alquilado o Tour guiado",
      duration: "2h",
      notes: "Salida nocturna sujeta a clima y actividad solar.",
    };
    return normalizeAuroraWindow(row);
  };

  let augmented = rows.slice();
  augmented.push(makeAuroraRow(candidate1));
  if (candidate2) augmented.push(makeAuroraRow(candidate2));

  augmented.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));
  return augmented;
}

/** Normaliza una respuesta del modelo:
 *  - Si viene en formato C (destinations[]), lo transforma a formato B
 *  - Garantiza rows con campos mínimos y day numérico
 *  - Ajusta auroras (regla dura)
 *  - Fuerza transporte dual en day trips
 *  - Inserta "Regreso a <Ciudad>"
 *  - Enforce "Destino — Subparada" en rutas icónicas
 *  - Suaviza sesgo "A pie" en urbano
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

  // Sanitizar filas
  let rows = parsed.rows
    .map((r, idx) => {
      const dayNum =
        Number.isFinite(+r.day) && +r.day > 0 ? +r.day : 1 + (idx % 5);
      const start = (r.start || "").toString().trim() || "09:00";
      const end = (r.end || "").toString().trim() || "10:00";
      const rawActivity = (r.activity || "").toString().trim() || "Actividad";
      let activity = enforceSubstopFormat(rawActivity);

      // Transporte
      let transport = ((r.transport || "").toString().trim());
      const isTrip = OUT_OF_TOWN_RE.test(`${activity} ${(r.to || "").toString()} ${(r.from||"").toString()}`);
      if (isTrip && (!transport || /a pie|bus|tren/i.test(transport))) {
        transport = "Vehículo alquilado o Tour guiado";
      }
      // En urbano: si dejó vacío o abuso de "A pie", pruebo Taxi
      if (!isTrip && (!transport || /^a pie$/i.test(transport))) {
        transport = "Taxi";
      }

      return {
        day: dayNum,
        start,
        end,
        activity,
        from: (r.from || "").toString(),
        to: (r.to || "").toString(),
        transport: transport || "Taxi",
        duration: (r.duration || "").toString(),
        notes: (r.notes || "").toString() || "Una parada ideal para disfrutar.",
      };
    })
    .slice(0, 120);

  // Ajustes de auroras (ventanas plausibles y >=18:00)
  rows = rows.map(normalizeAuroraWindow);

  // Agrupar y asegurar "Regreso"
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

  // Inyectar auroras si corresponden y no existen
  const withAuroras = injectAuroraIfMissing(dest, merged);

  // Orden final
  withAuroras.sort((a, b) => (a.day - b.day) || (toMinutes(a.start) - toMinutes(b.start)));

  parsed.rows = withAuroras;
  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (quirúrgico)
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser **EXCLUSIVAMENTE un JSON válido** con uno de estos formatos:

B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

⚠️ REGLAS GENERALES
- Devuelve SIEMPRE al menos una actividad en "rows". Nada de texto fuera del JSON.
- 20 actividades máximo por día.
- Usa horas **realistas y flexibles**: no asumas ventana fija (no fuerces 08:30–19:00). Si tiene sentido, extiende noche (cenas, shows, **auroras**).
- **No priorices "A pie"** (sin prohibirlo). Elige el medio óptimo (Taxi/Bus/Auto/Tour) para maximizar experiencia y eficiencia (clima, distancia, luz). Si hay day trip y el usuario no indicó transporte, usa **"Vehículo alquilado o Tour guiado"**.
- La respuesta debe poder renderizarse en una UI web. No dejes campos vacíos ni devuelvas "seed".

🧭 ESTRUCTURA OBLIGATORIA DE CADA ACTIVIDAD
{
  "day": 1,
  "start": "08:30",
  "end": "10:30",
  "activity": "Nombre claro y específico",
  "from": "Lugar de partida",
  "to": "Lugar de destino",
  "transport": "Transporte realista (Taxi, Bus, Auto, Tour guiado, etc.)",
  "duration": "2h",
  "notes": "Descripción breve y motivadora"
}

🌌 AURORAS (reglas duras)
- Propón **2–3 noches NO consecutivas** en estancias de 4–5+ días, **evitando** que la única noche sea el **último día**.
- **Horarios plausibles**: inicia entre **21:30–22:30** y termina entre **00:00–02:30** (local). Nunca antes de **18:00** ni después de **03:00**.
- Sólo cuando el destino/latitud/temporada lo hacen plausible (ej. Islandia en invierno).

🚆 TRANSPORTE Y TIEMPOS
- Horas ordenadas, **sin solaparse** y con buffers razonables.
- Si la actividad es fuera de la ciudad (day trip) y el usuario no indicó transporte: **"Vehículo alquilado o Tour guiado"**.
- En urbano, favorece Taxi/Bus en saltos largos o clima frío.

🧭 RUTAS ICÓNICAS DESDE REYKJAVIK (guía, sin predefinir resultados)
- Con **estancias de ≤5 días**, planifica day trips dentro de **≤ 2h30 por trayecto** para maximizar tiempo:
  • **Círculo Dorado**: Þingvellir → Geysir → Gullfoss.
  • **Costa Sur**: Seljalandsfoss → Skógafoss → Reynisfjara → (opcional) Vík si el tiempo lo permite.
  • **Reykjanes**: Puente entre Continentes → Gunnuhver → Brimketill → Laguna Azul.
  • **Snæfellsnes** (≈2h30): si se incluye, planifica paradas típicas (Kirkjufell, Djúpalónssandur, Parque Snæfellsjökull, Arnarstapi).
- **No mezcles zonas** (Reykjanes/Costa Sur/Snæfellsnes) en el mismo día. Cada península/zona es un día completo.

🧭 TOURS / DAY TRIPS — DESGLOSE
- Cuando sea un recorrido típico, **divide en paradas clave** en filas separadas usando **"Destino — Subparada"** en **activity**:
  • "Círculo Dorado — Þingvellir", "Círculo Dorado — Geysir", "Círculo Dorado — Gullfoss".
  • "Costa Sur — Seljalandsfoss", "Costa Sur — Skógafoss", "Costa Sur — Reynisfjara", "(opcional) Costa Sur — Vík".
  • "Reykjanes — Puente entre Continentes", "Reykjanes — Gunnuhver", "Reykjanes — Brimketill", "Reykjanes — Laguna Azul".
  • "Snæfellsnes — Kirkjufell", "Snæfellsnes — Djúpalónssandur", "Snæfellsnes — Parque Snæfellsjökull", "Snæfellsnes — Arnarstapi".
- **Obligatorio**: si el día salió de la ciudad base, agrega una fila final clara de **"Regreso a <Ciudad base>"**.

💰 MONETIZACIÓN FUTURA (sin marcas)
- Sugiere actividades naturalmente vinculables a upsells (cafés, museos, experiencias locales) sin precios.

📝 EDICIÓN INTELIGENTE
- Si el usuario pide cambios (agregar/quitar/ajustar), responde con el JSON actualizado.
- Mantén secuencia clara y cronológica.

🎨 UX Y NARRATIVA
- Cada día debe fluir como una historia (inicio, desarrollo, cierre).
- Notas cortas y variadas; evita repeticiones.

🚫 ERRORES A EVITAR
- Nada fuera del JSON.
- No uses frases impersonales tipo “Esta actividad es…”.
- No repitas notas idénticas.
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
