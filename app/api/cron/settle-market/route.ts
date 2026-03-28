import { NextResponse } from "next/server";
import pool from "@/lib/db";
import AdmZip from "adm-zip";

// POST /api/cron/settle-market
// Called at 12:05 AM ET each day.
//
// Settlement uses a Load-Weighted Average Price (LWAP):
//   LWAP = Σ(hourly_avg_price × hourly_load) / Σ(hourly_load)
//
// This weights each hour's price by how much energy was actually consumed that
// hour, matching how real ISO financial products settle. If load data is
// unavailable for an ISO, we fall back to a simple arithmetic average.
//
// Price sources:
//   NYC      — NYISO public RT daily zone CSV  (5-min intervals)
//   Boston   — ISO-NE public RT prelim CSV     (hourly, HE 1-24)
//   Bay Area — CAISO OASIS PRC_INTVL_LMP RTM  (5-min intervals)
//
// Load sources  (hourly MW):
//   NYC      — NYISO public PAL zone CSV       (projected area load, fallback to simple avg)
//   Boston   — none (no public source; falls back to simple average)
//   Bay Area — CAISO OASIS SLD_FCST ACTUAL     (5-min intervals averaged per hour)

// ── shared types / helpers ────────────────────────────────────────────────────

// Map of operating-hour (0-23) → { sum of 5-min prices, count }
type HourPrices = Map<number, { sum: number; count: number }>;
// Map of operating-hour (0-23) → load in MW
type HourLoads  = Map<number, number>;

// Load-weighted average price. Falls back to simple average if all loads = 0.
function lwap(prices: HourPrices, loads: HourLoads): number {
  let weightedSum = 0;
  let totalLoad   = 0;
  for (const [h, { sum, count }] of prices) {
    const avgPrice = sum / count;
    const load     = loads.get(h) ?? 0;
    weightedSum   += avgPrice * load;
    totalLoad     += load;
  }
  if (totalLoad > 0) return weightedSum / totalLoad;
  // Fallback: simple average across all intervals
  let priceSum = 0, priceCount = 0;
  for (const { sum, count } of prices.values()) { priceSum += sum; priceCount += count; }
  return priceCount > 0 ? priceSum / priceCount : 0;
}

function ptOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -7 : -8;
}

async function unzipCAISO(url: string): Promise<string> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`CAISO HTTP ${resp.status}`);
  const buf   = Buffer.from(await resp.arrayBuffer());
  const zip   = new AdmZip(buf);
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
  if (!entry) throw new Error("No CSV in CAISO zip");
  return zip.readAsText(entry);
}

// Extract hour 0-23 from NYISO timestamp "MM/DD/YYYY HH:MM:SS"
function nyisoHour(ts: string): number | null {
  const m = ts.match(/\d+\/\d+\/\d+\s+(\d+):/);
  return m ? parseInt(m[1]) : null;
}

// Extract hour 0-23 from ISO8601 timestamp (uses local wall-clock hour)
function isoHour(ts: string): number | null {
  try { return new Date(ts).getHours(); } catch { return null; }
}

// ── NYC: NYISO prices + PAL load ──────────────────────────────────────────────

async function fetchNYCData(yyyymmdd: string): Promise<{ prices: HourPrices; loads: HourLoads }> {
  const [priceResp, loadResp] = await Promise.all([
    fetch(`https://mis.nyiso.com/public/csv/realtime/${yyyymmdd}realtime_zone.csv`),
    fetch(`https://mis.nyiso.com/public/csv/pal/${yyyymmdd}pal_zone.csv`),
  ]);

  if (!priceResp.ok) throw new Error(`NYISO RT HTTP ${priceResp.status}`);

  // --- 5-min prices ---
  const pLines  = (await priceResp.text()).trim().split("\n");
  const pHeader = pLines[0].split(",");
  const pName   = pHeader.findIndex((h) => h.replace(/"/g, "").trim().toLowerCase() === "name");
  const pLbmp   = pHeader.findIndex((h) => h.replace(/"/g, "").trim().toLowerCase().startsWith("lbmp"));
  if (pName === -1 || pLbmp === -1) throw new Error(`Unexpected NYISO RT CSV format. Header: ${pLines[0]?.slice(0, 200)}`);

  const prices: HourPrices = new Map();
  for (let i = 1; i < pLines.length; i++) {
    const cols = pLines[i].split(",");
    if (cols[pName]?.replace(/"/g, "").trim().toLowerCase() !== "n.y.c.") continue;
    const price = parseFloat(cols[pLbmp]?.trim());
    const hour  = nyisoHour(cols[0]?.trim() ?? "");
    if (isNaN(price) || hour === null) continue;
    const bucket = prices.get(hour) ?? { sum: 0, count: 0 };
    prices.set(hour, { sum: bucket.sum + price, count: bucket.count + 1 });
  }
  if (prices.size === 0) throw new Error("No NYC price rows in NYISO RT CSV");

  // --- hourly PAL load ---
  const loads: HourLoads = new Map();
  if (loadResp.ok) {
    const lLines  = (await loadResp.text()).trim().split("\n");
    const lHeader = lLines[0].split(",");
    const lName   = lHeader.findIndex((h) => h.replace(/"/g, "").trim().toLowerCase() === "name");
    const lLoad   = lHeader.findIndex((h) => h.replace(/"/g, "").trim().toLowerCase() === "load");
    if (lName !== -1 && lLoad !== -1) {
      for (let i = 1; i < lLines.length; i++) {
        const cols = lLines[i].split(",");
        if (cols[lName]?.replace(/"/g, "").trim().toLowerCase() !== "n.y.c.") continue;
        const mw   = parseFloat(cols[lLoad]?.trim());
        const hour = nyisoHour(cols[0]?.trim() ?? "");
        if (!isNaN(mw) && hour !== null) loads.set(hour, mw);
      }
    }
  }

  return { prices, loads };
}

// ── Boston: ISO-NE prices (public RT prelim CSV) ──────────────────────────────
// URL: https://www.iso-ne.com/static-transform/csv/histRpts/rt-lmp/lmp_rt_prelim_{YYYYMMDD}.csv
// Columns: "D","MM/DD/YYYY","HE","LocationName",LMP,Energy,Congestion,Loss
// HE = Hour Ending 1–24; one row per location per hour; no public load data.

async function fetchBostonData(yyyymmdd: string): Promise<{ prices: HourPrices; loads: HourLoads }> {
  const url  = `https://www.iso-ne.com/static-transform/csv/histRpts/rt-lmp/lmp_rt_prelim_${yyyymmdd}.csv`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ISO-NE RT HTTP ${resp.status}`);

  const lines  = (await resp.text()).split("\n");
  const prices: HourPrices = new Map();
  for (const line of lines) {
    if (!line.includes(".Z.NEMASSBOST")) continue;
    const cols = line.replace(/"/g, "").split(",");
    const he   = parseInt(cols[2]?.trim());
    const lmp  = parseFloat(cols[4]?.trim());
    if (isNaN(he) || isNaN(lmp)) continue;
    const hour   = he - 1; // HE 1 = hour 0 (midnight–1 AM)
    const bucket = prices.get(hour) ?? { sum: 0, count: 0 };
    prices.set(hour, { sum: bucket.sum + lmp, count: bucket.count + 1 });
  }
  if (prices.size === 0) throw new Error("No NEMASSBOST rows in ISO-NE RT CSV");

  return { prices, loads: new Map() }; // no public load data; lwap() falls back to simple avg
}

// ── Bay Area: CAISO prices + actual system demand ─────────────────────────────

async function fetchBayAreaData(yyyymmdd: string): Promise<{ prices: HourPrices; loads: HourLoads }> {
  const offset = ptOffset();
  const y  = yyyymmdd.slice(0, 4);
  const m  = yyyymmdd.slice(4, 6);
  const d  = yyyymmdd.slice(6, 8);
  const tz = `${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;

  const priceUrl = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP` +
    `&startdatetime=${y}${m}${d}T00:00${tz}&enddatetime=${y}${m}${d}T23:55${tz}` +
    `&version=1&market_run_id=RTM&node=TH_NP15_GEN-APND&resultformat=6`;

  const loadUrl = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=SLD_FCST` +
    `&startdatetime=${y}${m}${d}T00:00${tz}&enddatetime=${y}${m}${d}T23:55${tz}` +
    `&version=1&market_run_id=ACTUAL&resultformat=6`;

  const [priceCsv, loadResult] = await Promise.all([
    unzipCAISO(priceUrl),
    unzipCAISO(loadUrl).catch(() => null), // load fetch failure is non-fatal
  ]);

  // --- 5-min prices ---
  const pLines  = priceCsv.trim().split("\n");
  const pHeader = pLines[0].split(",").map((h) => h.trim());
  const ltIdx   = pHeader.indexOf("LMP_TYPE");
  const mwIdx   = pHeader.indexOf("MW");
  const hrIdx   = pHeader.indexOf("OPR_HR");
  if (ltIdx === -1 || mwIdx === -1 || hrIdx === -1) throw new Error("Unexpected CAISO price CSV format");

  const prices: HourPrices = new Map();
  for (let i = 1; i < pLines.length; i++) {
    const cols = pLines[i].split(",");
    if (cols[ltIdx]?.trim() !== "LMP") continue;
    const price   = parseFloat(cols[mwIdx]?.trim());
    const oprHr   = parseInt(cols[hrIdx]?.trim() ?? "0");
    const hour    = oprHr - 1; // OPR_HR is 1-indexed; convert to 0-23
    if (isNaN(price) || oprHr < 1) continue;
    const bucket  = prices.get(hour) ?? { sum: 0, count: 0 };
    prices.set(hour, { sum: bucket.sum + price, count: bucket.count + 1 });
  }
  if (prices.size === 0) throw new Error("No Bay Area price rows in CAISO CSV");

  // --- 5-min actual system demand → hourly averages ---
  const loads: HourLoads = new Map();
  if (loadResult) {
    const lLines  = loadResult.trim().split("\n");
    const lHeader = lLines[0].split(",").map((h) => h.trim());
    const lMwIdx  = lHeader.indexOf("MW");
    const lHrIdx  = lHeader.indexOf("OPR_HR");
    if (lMwIdx !== -1 && lHrIdx !== -1) {
      // Accumulate 5-min intervals per hour, then average to get hourly load
      const hourBuckets = new Map<number, { sum: number; count: number }>();
      for (let i = 1; i < lLines.length; i++) {
        const cols  = lLines[i].split(",");
        const mw    = parseFloat(cols[lMwIdx]?.trim());
        const oprHr = parseInt(cols[lHrIdx]?.trim() ?? "0");
        const hour  = oprHr - 1;
        if (isNaN(mw) || oprHr < 1) continue;
        const b = hourBuckets.get(hour) ?? { sum: 0, count: 0 };
        hourBuckets.set(hour, { sum: b.sum + mw, count: b.count + 1 });
      }
      for (const [h, { sum, count }] of hourBuckets) {
        loads.set(h, sum / count);
      }
    }
  }

  return { prices, loads };
}

// ── settlement DB helper ──────────────────────────────────────────────────────

async function settleMarket(node: string, displayDate: string, settlementValue: number) {
  const mkt = await pool.query(
    `SELECT market_id, threshold FROM markets
     WHERE resolution_date = $1 AND node = $2 AND status = 'open'`,
    [displayDate, node]
  );
  if (mkt.rows.length === 0) return { skipped: true, reason: "no open market" };

  const { market_id, threshold: rawThreshold } = mkt.rows[0];
  const threshold = parseFloat(rawThreshold);
  const sv        = parseFloat(settlementValue.toFixed(4));
  const yesWins   = sv > threshold;
  const winnerCol = yesWins ? "yes_qty" : "no_qty";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE profile
       SET cash_balance = cash_balance + (
         SELECT ${winnerCol} FROM positions
         WHERE positions.user_id = profile.user_id AND positions.market_id = $1
       )
       WHERE user_id IN (SELECT user_id FROM positions WHERE market_id = $1)`,
      [market_id]
    );
    await client.query(
      `UPDATE markets SET status = 'settled', settlement_value = $1 WHERE market_id = $2`,
      [sv, market_id]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { skipped: false, threshold, settlement_value: sv, yes_wins: yesWins };
}

// ── handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const now       = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yyyymmdd    = yesterday.toISOString().slice(0, 10).replace(/-/g, "");
    const displayDate = yesterday.toISOString().slice(0, 10);

    // Fetch price + load data for all 3 nodes in parallel
    const [nycDataR, bostonDataR, bayAreaDataR] = await Promise.allSettled([
      fetchNYCData(yyyymmdd),
      fetchBostonData(yyyymmdd),
      fetchBayAreaData(yyyymmdd),
    ]);

    // Compute LWAP and settle each market
    const [nycR, bostonR, bayAreaR] = await Promise.allSettled([
      nycDataR.status === "fulfilled"
        ? settleMarket("N.Y.C.", displayDate,
            lwap(nycDataR.value.prices, nycDataR.value.loads))
        : Promise.reject(nycDataR.reason),
      bostonDataR.status === "fulfilled"
        ? settleMarket(".Z.NEMASSBOST", displayDate,
            lwap(bostonDataR.value.prices, bostonDataR.value.loads))
        : Promise.reject(bostonDataR.reason),
      bayAreaDataR.status === "fulfilled"
        ? settleMarket("TH_NP15_GEN-APND", displayDate,
            lwap(bayAreaDataR.value.prices, bayAreaDataR.value.loads))
        : Promise.reject(bayAreaDataR.reason),
    ]);

    // Build response — include load availability info for observability
    function summary(dataR: typeof nycDataR, settleR: typeof nycR) {
      if (settleR.status === "fulfilled") {
        const loadCount = dataR.status === "fulfilled"
          ? dataR.value.loads.size : 0;
        return { ...settleR.value, load_hours_used: loadCount };
      }
      return { error: String(settleR.reason) };
    }

    return NextResponse.json({
      success: true,
      date: displayDate,
      method: "lwap",
      markets: {
        nyc:     summary(nycDataR,     nycR),
        boston:  summary(bostonDataR,  bostonR),
        bayArea: summary(bayAreaDataR, bayAreaR),
      },
    });
  } catch (err) {
    console.error("settle-market error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
