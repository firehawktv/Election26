// Pulls Nov 3 2026 races from civicAPI and writes data.json for the page.
// civicAPI's search results already carry candidates, votes, winners and % reporting,
// so this pages the dated search only (no per-race calls). Node 20+, no deps.
import { writeFileSync } from "node:fs";

const BASE = "https://civicapi.org/api/v2", DATE = "2026-11-03", PAGE = 500;
const WATCH = ["GA senate","MI senate","NC senate","ME senate","NH senate","OH senate","TX senate",
  "IA senate","AK senate","MN senate","NE senate","AZ governor","GA governor","MI governor",
  "WI governor","PA governor","NV governor"];

async function get(path, params = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path + "?" + new URLSearchParams(params),
        { headers: { "User-Agent": "election26-pages" }, signal: AbortSignal.timeout(150000) });
      if (r.ok) return r.json();
      last = new Error(`HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (e) { last = e; }
    await new Promise(s => setTimeout(s, 3000 * (i + 1)));
  }
  throw last;
}

// "type" is the reliable field (e.g. "US Senate", "State Senate", "Governor", "Lieutenant Governor").
function office(m) {
  const t = String(m.type || m.election_type || "").toLowerCase();
  const n = String(m.election_name || "").toLowerCase();
  if (/state|lieutenant|shadow|delegate/.test(t) || /lieutenant|shadow/.test(n)) return "other";
  if (t.includes("senate")) return "senate";
  if (t === "house of representatives" || t === "us house" || t === "u.s. house") return "house";
  if (t === "governor") return "governor";
  return "other";
}
const party = p => { p = String(p || "").toUpperCase();
  if (p.startsWith("DEM")) return "D"; if (p.startsWith("REP")) return "R";
  if (p.startsWith("LIB")) return "L"; if (p.startsWith("GRE")) return "G"; return "I"; };

const diag = { pages: {}, types: {} };
const search = (label, q, off = 0) => get("/race/search", { ...q, country: "US", startDate: DATE, endDate: DATE, limit: PAGE, offset: off })
  .then(r => { diag.pages[`${label}@${off}`] = (r.races || []).length; return r.races || []; })
  .catch(e => { diag.pages[`${label}@${off}`] = "ERR " + e.message; return []; });

// Targeted searches by race type, all in parallel; each can take ~45-90s tonight.
const QUERIES = { senate: { query: "Senate" }, house: { query: "US House" }, house2: { query: "House of Representatives" }, gov: { query: "Governor" } };
const jobs = [search("gov", QUERIES.gov), search("house2", QUERIES.house2)];
for (const off of [0, PAGE, 2 * PAGE]) jobs.push(search("senate", QUERIES.senate, off));
for (let off = 0; off < 8 * PAGE; off += PAGE) jobs.push(search("house", QUERIES.house, off));
const seen = new Set(), all = [];
for (const m of (await Promise.all(jobs)).flat()) if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
const total = all.length;
diag.total = total;

const races = [];
for (const m of all) {
  diag.types[m.type] = (diag.types[m.type] || 0) + 1;
  const o = office(m);
  if (o === "other") continue;
  const cands = (m.candidates || [])
    .filter(c => c.votes > 0 || c.winner || c.major_candidate)
    .sort((a, b) => (b.votes || 0) - (a.votes || 0) || (b.major_candidate ? 1 : 0) - (a.major_candidate ? 1 : 0))
    .map(c => ({ name: String(c.name).replace(/\s+/g, " "), party: party(c.party), votes: c.votes || 0, won: !!c.winner }));
  const r = { state: String(m.province || "").toUpperCase(), district: m.district || "", office: o,
    name: m.election_name, rep: m.percent_reporting ?? null, cands };
  // Full detail only for pinned races; the rest just need the call for seat totals.
  races.push(WATCH.includes(`${r.state} ${o}`) ? r
    : { state: r.state, office: o, cands: cands.filter(c => c.won).map(c => ({ party: c.party, won: true })) });
}

writeFileSync("data.json", JSON.stringify({ updated: new Date().toISOString(), found: all.length, races, diag }));
console.log(`fetched ${all.length}/${total}; kept ${races.length}`, JSON.stringify(diag.pages));
