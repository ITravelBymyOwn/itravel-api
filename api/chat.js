// ======================================================
// /api/chat.js — Endpoint de chat para Planner
// JSON estricto + CORS para Webflow + compatibilidad total
// ======================================================

export const config = {
  runtime: 'edge',
};

// --- Ajusta si quieres whitelistar dominios:
const ALLOWED_ORIGINS = [
  // 'https://tu-dominio.webflow.io',
  // 'https://www.tu-dominio.com',
  '*', // abierto durante desarrollo
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

// ======================================================
// Handler principal
// ======================================================
export default async function handler(req) {
  // --- Preflight ---
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } }
    );
  }

  // --- Parse body ---
  const bodyData = await req.json().catch(() => ({}));
  const prompt = bodyData.prompt || bodyData.input || '';
  const model = bodyData.model || 'gpt-4o-mini';
  const history = Array.isArray(bodyData.history) ? bodyData.history : [];

  if (!prompt || typeof prompt !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing prompt/input' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'OPENAI_API_KEY not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } }
    );
  }

  // ======================================================
  // System prompt — igual al usado por Planner
  // ======================================================
  const system = [
    'Eres un asistente EXTRACTOR y EDITOR de planes de viaje.',
    'SIEMPRE devuelves SOLO JSON válido, sin texto adicional antes o después.',
    'Nunca uses comillas simples para claves ni valores.',
    'Tolera texto en cualquier idioma y expresiones naturales (incluso incompletas).',
    'Cuando se te pida EXTRAER meta para una ciudad, analiza fechas y horas libremente:',
    '  — Soporta formatos como “20/10/2025”, “20 de octubre”, “mañana 8am”, “8 y 9”, etc.',
    '  — Devuelve baseDate="DD/MM/YYYY", start="HH:MM", end="HH:MM", hotel="Texto".',
    'Cuando se te pida EDITAR o OPTIMIZAR itinerarios, usa los formatos A, B o C del esquema del prompt.',
  ].join(' ');

  // ======================================================
  // Construir payload OpenAI
  // ======================================================
  const messages = [
    { role: 'system', content: system },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: prompt },
  ];

  const payload = {
    model,
    temperature: 0.2,
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
      return new Response(
        JSON.stringify({ error: 'Upstream error', detail: text }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } }
      );
    }

    const data = await r.json();
    let content = data?.choices?.[0]?.message?.content ?? '';

    // Asegurar salida JSON válida
    if (!content.trim().startsWith('{') && !content.trim().startsWith('[')) {
      content = JSON.stringify({ followup: content });
    }

    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Fetch error', detail: String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } }
    );
  }
}
