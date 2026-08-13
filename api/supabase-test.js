export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !supabaseSecretKey) {
      return res.status(500).json({
        ok: false,
        error: "Supabase environment variables are missing",
        hasUrl: Boolean(supabaseUrl),
        hasSecretKey: Boolean(supabaseSecretKey)
      });
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/profiles?select=id&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: supabaseSecretKey,
          Accept: "application/json"
        }
      }
    );

    const body = await response.text();

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: "Supabase request failed",
        status: response.status,
        details: body
      });
    }

    return res.status(200).json({
      ok: true,
      message: "ITBMO Vercel → Supabase connection successful"
    });

  } catch (error) {
    console.error("Supabase connection test failed:", error);

    return res.status(500).json({
      ok: false,
      error: "Unexpected server error",
      details: String(error?.message || error)
    });
  }
}
