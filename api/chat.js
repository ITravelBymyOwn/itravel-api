export default function handler(req, res) {
  if (req.method === "POST") {
    const { intake } = req.body;

    res.status(200).json({
      success: true,
      message: `Servidor activo ✅ recibí: ${intake || "ningún dato"}`,
    });
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
}

