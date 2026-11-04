// Pulls 2026 general-election races from civicAPI and writes data.json for the page.
// Runs in GitHub Actions (server side, so no CORS). Node 20+, no deps.
import { writeFileSync } from "node:fs";

const BASE = "https://civicapi.org/api/v2", DATE = "2026-11-03";
const WATCH = ["GA senate","MI senate","NC senate","ME senate","NH senate","OH senate","TX senate",
  "IA senate","AK senate","MN senate","NE senate","AZ governor","GA governor","MI governor",
  "WI governor","PA governor","NV governor"];

const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== "") return o[k]; };
const list = p => Array.isArray(p) ? p : (p.races || p.results || p.data || p.items || []);
const party = p => { p = String(p || "").toUpperCase(); if (/^(D|DEM)/.test(p)) return "D"; if (/^(R|REP|GOP)/.test(p)) return "R"; return p ? "I" : "?"; };
const office = n => { n = (n || "").toLowerCase(); if (n.includes("state")) return "other";
  if (n.includes("senate")) return "senate"; if (n.includes("house") || n.includes("congress")) return "house";
  if (n.includes("governor") && !n.includes("lieutenant")) return "governor"; return "other"; };
const st = o => String(pick(o, "province", "state") || "").slice(0, 2).toUpperCase();

async function get(path, params = {}) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(BASE + path + "?" + new URLSearchParams(params), { headers: { "User-Agent": "election26-pages" }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return r.json();
      console.log(`${path} ${JSON.stringify(params)} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}`);
    } catch (e) { console.log(`${path} error: ${e.message} ${e.cause?.code || ""}`); if (i === 2) throw e; }
    await new Promise(s => setTimeout(s, 2000 * (i + 1)));
  }
  throw new Error("retries exhausted");
}

function norm(raw, meta) {
  const r = raw.race || raw;
  const cands = (pick(r, "candidates", "results") || []).map(c => ({
    name: pick(c, "name", "candidate_name", "candidate") || "?",
    party: party(pick(c, "party", "party_name", "party_code")),
    votes: +pick(c, "votes", "vote_count", "total_votes") || 0,
    won: !!pick(c, "winner", "is_winner", "called", "elected"),
  })).sort((a, b) => b.votes - a.votes);
  const w = pick(r, "winner", "called_for");
  if (!cands.some(c => c.won) && typeof w === "string")
    cands.forEach(c => { if (c.name.toLowerCase().includes(w.toLowerCase())) c.won = true; });
  const name = pick(r, "election_name", "name", "race_name") || pick(meta, "election_name", "name") || "";
  const rep = parseFloat(pick(r, "percent_reporting", "pct_reporting", "reporting", "expected_vote_pct"));
  return { name, state: st(r) || st(meta), office: office(name), rep: isNaN(rep) ? null : rep, cands };
}

const metas = [];
// Targeted searches instead of paging every local race on the ballot.
const DEADLINE = Date.now() + 6 * 60e3;
const seen = new Set(), diag = { searches: {}, rawSearch: null, rawSearchTop: null, rawRace: null };
for (const query of ["Senate", "Governor", "House", "Congress"]) {
  for (let off = 0; off < 1000 && Date.now() < DEADLINE; off += 100) {
    let p = [];
    try { const raw = await get("/race/search", { query, country: "US", startDate: DATE, endDate: DATE, limit: 100, offset: off });
      p = list(raw); diag.searches[`${query}@${off}`] = p.length;
      if (!diag.rawSearchTop) diag.rawSearchTop = Array.isArray(raw) ? "array" : Object.keys(raw).join(",");
      if (!diag.rawSearch && p[0]) diag.rawSearch = JSON.stringify(p[0]).slice(0, 1500); }
    catch (e) { diag.searches[`${query}@${off}`] = "ERR " + e.message; break; }
    for (const m of p) { const id = pick(m, "id", "race_id"); if (!seen.has(id)) { seen.add(id); metas.push(m); } }
    if (p.length < 100) break;
  }
}
const watched = m => WATCH.includes(`${st(m)} ${office(pick(m, "election_name", "name"))}`);
const want = metas.filter(m => { const o = office(pick(m, "election_name", "name"));
  return o === "senate" || o === "house" || watched(m); })
  .sort((a, b) => watched(b) - watched(a));   // pinned races first

const races = [];
for (let i = 0; i < want.length && Date.now() < DEADLINE; i += 8) {
  const b = await Promise.all(want.slice(i, i + 8).map(m =>
    get("/race/" + pick(m, "id", "race_id"), { light: "true" }).then(r => { if (!diag.rawRace) diag.rawRace = JSON.stringify(r).slice(0, 2500); return norm(r, m); }).catch(() => null)));
  races.push(...b.filter(Boolean));
}

// Keep the file small: full detail only for watched races; just the call for the rest.
const out = races.map(r => WATCH.includes(`${r.state} ${r.office}`) ? r
  : { state: r.state, office: r.office, cands: r.cands.filter(c => c.won).map(c => ({ party: c.party, won: true })) });

writeFileSync("data.json", JSON.stringify({ updated: new Date().toISOString(), found: metas.length, races: out, diag }));
console.log(`${Date.now() > DEADLINE ? "PARTIAL (deadline) " : ""}search: ${metas.length} races, kept ${want.length}, fetched ${races.length}`);
if (metas[0]) console.log("sample search item keys:", Object.keys(metas[0]).join(","));

// Diagnostics: when nothing matched, record what civicAPI actually returns so the filters can be fixed.
if (!metas.length) {
  const probe = {};
  for (const [k, p] of Object.entries({
    dated: { query: "Senate", country: "US", startDate: DATE, endDate: DATE, limit: 3 },
    nodate: { query: "Senate", country: "US", limit: 3 },
    country_only: { country: "US", limit: 3 },
    dates_api: null,
  })) {
    try {
      const r = p ? await get("/race/search", p) : await get("/getElectionDates", { year: 2026, country: "US" });
      probe[k] = JSON.stringify(r).slice(0, 1500);
    } catch (e) { probe[k] = "ERR " + e.message; }
  }
  writeFileSync("data.json", JSON.stringify({ updated: new Date().toISOString(), found: 0, races: [], probe }));
}
