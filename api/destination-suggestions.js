const COUNTRIES_NOW_CITIES_URL = "https://countriesnow.space/api/v0.1/countries/cities";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const countryCache = new Map();

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map(value => String(value || "").trim())
      .filter(Boolean)
  )];
}

async function getCountryCities(country) {
  const key = normalizeSearch(country);
  const cached = countryCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.cities;
  }

  const response = await fetch(COUNTRIES_NOW_CITIES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ country })
  });

  if (!response.ok) {
    throw new Error(`COUNTRIES_NOW_HTTP_${response.status}`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload || payload.error || !Array.isArray(payload.data)) {
    throw new Error("COUNTRIES_NOW_INVALID_RESPONSE");
  }

  const cities = uniqueStrings(payload.data);
  countryCache.set(key, { at: Date.now(), cities });
  return cities;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok:false, error:"Method not allowed" });
  }

  const country = String(req.query?.country || "").trim().slice(0, 120);
  const query = String(req.query?.q || "").trim().slice(0, 120);

  if (!country || query.length < 2) {
    return res.status(200).json({ ok:true, suggestions:[] });
  }

  try {
    const cities = await getCountryCities(country);
    const needle = normalizeSearch(query);

    const starts = [];
    const contains = [];

    for (const city of cities) {
      const normalized = normalizeSearch(city);
      if (!normalized.includes(needle)) continue;
      if (normalized.startsWith(needle)) starts.push(city);
      else contains.push(city);
    }

    const sorter = (a, b) => a.localeCompare(b, undefined, { sensitivity:"base" });
    starts.sort(sorter);
    contains.sort(sorter);

    return res.status(200).json({
      ok:true,
      suggestions:[...starts, ...contains].slice(0, 12)
    });
  } catch (error) {
    console.warn("ITBMO destination suggestions unavailable:", error?.message || error);
    /* Suggestions are an enhancement, never a blocker: the Planner keeps
       accepting a free-text destination and validates it in the existing
       normalization step when the trip is saved. */
    return res.status(200).json({ ok:true, suggestions:[] });
  }
}
