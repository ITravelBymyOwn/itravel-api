export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const { intake } = req.body || {};

      res.status(200).json({
        success: true,
        echo: intake || "ningún dato",
        message: "🚀 Endpoint /api/chat funcionando correctamente"
      });
    } catch (err) {
      res.status(500).json({ error: "Server error", details: err.message });
    }
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
}
