import { NextResponse } from "next/server";
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import { saveSnapshots } from "@/lib/snapshots";
import { updateNYCOdds } from "@/lib/update-nyc-odds";
import { updateBOSOdds } from "@/lib/update-bos-odds";
import { updateNP15Odds } from "@/lib/update-np15-odds";

// GET /api/prices/all
// Fetches real-time 5-min LMPs from GridStatus API for all major US ISOs.
// Returns unified array of { id, name, iso, price, lat, lon }

const API_KEY = process.env.GRIDSTATUS_API_KEY!;
const BASE    = "https://api.gridstatus.io/v1/datasets";

// Three active nodes: NYC, Boston, Bay Area
const NYISO_ZONES: Record<string, { name: string; lat: number; lon: number }> = {
  "N.Y.C.": { name: "New York City (Zone J)", lat: 40.71, lon: -74.01 },
};

const ISONE_ZONES: Record<string, { name: string; lat: number; lon: number }> = {
  ".Z.NEMASSBOST": { name: "Boston (NEMASSBOST)", lat: 42.36, lon: -71.06 },
};

const CAISO_ZONES: Record<string, { name: string; lat: number; lon: number }> = {
  "TH_NP15_GEN-APND": { name: "CAISO NP15 (N. CA)", lat: 38.50, lon: -121.50 },
  "TH_SP15_GEN-APND": { name: "CAISO SP15 (S. CA)", lat: 34.05, lon: -118.50 },
  "TH_ZP26_GEN-APND": { name: "CAISO ZP26 (C. CA)", lat: 36.50, lon: -119.50 },
};

// ET offset: -4 EDT, -5 EST
function etOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -4 : -5;
}

// Date string YYYYMMDD in a given UTC offset
function dateInOffset(offsetHrs: number): string {
  const d = new Date(Date.now() + offsetHrs * 3600 * 1000);
  const y  = d.getUTCFullYear();
  const m  = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

// CAISO: fetch directly from OASIS
const CAISO_HUBS: Record<string, { name: string; lat: number; lon: number }> = {
  "TH_NP15_GEN-APND": { name: "NorCal Hub (NP15)", lat: 37.77, lon: -122.42 },
};

function ptOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -7 : -8;
}

function caISOTime(date: Date, offsetHrs: number): string {
  const d    = new Date(date.getTime() + offsetHrs * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  const hh   = String(d.getUTCHours()).padStart(2, "0");
  const min  = String(d.getUTCMinutes()).padStart(2, "0");
  const sign = offsetHrs < 0 ? "-" : "+";
  const absH = String(Math.abs(offsetHrs)).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}:${min}${sign}${absH}:00`;
}

async function fetchCAISO() {
  const offset    = ptOffset();
  const endTime   = new Date();                               // now
  const startTime = new Date(Date.now() - 30 * 60 * 1000);   // 30 min ago
  const nodeList  = "TH_NP15_GEN-APND";
  const url = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP` +
    `&startdatetime=${caISOTime(startTime, offset)}&enddatetime=${caISOTime(endTime, offset)}` +
    `&version=1&market_run_id=RTM&node=${nodeList}&resultformat=6`;

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) return [];
  const buf = Buffer.from(await resp.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
  if (!entry) return [];
  const csv   = zip.readAsText(entry);
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim());
  const nodeIdx     = header.indexOf("NODE");
  const lmpTypeIdx  = header.indexOf("LMP_TYPE");
  const mwIdx       = header.indexOf("MW");
  const intervalIdx = header.indexOf("OPR_INTERVAL");
  const hrIdx       = header.indexOf("OPR_HR");
  const dtIdx       = header.indexOf("OPR_DT");
  const tzSuffix    = `${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;

  const latest: Record<string, { price: number; sortKey: number; timestamp: string }> = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols[lmpTypeIdx]?.trim() !== "LMP") continue;
    const node     = cols[nodeIdx]?.trim();
    const price    = parseFloat(cols[mwIdx]?.trim());
    const interval = parseInt(cols[intervalIdx]?.trim() ?? "0"); // 1-12 within hour
    const oprHr    = parseInt(cols[hrIdx]?.trim() ?? "0");       // 1-24
    const oprDt    = cols[dtIdx]?.trim() ?? "";                  // "YYYY-MM-DD"
    if (!node || isNaN(price) || !CAISO_HUBS[node] || !oprDt) continue;
    const sortKey  = oprHr * 100 + interval;
    // Build ISO 8601 timestamp in PT so the browser converts correctly to any timezone
    const ptHour   = String(oprHr - 1).padStart(2, "0");
    const ptMin    = String((interval - 1) * 5).padStart(2, "0");
    const ts       = `${oprDt}T${ptHour}:${ptMin}:00${tzSuffix}`;
    if (!latest[node] || sortKey > latest[node].sortKey) {
      latest[node] = { price, sortKey, timestamp: ts };
    }
  }

  return Object.entries(latest).map(([loc, row]) => ({
    id: `CAISO_${loc}`, name: CAISO_HUBS[loc].name, iso: "CAISO",
    price: row.price, lat: CAISO_HUBS[loc].lat, lon: CAISO_HUBS[loc].lon,
    timestamp: row.timestamp,
  }));
}

// ── DAM (Day-Ahead Market) price fetchers ─────────────────────────────────────

// NYISO DAM: public zip at mis.nyiso.com, columns: Timestamp, Name, PTID, LBMP
async function fetchNYISO_DAM(): Promise<number | null> {
  try {
    const dateStr = dateInOffset(etOffset());
    const url = `https://mis.nyiso.com/public/csv/damlbmp/${dateStr}_damlbmp_zone_csv.zip`;
    const resp = await fetch(url, { next: { revalidate: 0 } });
    if (!resp.ok) return null;
    const buf   = Buffer.from(await resp.arrayBuffer());
    const zip   = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
    if (!entry) return null;
    const lines = zip.readAsText(entry).trim().split("\n");
    const nowMs = Date.now();
    let best: number | null = null, bestDiff = Infinity;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.replace(/"/g, "").trim());
      if (cols[1] !== "N.Y.C.") continue;
      const diff = Math.abs(Date.parse(cols[0]) - nowMs);
      if (diff < bestDiff) { bestDiff = diff; best = parseFloat(cols[3]); }
    }
    return best;
  } catch { return null; }
}

// ISO-NE DAM: same Basic Auth, day-ahead hourly LMP endpoint
async function fetchISONE_DAM(): Promise<number | null> {
  try {
    const auth  = Buffer.from(`${process.env.ISONE_USERNAME}:${process.env.ISONE_PASSWORD}`).toString("base64");
    const today = dateInOffset(etOffset());
    const resp  = await fetch(
      `https://webservices.iso-ne.com/api/v1.1/dayaheadlmp/final/day/${today}`,
      { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } }
    );
    if (!resp.ok) return null;
    const data  = await resp.json();
    const lmps: { BeginDate: string; Location: { $: string }; LmpTotal: number }[] =
      data?.DayAheadLmps?.DayAheadLmp ?? [];
    const nowMs = Date.now();
    let best: number | null = null, bestDiff = Infinity;
    for (const lmp of lmps) {
      if (lmp.Location.$ !== ".Z.NEMASSBOST") continue;
      const diff = Math.abs(Date.parse(lmp.BeginDate) - nowMs);
      if (diff < bestDiff) { bestDiff = diff; best = lmp.LmpTotal; }
    }
    return best;
  } catch { return null; }
}

// CAISO DAM: OASIS PRC_LMP with market_run_id=DAM, hourly, find current hour
async function fetchCAISO_DAM(): Promise<number | null> {
  try {
    const offset = ptOffset();
    const ptNow  = new Date(Date.now() + offset * 3600 * 1000);
    const y  = ptNow.getUTCFullYear();
    const m  = String(ptNow.getUTCMonth() + 1).padStart(2, "0");
    const d  = String(ptNow.getUTCDate()).padStart(2, "0");
    const tz = `${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;
    const startDt = `${y}${m}${d}T00:00${tz}`;
    const endDt   = `${y}${m}${d}T23:59${tz}`;
    const url = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP` +
      `&startdatetime=${startDt}&enddatetime=${endDt}` +
      `&version=1&market_run_id=DAM&node=TH_NP15_GEN-APND&resultformat=6`;
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) return null;
    const buf   = Buffer.from(await resp.arrayBuffer());
    const zip   = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
    if (!entry) return null;
    const lines  = zip.readAsText(entry).trim().split("\n");
    const header = lines[0].split(",").map((h) => h.trim());
    const ltIdx  = header.indexOf("LMP_TYPE");
    const mwIdx  = header.indexOf("MW");
    const hrIdx  = header.indexOf("OPR_HR");
    if (ltIdx === -1 || mwIdx === -1 || hrIdx === -1) return null;
    const currentHr = ptNow.getUTCHours() + 1; // OPR_HR is 1-indexed
    let best: number | null = null, bestDiff = Infinity;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols[ltIdx]?.trim() !== "LMP") continue;
      const hr   = parseInt(cols[hrIdx]?.trim() ?? "0");
      const price = parseFloat(cols[mwIdx]?.trim());
      if (isNaN(price)) continue;
      const diff = Math.abs(hr - currentHr);
      if (diff < bestDiff) { bestDiff = diff; best = price; }
    }
    return best;
  } catch { return null; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CacheEntry {
  timestamp: string;
  zones: { id: string; name: string; iso: string; price: number; dam_price: number | null; lat: number; lon: number; timestamp: string }[];
  fetchedAt: number;
}

// File-based cache — survives Next.js hot reloads in development
const CACHE_FILE  = path.join("/tmp", "onpeak-prices-cache.json");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function readCache(): CacheEntry | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(entry)); } catch { /* ignore */ }
}

// NYISO: fetch directly from their public CSV feed (no auth, no API key)
// Convert NYISO "MM/DD/YYYY HH:MM:SS" (Eastern) → ISO 8601 with ET offset
function nyisoTsToISO(ts: string): string {
  const m = ts.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/);
  if (!m) return ts;
  const tz = etOffset() < -4 ? "-05:00" : "-04:00";
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}${tz}`;
}

async function fetchNYISO() {
  const resp = await fetch("https://mis.nyiso.com/public/realtime/realtime_zone_lbmp.csv", {
    next: { revalidate: 0 },
  });
  if (!resp.ok) return [];

  const csv   = await resp.text();
  const lines = csv.trim().split("\n");
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const ts   = cols[0]?.replace(/"/g, "").trim();
    const name = cols[1]?.replace(/"/g, "").trim();
    const lmp  = parseFloat(cols[3]?.replace(/"/g, "").trim());
    if (!name || isNaN(lmp) || !NYISO_ZONES[name]) continue;
    results.push({
      id:        `NYISO_${name}`,
      name:      NYISO_ZONES[name].name,
      iso:       "NYISO",
      price:     lmp,
      lat:       NYISO_ZONES[name].lat,
      lon:       NYISO_ZONES[name].lon,
      timestamp: nyisoTsToISO(ts ?? ""),
    });
  }
  return results;
}

// ISO-NE: fetch directly from their web services API (free, no GridStatus needed)
// Retries once on failure — ISO-NE /current endpoint occasionally returns 503 or empty data.
async function fetchISONE() {
  const user = process.env.ISONE_USERNAME!;
  const pass = process.env.ISONE_PASSWORD!;
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await sleep(2000); // brief pause before retry
    let resp: Response;
    try {
      resp = await fetch(
        "https://webservices.iso-ne.com/api/v1.1/fiveminutelmp/prelim/current",
        { headers: { "Accept": "application/json", "Authorization": `Basic ${auth}` } }
      );
    } catch (err) {
      console.error(`[ISO-NE] attempt ${attempt} network error:`, err);
      continue;
    }
    if (!resp.ok) {
      console.error(`[ISO-NE] attempt ${attempt} HTTP ${resp.status} ${resp.statusText}`);
      continue;
    }
    const data = await resp.json();
    const lmps: { BeginDate: string; Location: { $: string; "@LocType": string }; LmpTotal: number }[] =
      data?.FiveMinLmps?.FiveMinLmp ?? [];
    const results = lmps
      .filter((r) => ISONE_ZONES[r.Location.$])
      .map((r) => ({
        id:        `ISONE_${r.Location.$}`,
        name:      ISONE_ZONES[r.Location.$].name,
        iso:       "ISONE",
        price:     r.LmpTotal,
        lat:       ISONE_ZONES[r.Location.$].lat,
        lon:       ISONE_ZONES[r.Location.$].lon,
        timestamp: r.BeginDate,
      }));
    if (results.length > 0) return results;
    console.error(`[ISO-NE] attempt ${attempt} returned empty LMP array`);
  }
  return [];
}

async function fetchAllISOs(): Promise<CacheEntry> {
  // Read stale cache before fetching — used as CAISO fallback if OASIS is down
  const staleCache = readCache();

  // Fetch RT prices and DAM prices in parallel
  const [rtNYC, rtBoston, rtCAISO, damNYC, damBoston, damCAISO] = await Promise.all([
    fetchNYISO(),
    fetchISONE(),
    fetchCAISO(),
    fetchNYISO_DAM(),
    fetchISONE_DAM(),
    fetchCAISO_DAM(),
  ]);

  // If any ISO API returned nothing, fall back to the last cached zones for that ISO
  // so nodes don't disappear from the map or create snapshot gaps during brief outages.
  const nycZones = rtNYC.length > 0
    ? rtNYC.map((z) => ({ ...z, dam_price: damNYC }))
    : (staleCache?.zones.filter((z) => z.id.startsWith("NYISO_")) ?? []);

  const bostonZones = rtBoston.length > 0
    ? rtBoston.map((z) => ({ ...z, dam_price: damBoston }))
    : (staleCache?.zones.filter((z) => z.id.startsWith("ISONE_")) ?? []);

  const caisoZones = rtCAISO.length > 0
    ? rtCAISO.map((z) => ({ ...z, dam_price: damCAISO }))
    : (staleCache?.zones.filter((z) => z.id.startsWith("CAISO_")) ?? []);

  if (rtNYC.length === 0)    console.error("[NYISO] fetch returned no data — using stale cache");
  if (rtBoston.length === 0) console.error("[ISO-NE] fetch returned no data after retries — using stale cache");
  if (rtCAISO.length === 0)  console.error("[CAISO] fetch returned no data — using stale cache");

  const withDam = [...nycZones, ...bostonZones, ...caisoZones];

  return {
    timestamp: withDam[0]?.timestamp ?? new Date().toISOString(),
    zones: withDam,
    fetchedAt: Date.now(),
  };
}

// In-memory dedup lock — prevents concurrent fetches within one process lifetime
let _inflight: Promise<CacheEntry> | null = null;

export async function GET() {
  try {
    // Check file cache first — survives hot reloads
    const cached = readCache();
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json({ timestamp: cached.timestamp, zones: cached.zones, cached: true });
    }

    // Deduplicate concurrent fetches
    if (!_inflight) {
      _inflight = fetchAllISOs().then((entry) => {
        writeCache(entry);
        saveSnapshots(entry.zones); // persist to DB (fire-and-forget)
        updateNYCOdds().catch((err) => console.error("updateNYCOdds error:", err));   // fire-and-forget
        updateBOSOdds().catch((err) => console.error("updateBOSOdds error:", err));   // fire-and-forget
        updateNP15Odds().catch((err) => console.error("updateNP15Odds error:", err)); // fire-and-forget
        _inflight = null;
        return entry;
      }).catch((err) => {
        _inflight = null;
        throw err;
      });
    }

    const entry = await _inflight;
    return NextResponse.json({ timestamp: entry.timestamp, zones: entry.zones });
  } catch (err) {
    console.error("GridStatus fetch error:", err);
    // Return stale cache on error rather than failing
    const stale = readCache();
    if (stale) {
      return NextResponse.json({ timestamp: stale.timestamp, zones: stale.zones, cached: true, stale: true });
    }
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
