// /api/chat.js — v43 (ESM, Vercel) // Doble etapa: (1) INFO (investiga y calcula) → (2) PLANNER (estructura). // Respuestas SIEMPRE como { text: "<JSON|texto>" }. // ⚠️ Sin lógica del Info Chat EXTERNO (vive en /api/info-public.js).
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ============== Utilidades comunes ============== */
function parseBody(reqBody) {
  if (!reqBody) return {};
  if (typeof reqBody === "string") {
    try {
      return JSON.parse(reqBody);
    } catch {
      return {};
    }
  }
  return reqBody;
}

function extractMessages(body = {}) {
  const { messages, input, history } = body;
  if (Array.isArray(messages) && messages.length) return messages;
  const prev = Array.isArray(history) ? history : [];
  const userText = typeof input === "string" ? input : "";
  return [...prev, { role: "user", content: userText }];
}

// Limpia y extrae un único JSON de un texto (tolerante a prólogos/epílogos)
function cleanToJSONPlus(raw = "") {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  // 1) Intento directo
  try {
    return JSON.parse(raw);
  } catch {}
  // 2) Primer/último corchete
  try {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(raw.slice(first, last + 1));
    }
  } catch {}
  // 3) Recorte de ruido en extremos
  try {
    const cleaned = raw.replace(/^[^{]+/, "").replace(/[^}]+$/, "");
    return JSON.parse(cleaned);
  } catch {}
  return null;
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
        notes: "Explora libremente la ciudad.",
      },
    ],
    followup: "⚠️ Fallback local: revisa OPENAI_API_KEY o ancho de banda.",
  };
}

// Llamada unificada a Responses API (entrada como string consolidado)
async function callText(messages, temperature = 0.35, max_output_tokens = 3200) {
  const inputStr = messages
    .map(m => ${m.role.toUpperCase()}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)})
    .join("\n\n");
  const resp = await client.responses.create({
    model: "gpt-4o-mini",
    temperature,
    max_output_tokens,
    input: inputStr,
  });
  return (
    resp?.output_text?.trim() ||
    resp?.output?.[0]?.content?.[0]?.text?.trim() ||
    ""
  );
}

// Normalizador de duraciones dentro del JSON ya parseado
function normalizeDurationsInParsed(parsed){
  if(!parsed) return parsed;
  const norm = (txt)=>{
    const s = String(txt ?? "").trim();
    if(!s) return s;
    // Acepta formatos: "1.5h", "1h30", "1 h 30", "90m", "~7h", "2h"
    // No tocamos si empieza con "~"
    if (/^~\s*\d+(\.\d+)?\s*h$/i.test(s)) return s;
    // 1.5h → 1h30m
    const dh = s.match(/^(\d+(?:\.\d+)?)\s*h$/i);
    if(dh){
      const hours = parseFloat(dh[1]);
      const total = Math.round(hours*60);
      const h = Math.floor(total/60);
      const m = total%60;
      return h>0 ? (m>0 ? ${h}h${m}m : ${h}h) : ${m}m;
    }
    // 1h30 ó 1 h 30 → 1h30m
    const hMix = s.match(/^(\d+)\s*h\s*(\d{1,2})$/i);
    if(hMix){
      return ${hMix[1]}h${hMix[2]}m;
    }
    // 90m → 90m (ya está bien)
    if (/^\d+\s*m$/i.test(s)) return s;
    // 2h → 2h (ya está bien)
    if (/^\d+\s*h$/i.test(s)) return s;
    return s;
  };
  const touchRows = (rows=[]) => rows.map(r=>({
    ...r,
    duration: norm(r.duration)
  }));
  try{
    if(Array.isArray(parsed.rows)) parsed.rows = touchRows(parsed.rows);
    if(Array.isArray(parsed.destinations)){
      parsed.destinations = parsed.destinations.map(d=>({
        ...d,
        rows: Array.isArray(d.rows) ? touchRows(d.rows) : d.rows
      }));
    }
    if(Array.isArray(parsed.itineraries)){
      parsed.itineraries = parsed.itineraries.map(it=>({
        ...it,
        rows: Array.isArray(it.rows) ? touchRows(it.rows) : it.rows
      }));
    }
  }catch{}
  return parsed;
}

/* ============== Prompts del sistema ============== */

/* =======================
   SISTEMA — INFO CHAT (interno)
   Rol: Motor de investigación y decisión.
   Objetivo: Entregar research_json COMPLETO y AUTO-CONSISTENTE para que el Planner solo estructure.
   ======================= */
const SYSTEM_INFO = `
Eres el **motor de investigación** de ITravelByMyOwn (Info Chat interno) y un **experto internacional en turismo**.
Tu salida será consumida por un Planner que SOLO acomoda lo que tú decides. Por eso debes:
- **Resolver todas las decisiones**: qué ver, en qué orden, ventanas horarias realistas, duración, transporte, tiempos de traslado, reservas/tickets y dependencias.
- Entregar un **JSON ÚNICO y VÁLIDO** (sin prólogos/epílogos de texto) con la **estructura exacta** descrita más abajo.
- **Respetar** con prioridad máxima las preferencias, condiciones y horas mandatorias del usuario.

========================
ENTRADA (context):
- city, country
- dates: fecha_inicio, fecha_fin; days_total
- hotel_base (dirección o nombre), coordenadas si están disponibles
- grupo: edades, movilidad, restricciones (silla/coche, evitar cuestas, etc.), ritmo (lento/normal/rápido), sensibilidad a multitudes, presupuesto
- PREFERENCIAS Y CONDICIONES del usuario (máxima prioridad): intereses, “must”, “no-go”, tiempos fijos, ventanas por día (user_day_hours)
- transporte disponible/preferido: (a pie, metro, bus, tren, taxi, ride-hailing, **vehículo alquilado o tour guiado**); licencia y tolerancia a manejos largos
- ciudades previa/siguiente (si aplica) para entender horas de llegada/salida, check-in/out
- notas del usuario (motivos, festivales, alergias, claustrofobia, vértigo, etc.)
- reglas globales (por ejemplo: max_substops_per_tour=8, evitar duplicados, optimizar por distancia y tiempo)
- user_day_hours opcional: mapa por día con horas **mandatorias** { "1":{"start":"HH:MM","end":"HH:MM"}, ... } (24h, horario local)

========================
CRITERIOS Y POLÍTICAS (globales):
1) **Coherencia temporal realista** por temporada: usa horas de luz (amanecer/atardecer), meteorología probable, tiempos de acceso, y cierres semanales/locales. Evita horarios imposibles.
2) **Llegadas/Salidas**: el día de llegada/salida suele ser más corto. Ajusta las cargas; privilegia actividades suaves cerca del hotel.
3) **Agrupación por zonas**: minimiza traslados/backtracking. Prioriza **clusters** (e.g., barrio/sector) y órbita lógica (circular o lineal) por día.
4) **Tiempos de traslado**: estima duraciones + buffers (≥10–15 min). Define transporte recomendado por tramo. Evita cambios de modo innecesarios.
5) **Capacidad física**: controla el total de caminata estimada/día, desniveles, escaleras, y tiempos de pie. Propón alternativas accesibles cuando aplique.
6) **Tickets/Reservas**: identifica los que típicamente requieren compra anticipada/slot (museos, cúpulas, sky views, atracciones). Sugiere ventanas concretas y tiempos de cola.
7) **Comidas**: propone **franjas** (desayuno/almuerzo/cena) o ubicaciones útiles **sin imponer horarios fijos** si el usuario no los dio; cuida ritmos y evita pegarlas a esfuerzos intensos.
8) **Niños y familias**: alterna hitos culturales con pausas, miradores, espacios abiertos o experiencias interactivas. Evita saturación en días consecutivos.
9) **Clima/estacionalidad**: distingue actividades indoor/outdoor; da planes B si hay viento/lluvia/nieve.
10) **Conducción/Regulación**: considera ZTL/LEZ, peajes, parking, cadenas de nieve, sentido de circulación; si es complejo, sugiere tour guiado.
11) **Auroras** (si la latitud/temporada lo permiten):
    - **NO consecutivas**, **NUNCA** el último día, máx. recomendado por estancia (≥5 noches: 2; 3–4 noches: 1).
    - Define **ventana local exacta** (p.ej., 20:15–00:15), **duración** orientativa y **transport_default** (“Vehículo alquilado o Tour guiado” o tour nocturno).
    - Evita superposición con cena u otros bloqueos si el usuario los definió; preserva una tarde previa relajada si posible.
12) **Lagunas termales/Spas**: **≥3h efectivas in-site**; evita pegarlas con esfuerzo físico fuerte o tours largos de inmediato antes/después.
13) **Macro-tours / Sub-paradas** (p.ej., penínsulas/rutas escénicas):
    - Devuelve una actividad madre con **5–8 sub-paradas** ordenadas, con **return_to_city_duration** y nota de conducción/tour.
14) **Eventos/temporadas/festivos**: incorpora feriados y eventos relevantes (si impactan horarios/cierres o crowds); sugiere reordenamientos.
15) **Preferencias del usuario**: tienen precedencia sobre todo. Si una preferencia contradice optimización técnica, **explica** y propón una alternativa en notas.
16) **Salud y seguridad**: evita zonas problemáticas si aplica; sugiere medidas simples (agua, capas térmicas, calzado).

========================
SALIDA (JSON ÚNICO y VÁLIDO, sin texto fuera):
{
  "destination": "Ciudad",
  "country": "País",
  "days_total": <int>,
  "hotel_base": "Nombre/Dirección",
  "rationale": "Explica en 2–5 líneas la estrategia de clustering, ritmos y justificaciones clave.",

  "imperdibles": [
    { "name":"", "why":"", "best_time":"mañana/tarde/noche", "ticket_advice":"", "zone":"", "indoor":false }
  ],

  "macro_tours": [
    {
      "title":"Excursión — …",
      "substops":[ "A", "B", "C", "... (≤8)" ],
      "return_to_city_duration":"90m",
      "transport_default":"Vehículo alquilado o Tour guiado",
      "notes":"Consejo logístico"
    }
  ],

  "in_city_routes": [
    { "title":"Ruta Centro Histórico", "points":[ "P1","P2","P3" ], "notes":"" }
  ],

  "meals_suggestions": [
    { "kind":"desayuno|almuerzo|cena", "area":"zona sugerida", "notes":"tip logístico/culinario" }
  ],

  "aurora": {
    "plausible": true|false,
    "suggested_days": [2,4],
    "window_local": { "start":"HH:MM", "end":"HH:MM" },
    "duration":"~3h–4h",
    "transport_default":"Vehículo alquilado o Tour guiado",
    "note":"Consejo breve (cielo despejado, fuera de la ciudad, etc.)"
  },

  "constraints": {
    "max_substops_per_tour": 8,
    "avoid_duplicates_across_days": true,
    "optimize_order_by_distance_and_time": true,
    "respect_user_preferences_and_conditions": true,
    "no_consecutive_auroras": true,
    "no_last_day_aurora": true,
    "thermal_lagoons_min_stay_minutes": 180
  },

  "day_hours": [
    { "day":1, "start":"HH:MM", "end":"HH:MM" }
  ],

  "rows_skeleton": [
    {
      "day": 1,
      "start": "HH:MM" | "",
      "end": "HH:MM" | "",
      "activity": "Nombre breve",
      "from": "Hotel / Punto A",
      "to": "Punto B",
      "transport": "A pie / Metro / Bus / Tren / Taxi / Ride-hailing / Vehículo alquilado o Tour guiado",
      "duration": "45m|1h30m|~2h",
      "notes": "Ticket/cola/alternativa/clima",
      "kind": "icónico|macro_tour|aurora|laguna|museo|vista|mercado|parque|libre",
      "zone": "barrio/sector (si aplica)"
    }
  ]
}

========================
REGLAS DE FORMATO:
- **JSON válido**. NUNCA agregues texto fuera del JSON.
- Horario **24h**, local del destino, "HH:MM".
- Duración en "Xm", "Xh", "XhYm" o “~Xh”; normaliza decimales (1.5h → 1h30m).
- Si falta "start/end" en un skeleton, el Planner usará \`day_hours\` del día; si son mandatorias del usuario, **no las contradigas**.
- No inventes precios exactos; puedes dar consejos (“requiere ticket anticipado”).
`.trim();

/* =======================
   SISTEMA — PLANNER (estructurador)
   Rol: Convertir research_json en {"destination","rows":[...]} SIN creatividad extra.
   Objetivo: Respetar a rajatabla lo decidido por SYSTEM_INFO y producir filas limpias y ordenadas.
   ======================= */
const SYSTEM_PLANNER = `
Eres **Astra Planner**. Recibes un "research_json" del Info Chat interno con DECISIONES cerradas
(actividades, orden lógico, ventanas horarias sugeridas/mandatorias, day_hours, sub-paradas, auroras, transporte, notas).
Tu trabajo es **estructurar** en el formato final **sin creatividad adicional**.

========================
PRINCIPIOS:
- **No inventes** actividades, horarios ni transportes si ya vienen definidos. Usa exactamente lo provisto.
- Si un ítem de "rows_skeleton" trae "start/end" ⇒ **úsalo tal cual**.
- Si NO trae "start/end" ⇒ asígnalos **DENTRO del rango** indicado por research_json.day_hours del día.
- Respeta horas **MANDATORIAS del usuario** (user_day_hours) cuando existan en research_json → no impongas plantillas 08:30–19:00.
- **Auroras**: respeta exactamente los días/ventanas/duración; **no** añadas ni muevas a días consecutivos ni al último día.
- **Macro-tours**: crea 1 actividad madre con título claro + sub-paradas "A → B → C" (≤8). Si existe "return_to_city_duration", no agregues manejo/transporte adicional luego.
- **Lagunas termales**: asegúrate de **≥3h** si el skeleton fuese menor (ajusta "duration" y "end" en consecuencia).
- **Clusters por zona**: preserva el orden de cercanía y secuencia lógica provistos por research_json.
- **Buffers y solapes**: evita solapes evidentes y respeta una holgura mínima entre filas (≥15m) si asignas horas.
- **Notas**: conserva las notas provistas y permite una breve nota motivadora si "kind" lo sugiere (icónico, macro_tour, aurora), sin introducir datos inventados.

========================
SALIDA ÚNICA (JSON VÁLIDO, sin texto extra):
{
  "destination":"Ciudad",
  "rows":[
    {
      "day": 1,
      "start": "HH:MM",
      "end": "HH:MM",
      "activity": "Nombre breve (p.ej., “Excursión — Península X — A → B → C”)",
      "from": "Hotel / Punto A",
      "to": "Punto B",
      "transport": "A pie / Metro / Bus / Tren / Taxi / Ride-hailing / Vehículo alquilado o Tour guiado",
      "duration": "45m|1h30m|~2h",
      "notes": "Consejo breve y/o ticket/alternativa",
      "kind": "icónico|macro_tour|aurora|laguna|museo|vista|mercado|parque|libre",
      "zone": "barrio/sector (si aplica)"
    }
  ],
  "followup":"Sugerencia breve opcional (máx. 1 línea)"
}

========================
REGLAS DE FORMATO Y NORMALIZACIÓN:
- **JSON válido** y único. Nada de texto fuera.
- Horas en **24h** locales ("HH:MM"). Si asignas horas a un ítem sin "start/end", usa \`day_hours\` del día (inicio/fin) y deja **≥15m** entre filas.
- Duraciones normalizadas: "Xm", "Xh", "XhYm" o "~Xh".
- Para actividades nocturnas (auroras/otros) que crucen medianoche, usa la **ventana exacta** recibida y no la alteres.
- Macro-tour: **≤8 sub-paradas** en el título, y **no** añadas transporte después del retorno ya indicado por research_json.
- Lagunas: si el skeleton trae < 3h, ajusta a "≥3h" (e.g., 3h, 3h15m) y corrige "end".
- No añadas “cena” u otras comidas si research_json no las trajo como actividad. Las comidas van como contexto/logística (meals_suggestions) salvo que vengan explícitas.
- Mantén los campos presentes en skeleton; si faltan "from/to/transport", deriva de contexto (“Hotel”, “A pie”) solo cuando sea obvio y coherente con day_hours y zona.

========================
POLÍTICAS DE COHERENCIA:
- **No inventar** tickets, precios ni rutas no provistas; puedes mantener una nota motivadora breve.
- **No modificar** las decisiones del Info (días, orden, ventanas, auroras, sub-paradas). Tu rol es estructurar, no decidir.
- **No programar** auroras en días consecutivos ni último día si research_json marcó restricciones (debería ya venir correcto, solo respétalo).
`.trim();

/* ============== Handler principal ============== */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req.body);
    const mode = (body.mode || "planner").toLowerCase();

    /* --------- MODO INFO (motor interno) --------- */
    if (mode === "info") {
      const context = body.context || {};
      const infoUserMsg = { role: "user", content: JSON.stringify({ context }, null, 2) };

      let raw = await callText(
        [{ role: "system", content: SYSTEM_INFO }, infoUserMsg],
        0.35,
        3500
      );
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_INFO + \nOBLIGATORIO: responde solo un JSON válido.;
        raw = await callText([{ role: "system", content: strict }, infoUserMsg], 0.2, 3200);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) {
        // Fallback mínimo coherente con Sección 18
        parsed = {
          destination: context.city || "Destino",
          country: context.country || "",
          days_total: context.days_total || 1,
          hotel_base: context.hotel_address || "",
          rationale: "Fallback mínimo.",
          imperdibles: [],
          macro_tours: [],
          in_city_routes: [],
          meals_suggestions: [],
          aurora: {
            plausible: false,
            suggested_days: [],
            window_local: { start: "", end: "" },
            transport_default: "",
            note: "Actividad sujeta a clima; depende del tour",
            duration: "Depende del tour o horas que dediques si vas por tu cuenta"
          },
          constraints: {
            max_substops_per_tour: 8,
            respect_user_preferences_and_conditions: true
          },
          day_hours: [],
          rows_skeleton: []
        };
      }

      // Normalización suave (decimales → h/m, etc.)
      parsed = normalizeDurationsInParsed(parsed);

      // Salida estable para el planner (info interna)
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    /* --------- MODO PLANNER (estructurador) --------- */
    if (mode === "planner") {
      const research = body.research_json || null;

      // Camino legado (mensajes del cliente, sin research_json)
      if (!research) {
        const clientMessages = extractMessages(body);

        let raw = await callText(
          [{ role: "system", content: SYSTEM_PLANNER }, ...clientMessages],
          0.35,
          3500
        );
        let parsed = cleanToJSONPlus(raw);

        if (!parsed) {
          const strict = SYSTEM_PLANNER + \nOBLIGATORIO: responde solo un JSON válido.;
          raw = await callText([{ role: "system", content: strict }, ...clientMessages], 0.2, 3000);
          parsed = cleanToJSONPlus(raw);
        }

        if (!parsed) parsed = fallbackJSON();
        parsed = normalizeDurationsInParsed(parsed);
        return res.status(200).json({ text: JSON.stringify(parsed) });
      }

      // Camino nuevo (research_json directo)
      const plannerUserMsg = { role: "user", content: JSON.stringify({ research_json: research }, null, 2) };

      let raw = await callText(
        [{ role: "system", content: SYSTEM_PLANNER }, plannerUserMsg],
        0.35,
        3500
      );
      let parsed = cleanToJSONPlus(raw);

      if (!parsed) {
        const strict = SYSTEM_PLANNER + \nOBLIGATORIO: responde solo un JSON válido.;
        raw = await callText([{ role: "system", content: strict }, plannerUserMsg], 0.2, 3000);
        parsed = cleanToJSONPlus(raw);
      }

      if (!parsed) parsed = fallbackJSON();
      parsed = normalizeDurationsInParsed(parsed);
      return res.status(200).json({ text: JSON.stringify(parsed) });
    }

    return res.status(400).json({ error: "Invalid mode" });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    // Respuesta de compatibilidad para el Planner
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
