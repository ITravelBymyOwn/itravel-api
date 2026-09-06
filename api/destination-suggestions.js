import { readFileSync } from "node:fs";

/*
  ITBMO destination autocomplete — local GeoNames index.
  Source dataset: GeoNames cities5000 (CC BY 4.0).
  No external request is made by this endpoint.
*/
const DATA = JSON.parse(
  readFileSync(new URL("./data/destinations.min.json", import.meta.url), "utf8")
);

const TOURISM_EXTRAS = {
  IT: [
    ["Cinque Terre", ["Cinque Terre"]],
    ["Costa Amalfitana", ["Amalfi Coast", "Costiera Amalfitana"]],
    ["Lago di Como", ["Lake Como", "Como Lake"]],
    ["Dolomitas", ["Dolomites", "Dolomiti"]]
  ],
  ID: [["Bali", ["Bali Island"]]],
  GR: [["Santorini", ["Thira", "Thera"]], ["Mykonos", ["Mikonos"]]],
  PF: [["Bora Bora", ["Bora-Bora"]]],
  US: [["Maui", ["Maui Island"]], ["Big Island", ["Hawaii Island", "Island of Hawaii"]]],
  CL: [["Isla de Pascua", ["Easter Island", "Rapa Nui"]]],
  TZ: [["Zanzíbar", ["Zanzibar"]]],
  ES: [["Islas Canarias", ["Canary Islands", "Canarias"]]],
  HR: [["Lagos de Plitvice", ["Plitvice Lakes", "Plitvička jezera"]]],
  CH: [["Jungfrau Region", ["Jungfrau"]]],
  PT: [["Madeira", ["Madeira Island"]]],
  FR: [["Costa Azul", ["French Riviera", "Côte d’Azur", "Cote d'Azur"]]]
};

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesRecord(record, needle) {
  const name = normalizeSearch(record?.[0]);
  const ascii = normalizeSearch(record?.[1]);
  const aliases = Array.isArray(record?.[3]) ? record[3] : [];
  const primary = [name, ascii].filter(Boolean);
  const alternate = aliases.map(normalizeSearch).filter(Boolean);
  let best = 99;
  for (const value of primary) {
    if (value === needle) best = Math.min(best, 0);
    else if (value.startsWith(needle)) best = Math.min(best, 1);
    else if (value.includes(needle)) best = Math.min(best, 3);
  }
  for (const value of alternate) {
    if (value === needle) best = Math.min(best, 0);
    else if (value.startsWith(needle)) best = Math.min(best, 2);
  }
  return best;
}

function localSuggestions(countryCode, query) {
  const needle = normalizeSearch(query);
  const rows = Array.isArray(DATA[countryCode]) ? DATA[countryCode] : [];
  const ranked = [];

  for (const row of rows) {
    const rank = matchesRecord(row, needle);
    if (rank > 3) continue;
    ranked.push({
      label: String(row[0] || "").trim(),
      rank,
      population: Number(row[2] || 0)
    });
  }

  for (const extra of TOURISM_EXTRAS[countryCode] || []) {
    const label = String(extra?.[0] || "").trim();
    const aliases = Array.isArray(extra?.[1]) ? extra[1] : [];
    const values = [label, ...aliases].map(normalizeSearch);
    let rank = 99;
    for (const value of values) {
      if (value === needle) rank = Math.min(rank, 0);
      else if (value.startsWith(needle)) rank = Math.min(rank, 1);
      else if (value.includes(needle)) rank = Math.min(rank, 2);
    }
    if (rank <= 2) ranked.push({ label, rank, population: Number.MAX_SAFE_INTEGER });
  }

  ranked.sort((a, b) =>
    a.rank - b.rank ||
    b.population - a.population ||
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
  );

  const seen = new Set();
  const suggestions = [];
  for (const item of ranked) {
    const key = normalizeSearch(item.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(item.label);
    if (suggestions.length >= 12) break;
  }
  return suggestions;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const countryCode = String(req.query?.countryCode || "").trim().toUpperCase().slice(0, 2);
  const query = String(req.query?.q || "").trim().slice(0, 120);

  if (!/^[A-Z]{2}$/.test(countryCode) || query.length < 3) {
    return res.status(200).json({ ok: true, suggestions: [] });
  }

  return res.status(200).json({
    ok: true,
    suggestions: localSuggestions(countryCode, query)
  });
}
