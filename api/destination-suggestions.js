const OPEN_METEO_GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const COUNTRIES_NOW_CITIES_URL = "https://countriesnow.space/api/v0.1/countries/cities";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const queryCache = new Map();
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

async function fetchJson(url, options = {}, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function searchOpenMeteo(query, countryCode, lang) {
  if (String(query || "").trim().length < 3 || !/^[A-Z]{2}$/.test(countryCode)) return [];

  const params = new URLSearchParams({
    name: String(query).trim(),
    count: "40",
    format: "json",
    language: lang === "es" ? "es" : "en",
    countryCode
  });

  const payload = await fetchJson(`${OPEN_METEO_GEOCODING_URL}?${params.toString()}`);
  const rows = Array.isArray(payload?.results) ? payload.results : [];

  return uniqueStrings(rows.map(item => item?.name));
}

async function getCountryCities(country) {
  const key = normalizeSearch(country);
  const cached = countryCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.cities;

  const payload = await fetchJson(COUNTRIES_NOW_CITIES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ country })
  }, 6000);

  if (!payload || payload.error || !Array.isArray(payload.data)) {
    throw new Error("COUNTRIES_NOW_INVALID_RESPONSE");
  }

  const cities = uniqueStrings(payload.data);
  countryCache.set(key, { at: Date.now(), cities });
  return cities;
}

async function searchCountriesNow(query, country) {
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

  const sorter = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  starts.sort(sorter);
  contains.sort(sorter);
  return [...starts, ...contains];
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const country = String(req.query?.country || "").trim().slice(0, 120);
  const countryCode = String(req.query?.countryCode || "").trim().toUpperCase().slice(0, 2);
  const query = String(req.query?.q || "").trim().slice(0, 120);
  const lang = String(req.query?.lang || "en").trim().toLowerCase() === "es" ? "es" : "en";

  if (!country || !/^[A-Z]{2}$/.test(countryCode) || query.length < 3) {
    return res.status(200).json({ ok: true, suggestions: [] });
  }

  const cacheKey = `${countryCode}|${lang}|${normalizeSearch(query)}`;
  const cached = queryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.status(200).json({ ok: true, suggestions: cached.suggestions });
  }

  let suggestions = [];

  /* Primary source: filtered server-side geocoding. This is independent from
     the planning model; the LLM itself still has no live web access. */
  try {
    suggestions = await searchOpenMeteo(query, countryCode, lang);
  } catch (error) {
    console.warn("ITBMO Open-Meteo destination suggestions unavailable:", error?.message || error);
  }

  /* Fallback: country city list. It also helps when the primary source has
     sparse matching for a smaller locality. Failure never blocks free text. */
  if (suggestions.length < 6) {
    try {
      suggestions = uniqueStrings([
        ...suggestions,
        ...(await searchCountriesNow(query, country))
      ]);
    } catch (error) {
      console.warn("ITBMO CountriesNow destination suggestions unavailable:", error?.message || error);
    }
  }

  suggestions = suggestions.slice(0, 12);
  queryCache.set(cacheKey, { at: Date.now(), suggestions });

  return res.status(200).json({ ok: true, suggestions });
}
