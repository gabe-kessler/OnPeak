import { NextRequest, NextResponse } from "next/server";
import { getSnapshotsForDay, saveSnapshots } from "@/lib/snapshots";
import AdmZip from "adm-zip";

// GET /api/prices/history?date=YYYY-MM-DD
// Fetches NYISO, CAISO, and ISO-NE RT prices for the given ET date.
// Falls back to DB snapshots (written by /api/prices/all every 5 min) for any zone
// not covered by the direct API fetch.

// ── helpers ───────────────────────────────────────────────────────────────────

function etOffStr(): string {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? "-04:00" : "-05:00";
}

function ptOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -7 : -8;
}

function nyisoTsToISO(ts: string): string {
  const m = ts.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/);
  if (!m) return "";
  return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}T${m[4]}:${m[5]}:${m[6]}${etOffStr()}`;
}

type Row = { id: string; name: string; price: number; timestamp: string };

// ── NYISO: full-day running RT zone CSV ───────────────────────────────────────

async function backfillNYISO(yyyymmdd: string): Promise<Row[]> {
  // No underscore — correct NYISO running RT filename format
  const url  = `https://mis.nyiso.com/public/csv/realtime/${yyyymmdd}realtime_zone.csv`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) return [];
  const lines  = (await resp.text()).trim().split("\n");
  // Headers are CSV-quoted: "Name", "LBMP ($/MWHr)" — strip quotes before comparing
  const strip  = (s: string) => s.trim().replace(/"/g, "");
  const header = lines[0].split(",");
  const nameIdx = header.findIndex(h => strip(h).toLowerCase() === "name");
  const lbmpIdx = header.findIndex(h => strip(h).toLowerCase().startsWith("lbmp"));
  if (nameIdx === -1 || lbmpIdx === -1) return [];

  const nowMs = Date.now();
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (strip(cols[nameIdx] ?? "").toLowerCase() !== "n.y.c.") continue;
    const ts    = nyisoTsToISO(strip(cols[0] ?? ""));
    const price = parseFloat(strip(cols[lbmpIdx] ?? ""));
    if (!ts || isNaN(price)) continue;
    // Skip future intervals — NYISO CSV includes predicted values for rest of day
    if (new Date(ts).getTime() > nowMs) continue;
    out.push({ id: "NYISO_N.Y.C.", name: "New York City (Zone J)", price, timestamp: ts });
  }
  return out;
}

// ── CAISO: RT intervals from ET midnight to now via OASIS ─────────────────────

function caisoDateStr(utcMs: number, offsetHrs: number): string {
  const d    = new Date(utcMs + offsetHrs * 3600_000);
  const y    = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  const hh   = String(d.getUTCHours()).padStart(2, "0");
  const mn   = String(d.getUTCMinutes()).padStart(2, "0");
  const sign = offsetHrs < 0 ? "-" : "+";
  const absH = String(Math.abs(offsetHrs)).padStart(2, "0");
  return `${y}${mm}${dd}T${hh}:${mn}${sign}${absH}:00`;
}

async function backfillCAISO(etDateStr: string): Promise<Row[]> {
  const offset   = ptOffset();
  const tzSuffix = `${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;
  const [y, mo, d] = etDateStr.split("-").map(Number);

  const etOffHrs     = parseInt(etOffStr());
  const etMidnightMs = Date.UTC(y, mo - 1, d) - etOffHrs * 3600_000;

  const startDt = caisoDateStr(etMidnightMs, offset);
  const endDt   = caisoDateStr(Date.now(),   offset);

  const url  = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP` +
    `&startdatetime=${startDt}&enddatetime=${endDt}` +
    `&version=1&market_run_id=RTM&node=TH_NP15_GEN-APND&resultformat=6`;
  const resp = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!resp.ok) return [];

  const buf   = Buffer.from(await resp.arrayBuffer());
  const zip   = new AdmZip(buf);
  const entry = zip.getEntries().find(e => e.entryName.endsWith(".csv"));
  if (!entry) return [];

  const lines  = zip.readAsText(entry).trim().split("\n");
  const header = lines[0].split(",").map(h => h.trim());
  const ltIdx  = header.indexOf("LMP_TYPE");
  const mwIdx  = header.indexOf("MW");
  const hrIdx  = header.indexOf("OPR_HR");
  const intIdx = header.indexOf("OPR_INTERVAL");
  const dtIdx  = header.indexOf("OPR_DT");
  if (ltIdx === -1 || mwIdx === -1) return [];

  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols   = lines[i].split(",");
    if (cols[ltIdx]?.trim() !== "LMP") continue;
    const price  = parseFloat(cols[mwIdx]?.trim());
    const oprHr  = parseInt(cols[hrIdx]?.trim() ?? "0");
    const intNum = parseInt(cols[intIdx]?.trim() ?? "0");
    const oprDt  = cols[dtIdx]?.trim() ?? "";
    if (isNaN(price) || oprHr < 1 || !oprDt) continue;
    const ptHour = String(oprHr - 1).padStart(2, "0");
    const ptMin  = String((intNum - 1) * 5).padStart(2, "0");
    out.push({
      id: "CAISO_TH_NP15_GEN-APND",
      name: "NorCal Hub (NP15)",
      price,
      timestamp: `${oprDt}T${ptHour}:${ptMin}:00${tzSuffix}`,
    });
  }
  return out;
}

// ── ISO-NE: 5-min prelim LMPs for the day via webservices API ─────────────────

async function backfillISONE(yyyymmdd: string): Promise<Row[]> {
  const user = process.env.ISONE_USERNAME;
  const pass = process.env.ISONE_PASSWORD;
  if (!user || !pass) {
    console.error("[history/ISONE] credentials missing — ISONE_USERNAME/ISONE_PASSWORD not set");
    return [];
  }

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  let resp: Response;
  try {
    resp = await fetch(
      `https://webservices.iso-ne.com/api/v1.1/fiveminutelmp/prelim/day/${yyyymmdd}`,
      { headers: { Accept: "application/json", Authorization: `Basic ${auth}` }, cache: "no-store" }
    );
  } catch (err) {
    console.error("[history/ISONE] network error:", err);
    return [];
  }
  if (!resp.ok) {
    console.error(`[history/ISONE] HTTP ${resp.status} ${resp.statusText} for date ${yyyymmdd}`);
    return [];
  }

  const data = await resp.json();
  const lmps: { BeginDate: string; Location: { $: string }; LmpTotal: number }[] =
    data?.FiveMinLmps?.FiveMinLmp ?? [];

  const results = lmps
    .filter(r => r.Location.$ === ".Z.NEMASSBOST")
    .map(r => ({
      id:        "ISONE_.Z.NEMASSBOST",
      name:      "Boston (NEMASSBOST)",
      price:     r.LmpTotal,
      timestamp: r.BeginDate,
    }));

  console.log(`[history/ISONE] fetched ${results.length} rows for ${yyyymmdd}`);
  return results;
}

// ── handler ───────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

// Round a timestamp down to its 5-minute UTC bucket for deduplication
function utcBucket(ts: string): number {
  return Math.floor(new Date(ts).getTime() / (5 * 60 * 1000));
}

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date required (YYYY-MM-DD)" }, { status: 400 });
  }

  const yyyymmdd = date.replace(/-/g, "");

  try {
    // Fetch all 3 sources + DB snapshots in parallel
    const [nyisoR, caisoR, isoneR, dbR] = await Promise.allSettled([
      backfillNYISO(yyyymmdd),
      backfillCAISO(date),
      backfillISONE(yyyymmdd),
      getSnapshotsForDay(date),
    ]);

    const apiRows = [
      ...(nyisoR.status === "fulfilled" ? nyisoR.value : []),
      ...(caisoR.status === "fulfilled" ? caisoR.value : []),
      ...(isoneR.status === "fulfilled" ? isoneR.value : []),
    ];

    if (nyisoR.status === "rejected") console.error("[history] NYISO fetch failed:", nyisoR.reason);
    if (caisoR.status === "rejected") console.error("[history] CAISO fetch failed:", caisoR.reason);
    if (isoneR.status === "rejected") console.error("[history] ISONE fetch failed:", isoneR.reason);
    if (nyisoR.status === "fulfilled" && nyisoR.value.length === 0) console.error("[history] NYISO returned 0 rows");
    if (isoneR.status === "fulfilled" && isoneR.value.length === 0) console.error("[history] ISONE returned 0 rows");

    // Persist new API rows to DB
    if (apiRows.length > 0) saveSnapshots(apiRows).catch(() => {});

    // Merge API rows + DB snapshot rows, preferring API data when timestamps overlap.
    // API data is added first; DB rows for the same (node_id, 5-min bucket) are skipped.
    // This means DB snapshots fill genuine gaps in the API response rather than being
    // excluded wholesale whenever the API returns any data at all.
    const dbRows = dbR.status === "fulfilled" ? dbR.value : [];

    type MergedRow = { node_id: string; name: string; price: number; recorded_at: string };
    const seen = new Set<string>();
    const rows: MergedRow[] = [];

    for (const r of apiRows) {
      const key = `${r.id}:${utcBucket(r.timestamp)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ node_id: r.id, name: r.name, price: r.price, recorded_at: r.timestamp });
    }
    for (const r of dbRows) {
      const key = `${r.node_id}:${utcBucket(String(r.recorded_at))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ node_id: r.node_id, name: r.name, price: Number(r.price), recorded_at: String(r.recorded_at) });
    }

    return NextResponse.json({ rows });
  } catch (err) {
    console.error("GET /api/prices/history error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
