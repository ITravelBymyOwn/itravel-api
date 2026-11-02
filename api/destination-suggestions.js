import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/*
  ITBMO Destinations V2 — bilingual global autocomplete.
  Base source: GeoNames cities500 + alternateNamesV2 (CC BY 4.0), built offline.
  No external request is made by this endpoint.
*/
const DATA = JSON.parse(
  gunzipSync(readFileSync(new URL("./data/destinations.v2.json.gz", import.meta.url))).toString("utf8")
);

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchRank(record, needle) {
  const canonical=[record?.es,record?.en].map(normalizeSearch).filter(Boolean);
  const aliases=(Array.isArray(record?.a)?record.a:[]).map(normalizeSearch).filter(Boolean);
  let best=99;
  for(const value of canonical){
    if(value===needle)best=Math.min(best,0);
    else if(value.startsWith(needle))best=Math.min(best,1);
    else if(value.split(/\s+/).some(part=>part.startsWith(needle)))best=Math.min(best,2);
  }
  /* An alternate name helps discovery but must never outrank the actual city
     name. This prevents aliases such as “Paris of the North” from displacing
     Paris, and “Hall” from displacing Hallstatt. */
  for(const value of aliases){
    if(value===needle)best=Math.min(best,3);
    else if(value.startsWith(needle))best=Math.min(best,4);
    else if(value.split(/\s+/).some(part=>part.startsWith(needle)))best=Math.min(best,5);
  }
  return best;
}

/* Global search never scans the complete catalogue. Each record is admitted
   once per normalized three-character prefix found at the start of a label or
   one of its words. Country-scoped search remains a small direct scan. */
const GLOBAL_PREFIX = new Map();
for (const [countryCode, rows] of Object.entries(DATA)) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const prefixes = new Set();
    for (const label of [row?.es,row?.en,...(Array.isArray(row?.a)?row.a:[])]) {
      const normalized=normalizeSearch(label);
      for (const token of [normalized,...normalized.split(/\s+/)]) if(token.length>=3) prefixes.add(token.slice(0,3));
    }
    const indexed={countryCode,row};
    for (const prefix of prefixes) {
      if(!GLOBAL_PREFIX.has(prefix))GLOBAL_PREFIX.set(prefix,[]);
      GLOBAL_PREFIX.get(prefix).push(indexed);
    }
  }
}

function countryLabel(code, lang="en") {
  try { return new Intl.DisplayNames([String(lang).startsWith("es") ? "es" : "en"], { type:"region" }).of(code) || code; }
  catch (_) { return code; }
}

function rankedRows(countryCode, query, lang = "en") {
  const needle = normalizeSearch(query);
  const rows = Array.isArray(DATA[countryCode]) ? DATA[countryCode] : [];
  const displayLang = String(lang || "en").toLowerCase().startsWith("es") ? "es" : "en";
  return rows.map(row=>({
    city:String(row?.[displayLang] || row?.en || row?.es || "").trim(),
    countryCode,
    country:countryLabel(countryCode,displayLang),
    region:String(row?.r?.[displayLang]||row?.r?.en||row?.r?.es||"").trim(),
    rank:matchRank(row,needle),
    tourismExtra:Number(row?.x||0),
    relevance:Number(row?.q||0),
    population:Number(row?.p||0)
  })).filter(x=>x.city&&x.rank<=5);
}

function globalSuggestions(query, lang="en") {
  const displayLang=String(lang||"en").toLowerCase().startsWith("es")?"es":"en";
  const needle=normalizeSearch(query);
  const ranked=[];
  const candidates=GLOBAL_PREFIX.get(needle.slice(0,3))||[];
  for(const {countryCode,row} of candidates){
    const rank=matchRank(row,needle);if(rank>5)continue;
    ranked.push({city:String(row?.[displayLang]||row?.en||row?.es||"").trim(),countryCode,country:countryLabel(countryCode,displayLang),region:String(row?.r?.[displayLang]||row?.r?.en||row?.r?.es||"").trim(),rank,tourismExtra:Number(row?.x||0),relevance:Number(row?.q||0),population:Number(row?.p||0)});
  }
  ranked.sort((a,b)=>a.rank-b.rank||((b.relevance+b.tourismExtra*90)-(a.relevance+a.tourismExtra*90))||b.population-a.population||a.city.localeCompare(b.city,displayLang,{sensitivity:"base"}));
  const seen=new Set(),results=[];
  for(const item of ranked){
    const key=`${normalizeSearch(item.city)}|${item.countryCode}`;
    if(seen.has(key)) continue;
    seen.add(key); results.push({city:item.city,country:item.country,countryCode:item.countryCode,region:item.region||undefined});
    if(results.length>=12) break;
  }
  return results;
}

function localSuggestions(countryCode, query, lang = "en") {
  const needle = normalizeSearch(query);
  const rows = Array.isArray(DATA[countryCode]) ? DATA[countryCode] : [];
  const displayLang = String(lang || "en").toLowerCase().startsWith("es") ? "es" : "en";

  const ranked = [];
  for (const row of rows) {
    const rank = matchRank(row, needle);
    if (rank > 5) continue;
    ranked.push({
      label: String(row?.[displayLang] || row?.en || row?.es || "").trim(),
      rank,
      tourismExtra: Number(row?.x || 0),
      relevance: Number(row?.q || 0),
      population: Number(row?.p || 0)
    });
  }

  ranked.sort((a, b) =>
    a.rank - b.rank ||
    (b.relevance + b.tourismExtra * 90) - (a.relevance + a.tourismExtra * 90) ||
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

  if (query.length < 3) {
    return res.status(200).json({ ok: true, suggestions: [], results: [] });
  }

  if (String(req.query?.global || "") === "1") {
    return res.status(200).json({ ok:true, results:globalSuggestions(query,lang) });
  }

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return res.status(200).json({ ok: true, suggestions: [] });
  }

  return res.status(200).json({
    ok: true,
    suggestions: localSuggestions(countryCode, query, lang)
  });
}
