// ==========================================================
// /api/chat.js — Motor de inteligencia principal del Planner
// Chat libre, flexible y con deducción estilo ChatGPT
// ==========================================================

export const config = {
  runtime: 'nodejs20.x',
};

// ==========================================================
// CONFIGURACIÓN CORS
// ==========================================================
const ALLOWED_ORIGINS = [
  'https://tu-dominio.webflow.io',
  'https://www.tu-dominio.com'
];

// ==========================================================
// FUNCIÓN PRINCIPAL
// ==========================================================
export default async function handler(req, res) {
  // Validación CORS
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    res.status(403).json({ error: 'CORS not allowed' });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { messages } = req.body;

    // Llamada al modelo GPT-4o-mini
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Eres un planificador de viajes inteligente. Devuelve respuestas claras, con formato markdown y listas estructuradas.' },
          ...messages
        ]
      })
    });

    const data = await response.json();

    // Manejo de errores de la API
    if (data.error) {
      res.status(500).json({ error: data.error.message });
      return;
    }

    res.status(200).json({
      reply: data.choices?.[0]?.message?.content || 'Sin respuesta'
    });

  } catch (error) {
    console.error('Error interno:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}
