const ITBMO_PLANNER_BUILD = "V95";
const ITBMO_GENERATION_PROTOCOL = "physical-units-v15";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-ITBMO-Server-Build", ITBMO_PLANNER_BUILD);

  if (req.method !== "GET") {
    return res.status(405).json({ ok:false, code:"METHOD_NOT_ALLOWED" });
  }

  return res.status(200).json({
    ok:true,
    planner_build:ITBMO_PLANNER_BUILD,
    generation_protocol:ITBMO_GENERATION_PROTOCOL
  });
}
