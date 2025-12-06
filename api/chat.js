// /api/chat.js — ITBMO · Respuesta estricta en JSON para Planner
// Runtime: Node.js 18+ (Vercel serverless)
// env: OPENAI_API_KEY

import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const config = { runtime: 'nodejs' };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Utilidades JSON robustas ----------
function extractJsonStrict(txt){
  if(!txt) return null;
  try { return JSON.parse(txt); } catch(_) {}
  const start = txt.search(/[{[]/);
  if(start === -1) return null;
  let depth = 0, end = -1, stack = [];
  for(let i=start;i<txt.length;i++){
    const ch = txt[i];
    if(ch==='{' || ch==='['){ depth++; stack.push(ch); }
    else if(ch==='}' || ch===']'){
      if(!depth) break;
      const last = stack[stack.length-1];
      if((last==='{' && ch==='}') || (last==='[' && ch===']')){ stack.pop(); depth--; }
    }
    if(depth===0){ end = i+1; break; }
  }
  if(end>start){
    const slice = txt.slice(start, end);
    try { return JSON.parse(slice); } catch(_) {}
  }
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced){
    try { return JSON.parse(fenced[1]); } catch(_){}
  }
  return null;
}

function looksValidPayload(p){
  if(!p) return false;
  if(Array.isArray(p.rows)) return true;
  if(Array.isArray(p.destinations)) return p.destinations.some(d=>Array.isArray(d.rows));
  if(Array.isArray(p.itineraries))  return p.itineraries.some(i=>Array.isArray(i.rows));
  if(p.destination && Array.isArray(p.rows)) return true;
  return false;
}

// ---------- Prompt base (global, excepto auroras) ----------
const SYSTEM_PROMPT = `
Eres "Astra", un planificador de itinerarios que **devuelve únicamente JSON válido**.
El mundo es tu ámbito: tu lógica es **global** (cualquier país/ciudad/idioma). ÚNICA excepción con reglas especiales: **auroras** (latitud/temporada).
Nunca expliques; **no** uses bloques \`\`\`; **no** agregues texto fuera del JSON.

FORMATOS JSON PERMITIDOS (elige UNO, según corresponda):
- **B**: {"destination":"<CITY>","rows":[...],"replace": true|false}
- **C**: {"rows":[...],"replace": false}
- **D**: {"itinerary":{"<CITY>":{"byDay":{"1":[...],"2":[...]}}}}

Cada fila en "rows" debe incluir, cuando aplique:
{"day":1,"start":"08:30","end":"10:00","activity":"...","from":"...","to":"...","transport":"...","duration":"...","notes":"..."}

REGLAS GLOBALES (OBLIGATORIAS):
- Cubre TODOS los días del rango solicitado. Evita días vacíos.
- Ventanas base por día: si no dan horarios, usa **08:30–19:00** y ajusta si hay noches.
- Inserta **buffers ≥15 min**; evita solapes evidentes.
- **Day trip** solo si aporta valor y **≤2h por trayecto (ida)**; secuencia clara ida→visitas→regreso **MISMO día**.
- **Transporte**:
  - Barco → actividades marinas.
  - Bus/Van tour → excursiones guiadas.
  - Tren/Bus/Auto → trayectos terrestres razonables entre ciudades o suburbios.
  - A pie/Metro → zonas compactas urbanas.
- Si una actividad nocturna cruza de día (p.ej., 20:30–02:00), permite el cruce, y **compensa el inicio del día siguiente**.
- **Notas** siempre informativas (nunca vacías ni "seed"); cuando aplique, incluye indicadores de validez operativa (ej. "valid: ...").
- **Cenas**: muestra franja razonable (19:00–21:30 aprox.) aunque no haya “evento especial”.
- **Tours 1 día (fuera de ciudad)**: al programarlos, usa literal **"Vehículo alquilado o Tour guiado"**. Después de **regresar** a la ciudad, las actividades siguientes **no** deben heredar ese texto; usa el transporte lógico normal.

REGLAS AURORAS (única excepción global):
- Si la ciudad/latitud/temporada hacen plausible auroras, incluye **≥1** noche con ventana aprox. **20:00–02:30** y en notes incluye **"valid:"**.
- No concentres **todas** las auroras en el último día; prefiere distribución temprana/no consecutiva si hay múltiples noches plausibles.

RESTRICCIONES:
- Responde **SOLO** con JSON válido (sin texto extra).
- No inventes entradas inexistentes (p.ej. billetes requeridos si no estás seguro); usa "notes" para sugerir verificación/reserva.
`.trim();

// ---------- Handler ----------
export async function POST(req) {
  try {
    const body = await req.json();

    // Espera:
    // body.mode = 'generate' | 'optimize' | 'edit'
    // body.city, body.days, body.perDay, body.baseDate, body.context (intake), body.range, etc.
    const {
      mode = 'generate',
      city = '',
      days = 1,
      perDay = [],
      baseDate = '',
      context = '',
      range = null, // {start, end}
      replace = false
    } = body || {};

    // Construye instrucción de usuario (concatena tu FORMAT + contexto)
    const userPrompt = (() => {
      let head = '';
      if (mode === 'generate') {
        head = `Formato preferido: B.\nCiudad: ${city}\nDías: ${days}\nVentanas: ${JSON.stringify(perDay)}\nFecha base (D1): ${baseDate||'N/A'}`;
      } else if (mode === 'optimize') {
        head = `Formato preferido: C.\nCiudad: ${city}\nRango a optimizar: ${range ? `${range.start}-${range.end}` : 'completo'}\nVentanas: ${JSON.stringify(perDay)}\nFecha base (D1): ${baseDate||'N/A'}`;
      } else {
        head = `Formato preferido: B.\nCiudad: ${city}\nEdición libre sobre contexto visible.\nVentanas: ${JSON.stringify(perDay)}\nFecha base (D1): ${baseDate||'N/A'}`;
      }
      return `${head}\n\nContexto:\n${context || '(sin contexto adicional)'}\n\nRecuerda: SOLO JSON.`;
    })();

    // Llama al modelo con reintentos escalonados
    const attempts = [
      { name:'normal',  temperature:0.2, suffix:'' },
      { name:'estricto', temperature:0.1, suffix:'\nDEVUELVE EXCLUSIVAMENTE JSON VÁLIDO.' },
      { name:'super',    temperature:0.0, suffix:'\nSOLO JSON sin comentarios ni ```.' }
    ];

    let out = null, raw = '';
    for (let i=0; i<attempts.length; i++){
      const a = attempts[i];
      const msg = [
        { role:'system', content: SYSTEM_PROMPT },
        { role:'user',   content: userPrompt + a.suffix }
      ];
      const resp = await client.chat.completions.create({
        model: 'gpt-4.1-mini',
        temperature: a.temperature,
        messages: msg
      });
      raw = resp.choices?.[0]?.message?.content || '';
      out = extractJsonStrict(raw);
      if (looksValidPayload(out)) break;
      out = null;
    }

    if(!out) {
      // Último recurso: contesta con estructura mínima válida para que el frontend no caiga
      const minimal = {
        destination: city || 'Destino',
        rows: [
          { day: 1, start: "09:00", end:"10:30", activity:"Punto emblemático", from:"Hotel", to:"Centro", transport:"A pie/Metro", notes:"valid: ajustar según horarios locales" },
          { day: 1, start: "12:30", end:"14:00", activity:"Almuerzo típico", from:"Centro", to:"Restaurante", transport:"A pie", notes:"Reserva sugerida" },
          { day: 1, start: "16:00", end:"18:00", activity:"Museo/Parque", from:"Centro", to:"POI", transport:"A pie/Metro", notes:"Verifica cierre" },
          { day: 1, start: "19:30", end:"21:00", activity:"Cena", from:"Hotel/Centro", to:"Restaurante", transport:"A pie/Metro", notes:"Franja razonable" }
        ],
        replace: !!replace
      };
      return NextResponse.json(minimal, { status: 200 });
    }

    return NextResponse.json(out, { status: 200 });

  } catch (err) {
    console.error('/api/chat error', err);
    // respuesta mínima válida para no romper el planner
    return NextResponse.json({
      destination: 'Destino',
      rows: [
        { day: 1, start: "09:00", end:"10:30", activity:"City Walk", from:"Hotel", to:"Centro", transport:"A pie/Metro", notes:"valid: placeholder" },
        { day: 1, start: "12:30", end:"14:00", activity:"Almuerzo", from:"Centro", to:"Restaurante", transport:"A pie", notes:"-" },
        { day: 1, start: "16:00", end:"18:00", activity:"POI", from:"Centro", to:"POI", transport:"A pie/Metro", notes:"-" },
        { day: 1, start: "19:30", end:"21:00", activity:"Cena", from:"Hotel/Centro", to:"Restaurante", transport:"A pie/Metro", notes:"-" }
      ],
      replace: false
    }, { status: 200 });
  }
}
