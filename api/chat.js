// ==========================================================
// /api/chat.js — Motor de inteligencia principal del Planner
// Chat libre, flexible y con deducción estilo ChatGPT
// ==========================================================

export const config = {
  runtime: 'nodejs', // ✅ cambiamos de 'edge' a 'nodejs' para máxima compatibilidad
};

// ==========================================================
// CONFIGURACIÓN CORS
// ==========================================================
const ALLOWED_ORIGINS = [
  // Puedes especificar dominios si lo deseas:
  // 'https://tu-dominio.webflow.io',
  // 'https://www.tu-dominio.com',
  '*', // abierto mientras pruebas
];

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  const allowOrigin =
    ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
      ? origin
      : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ==========================================================
// HANDLER PRINCIPAL
// ==========================================================
export default async function handler(req, res) {
  // --- Preflight (CORS) ---
  if (req.method === 'OPTIONS') {
    return res.writeHead(204, corsHeaders(req)).end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  // --- Parse body ---
  let bodyData = {};
  try {
    bodyData = JSON.parse(req.body);
  } catch {
    bodyData = {};
  }

  const prompt = bodyData.prompt || bodyData.input || '';
  const model = bodyData.model || 'gpt-4o-mini';
  const history = Array.isArray(bodyData.history) ? bodyData.history : [];

  if (!prompt || typeof prompt !== 'string') {
    res.writeHead(400, {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    });
    return res.end(JSON.stringify({ error: 'Missing prompt/input' }));
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    });
    return res.end(JSON.stringify({ error: 'OPENAI_API_KEY not set' }));
  }

  // ==========================================================
  // SYSTEM PROMPT — Inteligencia central (modo GPT real)
  // ==========================================================
  const system = [
    'Eres un asistente de planificación de viajes altamente inteligente y flexible, equivalente a ChatGPT, que actúa dentro de una plataforma de planificación de itinerarios.',
    'Tu rol combina empatía y precisión técnica: interpretas mensajes en cualquier idioma, entiendes fechas, horas, ubicaciones y peticiones ambiguas igual que un humano.',
    'SIEMPRE devuelves SOLO JSON válido, sin texto adicional ni explicaciones fuera del objeto.',
    '',
    'Tu objetivo es interpretar instrucciones de viaje y devolver datos en los siguientes formatos JSON según corresponda:',
    'A) Meta de ciudad → {"meta":{"city":"X","baseDate":"DD/MM/YYYY","start":"HH:MM","end":"HH:MM","hotel":"Texto"}}',
    'B) Itinerario detallado → {"destination":"X","rows":[{"day":1,"start":"HH:MM","end":"HH:MM","activity":"...","from":"...","to":"...","transport":"...","duration":"...","notes":"..."}]}',
    'C) Ajustes o reemplazos → {"replace":true,"destination":"X","rows":[...]}',
    'D) Respuesta general de estado → {"followup":"Texto"}',
    '',
    'Reglas generales de interpretación:',
    '— Acepta texto en cualquier idioma (ES, EN, FR, PT, IT).',
    '— Interpreta fechas naturales ("20 de octubre", "lunes 5", "mañana"). Si el año no está presente, usa el actual o el siguiente según sea lógico.',
    '— Interpreta rangos de hora como "7, 8 y 9 de la mañana" → start="07:00", end="09:00".',
    '— Si el texto menciona "cerca de", "en el hotel", "me hospedo en", etc., coloca eso en hotel.',
    '— Entiende órdenes del usuario como “agrega un día”, “quita la excursión”, “reemplaza el tour por el museo”, etc. y devuélvelas en formato JSON correcto.',
    '— Puedes modificar, eliminar o añadir filas de actividades según las instrucciones del usuario.',
    '— Cuando no estés seguro del formato, devuelve un objeto {"followup":"Pregunta o confirmación"} para continuar la conversación.',
    '',
    'En todas tus respuestas: nunca uses comillas simples, nunca añadas texto fuera del JSON.',
    'Tu comportamiento debe ser tan inteligente y adaptable como ChatGPT, pero tu salida debe ser estructurada estrictamente como JSON válido.',
  ].join(' ');

  // ==========================================================
  // CONSTRUCCIÓN DE LA SOLICITUD A OPENAI
  // ==========================================================
  const messages = [
    { role: 'system', content: system },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: prompt },
  ];

  const payload = {
    model,
    temperature: 0.3,
    top_p: 1,
    messages,
  };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const text = await r.text();
      res.writeHead(500, {
        'Content-Type': 'application/json',
        ...corsHeaders(req),
      });
      return res.end(
        JSON.stringify({ error: 'Upstream error', detail: text })
      );
    }

    const data = await r.json();
    let content = data?.choices?.[0]?.message?.content ?? '';

    // ==========================================================
    // VALIDACIÓN FINAL DE SALIDA
    // ==========================================================
    const trimmed = content.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      content = JSON.stringify({ followup: trimmed });
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    });
    return res.end(content);
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      ...corsHeaders(req),
    });
    return res.end(JSON.stringify({ error: 'Fetch error', detail: String(err) }));
  }
}
