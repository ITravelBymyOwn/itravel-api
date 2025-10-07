// /api/chat.js
// Chat endpoint con salida JSON ESTRICTA + CORS para Webflow

export const config = {
  runtime: 'edge',
};

// --- Ajusta si quieres whitelistar dominios:
const ALLOWED_ORIGINS = [
  // 'https://tu-dominio.webflow.io',
  // 'https://www.tu-dominio.com',
  '*', // abierto mientras pruebas
];

function corsHeaders(req) {
  const origin = req.headers.get('origin') || '*';
  const allowOrigin = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
    });
  }

  const { prompt } = await req.json().catch(() => ({ prompt: '' }));
  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OPENAI_API_KEY not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
    });
  }

  // Instrucciones: JSON estricto + interpretación “estilo ChatGPT”
  const system = [
    'Eres un asistente EXTRACTOR y EDITOR de planes de viaje. ',
    'SIEMPRE devuelves SOLO JSON válido, sin texto adicional antes o después. ',
    'Nunca uses comillas simples para claves ni valores. ',
    'Tolera y entiende texto en cualquier idioma, expresiones informales y ambigüedades. ',
    'Cuando se te pida EXTRAER meta para una ciudad, analiza fechas y horas de manera flexible: ',
    '— Soporta “20/10/2025”, “20-10-25”, “20 de octubre de 2025”, “lunes 20”, “mañana 8am”, “7:30”, “8 y 9”, etc. ',
    '— Unifica a formato: baseDate="DD/MM/YYYY", start="HH:MM", end="HH:MM", hotel="Texto". ',
    'Cuando se te pida EDITAR/OPTIMIZAR itinerarios, devuélvelos con los formatos B/C/A del esquema provisto por el prompt del cliente.',
  ].join('');

  const body = {
    model: 'gpt-4o-mini', // puedes cambiar a gpt-4o-mini-2024-07-18 si tu cuenta lo soporta
    temperature: 0.2,
    top_p: 1,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      return new Response(JSON.stringify({ error: 'Upstream error', detail: text }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
      });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? '';

    // RESPUESTA FINAL: devolvemos lo que diga el modelo (debe ser SOLO JSON)
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Fetch error', detail: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
    });
  }
}
