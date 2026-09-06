import { readFileSync } from "node:fs";

/*
  ITBMO destination autocomplete — curated tourism index.
  Base source: GeoNames cities5000 (CC BY 4.0), reduced offline for ITBMO.
  No external request is made by this endpoint.
*/
const DATA = JSON.parse(
  readFileSync(new URL("./data/destinations.min.json", import.meta.url), "utf8")
);

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchRank(record, needle) {
  const labels = [record?.es, record?.en, ...(Array.isArray(record?.a) ? record.a : [])]
    .map(normalizeSearch)
    .filter(Boolean);

  let best = 99;
  for (const value of labels) {
    if (value === needle) best = Math.min(best, 0);
    else if (value.startsWith(needle)) best = Math.min(best, 1);
    else if (value.split(/\s+/).some(part => part.startsWith(needle))) best = Math.min(best, 2);
  }
  return best;
}

function localSuggestions(countryCode, query, lang = "en") {
  const needle = normalizeSearch(query);
  const rows = Array.isArray(DATA[countryCode]) ? DATA[countryCode] : [];
  const displayLang = String(lang || "en").toLowerCase().startsWith("es") ? "es" : "en";

  const ranked = [];
  for (const row of rows) {
    const rank = matchRank(row, needle);
    if (rank > 3) continue;
    ranked.push({
      label: String(row?.[displayLang] || row?.en || row?.es || "").trim(),
      rank,
      tourismExtra: Number(row?.x || 0),
      population: Number(row?.p || 0)
    });
  }

  ranked.sort((a, b) =>
    a.rank - b.rank ||
    b.tourismExtra - a.tourismExtra ||
    b.population - a.population ||
    a.label.localeCompare(b.label, displayLang, { sensitivity: "base" })
  );

  const suggestions = [];
  const seen = new Set();
  for (const item of ranked) {
    const key = normalizeSearch(item.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suggestions.push(item.label);
    if (suggestions.length >= 6) break;
  }
  return suggestions;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const countryCode = String(req.query?.countryCode || "").trim().toUpperCase().slice(0, 2);
  const query = String(req.query?.q || "").trim().slice(0, 120);
  const lang = String(req.query?.lang || "en").trim().toLowerCase().slice(0, 5);

  if (!/^[A-Z]{2}$/.test(countryCode) || query.length < 3) {
    return res.status(200).json({ ok: true, suggestions: [] });
  }

  return res.status(200).json({
    ok: true,
    suggestions: localSuggestions(countryCode, query, lang)
  });
}
