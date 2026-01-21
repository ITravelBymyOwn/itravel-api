// /api/chat.js — v58 (ajustado quirúrgicamente según reglas v52.5) — ESM compatible en Vercel
// ✅ Mantiene interfaz v58: recibe {mode, input/history/messages} y responde { text: "<string>" }.
// ✅ NO rompe modo "info": devuelve texto libre.
// ✅ Ajusta SOLO el prompt del planner + parse/guardrails para cumplir reglas fuertes (city_day preferido, duración 2 líneas, auroras, macro-tours, etc.).

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

function fallbackJSON() {
  return {
    destination: "Desconocido",
    city_day: [
      {
        city: "Desconocido",
        day: 1,
        rows: [
          {
            day: 1,
            start: "09:30",
            end: "11:00",
            activity: "Desconocido – Itinerario base (fallback)",
            from: "Hotel",
            to: "Centro",
            transport: "A pie o Transporte local (según ubicación)",
            duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
            notes: "⚠️ No pude generar el itinerario. Revisa API key/despliegue y vuelve a intentar.",
            kind: "",
            zone: "",
          },
        ],
      },
    ],
    followup: "⚠️ Fallback local: revisa configuración de Vercel o API Key.",
  };
}

// Guard-rail: evita tabla en blanco si el modelo falla en planner
function skeletonCityDay(destination = "Destino", daysTotal = 1) {
  const city = String(destination || "Destino").trim() || "Destino";
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
          activity: `${city} – Reintentar generación (itinerario pendiente)`,
          from: "Hotel",
          to: "Centro",
          transport: "A pie o Transporte local (según ubicación)",
          duration: "Transporte: Verificar duración en el Info Chat\nActividad: Verificar duración en el Info Chat",
          notes:
            "⚠️ No se obtuvo un itinerario válido en este intento. Reintenta o ajusta condiciones; cuando funcione, aquí verás el plan final.",
          kind: "",
          zone: "",
        },
      ],
    });
  }
  return blocks;
}

/* ===================== Small canon helpers (quirúrgico) ===================== */
function _canonTxt_(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _isAuroraText_(t) {
  return /auroras?|aurora|northern\s*lights/i.test(String(t || ""));
}

function _extractMonthFromAnyText_(txt) {
  const s = String(txt || "");

  // dd/mm/yyyy or d/m/yyyy
  const m1 = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m1) {
    const mm = parseInt(m1[2], 10);
    if (mm >= 1 && mm <= 12) return mm;
  }

  // yyyy-mm-dd
  const m2 = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m2) {
    const mm = parseInt(m2[2], 10);
    if (mm >= 1 && mm <= 12) return mm;
  }

  // dd-mm-yyyy
  const m3 = s.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (m3) {
    const mm = parseInt(m3[2], 10);
    if (mm >= 1 && mm <= 12) return mm;
  }

  return null;
}

function _isAuroraSeasonMonth_(month) {
  // Sep–Apr
  return month === 9 || month === 10 || month === 11 || month === 12 || month === 1 || month === 2 || month === 3 || month === 4;
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
    if (Array.isArray(parsed.city_day)) {
      const dest = String(parsed?.destination || "").trim();
      parsed.city_day = _normalizeCityDayShape_(parsed.city_day, dest);
    }

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
  } catch {}

  return parsed;
}

/* ===================== Aurora guard-rail (quirúrgico) ===================== */
function _cityDayHasAurora_(city_day) {
  if (!Array.isArray(city_day)) return false;
  return city_day.some((b) => (Array.isArray(b?.rows) ? b.rows.some((r) => _isAuroraText_(r?.activity)) : false));
}

// 🆕 ultra-quirúrgico: identifica destinos “zona auroral” por heurística simple (sin web)
function _isLikelyAuroraRegion_(destinationCanon) {
  const s = String(destinationCanon || "");
  // Lista corta (segura) + palabras clave de regiones típicas
  if (
    s.includes("reykjavik") ||
    s.includes("reikiavik") ||
    s.includes("tromso") ||
    s.includes("tromsø") ||
    s.includes("alta") || // Alta, Norway
    s.includes("rovaniemi") ||
    s.includes("lapland") ||
    s.includes("laponia") ||
    s.includes("abisko") ||
    s.includes("kiruna") ||
    s.includes("lofoten") ||
    s.includes("svalbard") ||
    s.includes("iceland") ||
    s.includes("islandia") ||
    s.includes("finland") ||
    s.includes("finlandia") ||
    s.includes("norway") ||
    s.includes("noruega") ||
    s.includes("sweden") ||
    s.includes("suecia")
  ) {
    return true;
  }

  // Negativos obvios (evitar falsos positivos como Budapest, etc.)
  if (
    s.includes("budapest") ||
    s.includes("hungary") ||
    s.includes("hungria") ||
    s.includes("madrid") ||
    s.includes("toledo") ||
    s.includes("rome") ||
    s.includes("roma") ||
    s.includes("cairo") ||
    s.includes("el cairo") ||
    s.includes("luxor") ||
    s.includes("athens") ||
    s.includes("atenas") ||
    s.includes("istanbul") ||
    s.includes("estambul")
  ) {
    return false;
  }

  return false;
}

function _injectOneAuroraRow_(parsed, destination, daysTotal) {
  try {
    if (!Array.isArray(parsed.city_day) || parsed.city_day.length === 0) return parsed;
    // elige un día medio (evita el último)
    const day = Math.min(Math.max(1, Math.ceil(daysTotal / 2)), Math.max(1, daysTotal - 1));
    const block = parsed.city_day.find((b) => Number(b?.day) === day) || parsed.city_day[0];
    if (!block || !Array.isArray(block.rows)) return parsed;

    const cityBase = String(destination || block.city || "Ciudad").trim() || "Ciudad";

    block.rows.push({
      day,
      start: "21:00",
      end: "23:30",
      activity: `${cityBase} – Caza de auroras (condicional)`,
      from: "Centro / Hotel",
      to: "Mirador oscuro cercano",
      transport: "Auto (si aplica) o Tour/Van nocturno",
      duration: "Transporte: ~20m–45m\nActividad: ~2h–3h",
      notes:
        "Siente la magia del cielo ártico si hay claridad. valid: temporada de auroras (Sep–Abr) + requiere baja nubosidad; alternativa low-cost: salir a un mirador oscuro cerca de la ciudad si no quieres tour.",
      kind: "",
      zone: "",
    });

    parsed.followup =
      (parsed.followup ? parsed.followup + " | " : "") +
      "✅ Guard-rail: se añadió 1 noche de auroras (condicional) por temporada detectada.";
  } catch {}
  return parsed;
}

// 🆕 ultra-quirúrgico: elimina auroras si el destino NO es zona auroral o si NO es temporada (cuando hay fecha)
function _removeAuroraRowsEverywhere_(parsed, reasonTag = "🧹 Guard-rail: se removieron auroras por latitud/temporada.") {
  try {
    if (!parsed) return parsed;

    if (Array.isArray(parsed.city_day)) {
      parsed.city_day = parsed.city_day.map((b) => {
        const rows = Array.isArray(b?.rows) ? b.rows : [];
        const filtered = rows.filter((r) => !_isAuroraText_(r?.activity));
        return { ...b, rows: filtered };
      });
    }

    if (Array.isArray(parsed.rows)) {
      parsed.rows = parsed.rows.filter((r) => !_isAuroraText_(r?.activity));
    }

    if (Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations.map((d) => {
        const dd = { ...d };
        if (Array.isArray(dd.rows)) dd.rows = dd.rows.filter((r) => !_isAuroraText_(r?.activity));
        if (Array.isArray(dd.city_day)) {
          dd.city_day = dd.city_day.map((b) => {
            const rows = Array.isArray(b?.rows) ? b.rows : [];
            return { ...b, rows: rows.filter((r) => !_isAuroraText_(r?.activity)) };
          });
        }
        return dd;
      });
    }

    parsed.followup = (parsed.followup ? parsed.followup + " | " : "") + reasonTag;
  } catch {}
  return parsed;
}

// ==============================
// Prompt base mejorado ✨ (PLANNER) — Ajustado a reglas v52.5 + FIX auroras/macro-tours
// ==============================
const SYSTEM_PROMPT = `
Eres Astra, el planificador de viajes inteligente de ITravelByMyOwn.
Tu salida debe ser EXCLUSIVAMENTE un JSON válido (sin markdown, sin backticks, sin texto fuera).

FORMATO PREFERIDO (nuevo, tabla-ready):
A) {
  "destination":"Ciudad",
  "days_total":N,
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
B) {"destination":"City","rows":[{...}],"followup":"texto breve"}
C) {"destinations":[{"name":"City","rows":[{...}]}],"followup":"texto breve"}

REGLA DE ORO:
- Debe ser LISTO PARA TABLA: cada fila trae TODO lo necesario.
- Devuelve SIEMPRE al menos 1 fila renderizable (nunca tabla en blanco).
- Nada de texto fuera del JSON.

REGLAS GENERALES (hard):
- Máximo 20 filas por día.
- Horas realistas locales; si el usuario no da horas, decide como experto.
- Las horas deben estar ordenadas y NO superponerse.
- from/to/transport: NUNCA vacíos.
- NO devuelvas "seed" ni notes vacías.

CONTRATO OBLIGATORIO DE CADA ROW:
- day (número)
- start/end en HH:MM (hora local)
- activity: SIEMPRE "DESTINO – SUB-PARADA" (– o - con espacios). Prohibido genérico tipo "museo", "parque", "restaurante local".
- IMPORTANTÍSIMO (Destinos correctos):
  • Si la fila es parte de un MACRO-TOUR / DAY TRIP, entonces DESTINO = nombre del tour/ruta (ej. "Círculo Dorado", "Costa Sur", "Sintra", "Toledo", "Versalles", etc.), y SUB-PARADA = parada específica.
  • Si la fila NO es macro-tour (es dentro de la ciudad base), entonces DESTINO = ciudad base (ej. "Budapest", "Reykjavík") y SUB-PARADA = lugar específico.
- duration: 2 líneas EXACTAS con salto \\n:
  "Transporte: <estimación realista o ~rango>"
  "Actividad: <estimación realista o ~rango>"
  PROHIBIDO: "Transporte: 0m" o "Actividad: 0m"
- notes: obligatorias (>=20 caracteres), motivadoras y útiles:
  1) 1 frase emotiva (Admira/Descubre/Siente…)
  2) 1 tip logístico (mejor hora, reservas, tickets, vista, etc.)
  + condición/alternativa si aplica

HORARIOS / CIERRES (hard, global):
- NO programes visitas en horarios probablemente cerrados.
  • Museos/atracciones: usa franjas diurnas plausibles.
  • Si puede haber día de cierre (p.ej. lunes), evita sugerirlo ese día; si no puedes asegurar el día, añade en notes: "Horario: verificar horas y día de cierre".
- Si hay un conflicto claro por cierre/horario, reemplaza por una alternativa plausible.

EXPERIENCIAS NOCTURNAS (soft-global, cuando aplique):
- Si el destino tiene una experiencia nocturna famosa y realista (crucero nocturno, show/cena, mirador iluminado, paseo nocturno icónico),
  incluye al menos 1 en todo el itinerario con horario nocturno plausible y notes con tip + "Horario: verificar".

COMIDAS (soft):
- NO son obligatorias.
- Inclúyelas SOLO si aportan valor real al flujo.
- Si se incluyen, NO genéricas (ej. "cena en restaurante local" prohibido).

AURORAS (FIX fuerte, global):
- SOLO sugerir auroras si el destino está en ZONA AURORAL (alta latitud, típicamente Islandia/Noruega/Suecia/Finlandia/Laponia/Ártico).
- Si el destino NO está en zona auroral (ej. Budapest), está PROHIBIDO sugerir auroras, aunque el usuario no lo note.
- Si el destino es zona auroral Y el viaje cae en temporada Sep–Abr (si hay fecha en el input), incluye al menos 1 noche de auroras en city_day.
- Evita días consecutivos si hay opciones.
- Evita el último día; si SOLO cabe ahí, marcarlo como condicional en notes.
- Debe ser horario nocturno típico local.
- Notes deben incluir: "valid:" + (clima/nubosidad) + alternativa low-cost cercana.

DAY-TRIPS / MACRO-TOURS (FIX fuerte):
- Si haces una excursión/“day trip”, debes desglosarla en 5–8 sub-paradas (filas) + 1 fila final propia "Regreso a {Ciudad base}".
- Las excursiones deben ser "completas y usuales" para el destino (no recortes ilógicos).
  • Ejemplo guía: en Islandia, "Costa Sur" normalmente llega hasta Vík (si es excursión de día completo), y luego regreso.
- Evitar último día si hay opciones.

SEGURIDAD / COHERENCIA GLOBAL:
- No propongas cosas inviables por distancia/tiempo/temporada o riesgos evidentes.
- Prioriza opciones plausibles, seguras y razonables.

EDICIÓN INTELIGENTE:
- Si el usuario pide agregar/quitar/ajustar horarios, devuelve el JSON actualizado y consistente.
- Por defecto, mantén coherencia global del itinerario.

Responde SOLO JSON válido.
`.trim();

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

    const text =
      resp?.output_text?.trim() ||
      resp?.output?.[0]?.content?.[0]?.text?.trim() ||
      "";

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

    // 🧭 MODO INFO CHAT — texto libre (NO rompemos v58)
    if (mode === "info") {
      const raw = await callStructured(clientMessages, 0.25, 1400, 70000);
      const text = raw || "⚠️ No se obtuvo respuesta del asistente.";
      return res.status(200).json({ text });
    }

    // 🧭 MODO PLANNER — con reglas fuertes del v52.5 (solo via prompt + guardrails)
    let raw = await callStructured([{ role: "system", content: SYSTEM_PROMPT }, ...clientMessages], 0.28, 3200, 90000);
    let parsed = cleanToJSON(raw);

    // 1) Retry: strict (si no parsea o no trae city_day/rows/destinations)
    const hasSome =
      parsed && (Array.isArray(parsed.city_day) || Array.isArray(parsed.rows) || Array.isArray(parsed.destinations));

    if (!hasSome) {
      const strictPrompt =
        SYSTEM_PROMPT +
        `

OBLIGATORIO:
- Responde SOLO JSON válido.
- Debe traer city_day (preferido) o rows (legacy) con al menos 1 fila.
- Nada de meta ni texto fuera.
- Auroras SOLO si el destino es zona auroral y (si hay fecha) es Sep–Abr.`; // 🆕 (quirúrgico)
      raw = await callStructured([{ role: "system", content: strictPrompt }, ...clientMessages], 0.22, 3400, 95000);
      parsed = cleanToJSON(raw);
    }

    // 2) Retry: ultra con ejemplo mínimo (solo si aún falla)
    const stillBad =
      !parsed || (!Array.isArray(parsed.city_day) && !Array.isArray(parsed.rows) && !Array.isArray(parsed.destinations));

    if (stillBad) {
      const ultraPrompt =
        SYSTEM_PROMPT +
        `

Ejemplo válido mínimo (NO lo copies literal; solo guía de formato):
{
  "destination":"CITY",
  "days_total":1,
  "city_day":[{"city":"CITY","day":1,"rows":[
    {"day":1,"start":"09:30","end":"11:00","activity":"CITY – Punto icónico","from":"Hotel","to":"Centro","transport":"A pie","duration":"Transporte: ~10m\\nActividad: ~90m","notes":"Descubre un rincón emblemático y llega temprano para evitar filas. Tip: lleva agua y revisa horarios.","kind":"","zone":""}
  ]}],
  "followup":""
}`;
      raw = await callStructured([{ role: "system", content: ultraPrompt }, ...clientMessages], 0.14, 3600, 95000);
      parsed = cleanToJSON(raw);
    }

    // 3) Normalización + guard-rails anti-tabla-en-blanco
    if (!parsed) parsed = fallbackJSON();
    parsed = normalizeParsed(parsed);

    // Guard-rail final: si city_day existe pero viene vacío/sin filas, inyecta skeleton
    let destination = "Destino";
    let daysTotal = 1;

    try {
      destination = String(parsed?.destination || "Destino").trim() || "Destino";
      daysTotal = Math.max(1, Number(parsed?.days_total || 1));

      if (Array.isArray(parsed.city_day)) {
        parsed.city_day = _normalizeCityDayShape_(parsed.city_day, destination);
        if (!_hasAnyRows_(parsed.city_day)) {
          parsed.city_day = skeletonCityDay(destination, daysTotal);
          parsed.followup =
            (parsed.followup ? parsed.followup + " | " : "") +
            "⚠️ Guard-rail: city_day vacío o sin filas. Se devolvió skeleton para evitar tabla en blanco.";
        }
      }
    } catch {}

    // ✅ Guard-rail AURORAS (inyección + remoción por latitud/temporada)
    try {
      const destCanon = _canonTxt_(destination);
      const inputAll = clientMessages.map((m) => String(m?.content || "")).join("\n");
      const month = _extractMonthFromAnyText_(inputAll);
      const inSeason = month ? _isAuroraSeasonMonth_(month) : false;

      const isAuroraRegion = _isLikelyAuroraRegion_(destCanon);

      // 1) Si NO es zona auroral => elimina cualquier aurora que el modelo haya inventado
      if (!isAuroraRegion) {
        const had = Array.isArray(parsed.city_day) ? _cityDayHasAurora_(parsed.city_day) : false;
        const hadLegacy = Array.isArray(parsed.rows) ? parsed.rows.some((r) => _isAuroraText_(r?.activity)) : false;
        if (had || hadLegacy) {
          parsed = _removeAuroraRowsEverywhere_(parsed, "🧹 Guard-rail: se removieron auroras (destino fuera de zona auroral).");
        }
      } else {
        // 2) Es zona auroral: si hay fecha fuera de temporada => elimina auroras
        if (month && !inSeason) {
          const had = Array.isArray(parsed.city_day) ? _cityDayHasAurora_(parsed.city_day) : false;
          const hadLegacy = Array.isArray(parsed.rows) ? parsed.rows.some((r) => _isAuroraText_(r?.activity)) : false;
          if (had || hadLegacy) {
            parsed = _removeAuroraRowsEverywhere_(parsed, "🧹 Guard-rail: se removieron auroras (fuera de temporada Sep–Abr).");
          }
        }

        // 3) Es zona auroral y en temporada: inyecta 1 si faltan (misma lógica previa, sin romper)
        if (inSeason && Array.isArray(parsed.city_day) && !_cityDayHasAurora_(parsed.city_day) && daysTotal >= 3) {
          parsed = _injectOneAuroraRow_(parsed, destination, daysTotal);
        }
      }
    } catch {}

    return res.status(200).json({ text: JSON.stringify(parsed) });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(200).json({ text: JSON.stringify(fallbackJSON()) });
  }
}
