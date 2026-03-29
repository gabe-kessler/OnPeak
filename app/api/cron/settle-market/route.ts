import { NextResponse } from "next/server";
import pool from "@/lib/db";
import AdmZip from "adm-zip";

// POST /api/cron/settle-market
// Called at 12:05 AM ET each day.
//
// Settlement uses a simple arithmetic average of all 5-minute RT prices.
//
// Price sources:
//   NYC      — NYISO public RT daily zone CSV  (5-min intervals)
//   Boston   — ISO-NE public RT prelim CSV     (hourly, HE 1-24)
//   Bay Area — CAISO OASIS PRC_INTVL_LMP RTM  (5-min intervals)

// ── shared types / helpers ────────────────────────────────────────────────────

// Map of operating-hour (0-23) → { sum of prices, count }
type HourPrices = Map<number, { sum: number; count: number }>;

function simpleAvg(prices: HourPrices): number {
  let sum = 0, count = 0;
  for (const { sum: s, count: c } of prices.values()) { sum += s; count += c; }
  return count > 0 ? sum / count : 0;
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

// ── NYC: NYISO 5-min RT prices ────────────────────────────────────────────────

async function fetchNYCPrices(yyyymmdd: string): Promise<HourPrices> {
  const resp = await fetch(`https://mis.nyiso.com/public/csv/realtime/${yyyymmdd}realtime_zone.csv`);
  if (!resp.ok) throw new Error(`NYISO RT HTTP ${resp.status}`);

  const pLines  = (await resp.text()).trim().split("\n");
  const strip   = (s: string) => s.trim().replace(/"/g, "");
  const pHeader = pLines[0].split(",");
  const pName   = pHeader.findIndex((h) => strip(h).toLowerCase() === "name");
  const pLbmp   = pHeader.findIndex((h) => strip(h).toLowerCase().startsWith("lbmp"));
  if (pName === -1 || pLbmp === -1) throw new Error("Unexpected NYISO RT CSV format");

  const prices: HourPrices = new Map();
  for (let i = 1; i < pLines.length; i++) {
    const cols = pLines[i].split(",");
    if (strip(cols[pName] ?? "").toLowerCase() !== "n.y.c.") continue;
    const price = parseFloat(cols[pLbmp]?.trim());
    const hour  = nyisoHour(cols[0]?.trim() ?? "");
    if (isNaN(price) || hour === null) continue;
    const bucket = prices.get(hour) ?? { sum: 0, count: 0 };
    prices.set(hour, { sum: bucket.sum + price, count: bucket.count + 1 });
  }
  if (prices.size === 0) throw new Error("No NYC price rows in NYISO RT CSV");
  return prices;
}

// ── Boston: ISO-NE hourly RT prices ──────────────────────────────────────────
// URL: https://www.iso-ne.com/static-transform/csv/histRpts/rt-lmp/lmp_rt_prelim_{YYYYMMDD}.csv
// Columns: "D","MM/DD/YYYY","HE","LocationName",LMP,Energy,Congestion,Loss
// HE = Hour Ending 1–24; one row per location per hour.

async function fetchBostonPrices(yyyymmdd: string): Promise<HourPrices> {
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
    const hour   = he - 1;
    const bucket = prices.get(hour) ?? { sum: 0, count: 0 };
    prices.set(hour, { sum: bucket.sum + lmp, count: bucket.count + 1 });
  }
  if (prices.size === 0) throw new Error("No NEMASSBOST rows in ISO-NE RT CSV");
  return prices;
}

// ── Bay Area: CAISO 5-min RT prices ──────────────────────────────────────────

async function fetchBayAreaPrices(yyyymmdd: string): Promise<HourPrices> {
  const offset = ptOffset();
  const y  = yyyymmdd.slice(0, 4);
  const m  = yyyymmdd.slice(4, 6);
  const d  = yyyymmdd.slice(6, 8);
  const tz = `${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;

  const priceUrl = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP` +
    `&startdatetime=${y}${m}${d}T00:00${tz}&enddatetime=${y}${m}${d}T23:55${tz}` +
    `&version=1&market_run_id=RTM&node=TH_NP15_GEN-APND&resultformat=6`;

  const priceCsv = await unzipCAISO(priceUrl);
  const pLines   = priceCsv.trim().split("\n");
  const pHeader  = pLines[0].split(",").map((h) => h.trim());
  const ltIdx    = pHeader.indexOf("LMP_TYPE");
  const mwIdx    = pHeader.indexOf("MW");
  const hrIdx    = pHeader.indexOf("OPR_HR");
  if (ltIdx === -1 || mwIdx === -1 || hrIdx === -1) throw new Error("Unexpected CAISO price CSV format");

  const prices: HourPrices = new Map();
  for (let i = 1; i < pLines.length; i++) {
    const cols  = pLines[i].split(",");
    if (cols[ltIdx]?.trim() !== "LMP") continue;
    const price = parseFloat(cols[mwIdx]?.trim());
    const oprHr = parseInt(cols[hrIdx]?.trim() ?? "0");
    const hour  = oprHr - 1;
    if (isNaN(price) || oprHr < 1) continue;
    const bucket = prices.get(hour) ?? { sum: 0, count: 0 };
    prices.set(hour, { sum: bucket.sum + price, count: bucket.count + 1 });
  }
  if (prices.size === 0) throw new Error("No Bay Area price rows in CAISO CSV");
  return prices;
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
  if (req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const now       = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yyyymmdd    = yesterday.toISOString().slice(0, 10).replace(/-/g, "");
    const displayDate = yesterday.toISOString().slice(0, 10);

    const [nycR, bostonR, bayAreaR] = await Promise.allSettled([
      fetchNYCPrices(yyyymmdd).then(p => settleMarket("N.Y.C.",           displayDate, simpleAvg(p))),
      fetchBostonPrices(yyyymmdd).then(p => settleMarket(".Z.NEMASSBOST", displayDate, simpleAvg(p))),
      fetchBayAreaPrices(yyyymmdd).then(p => settleMarket("TH_NP15_GEN-APND", displayDate, simpleAvg(p))),
    ]);

    function summary(r: typeof nycR) {
      return r.status === "fulfilled" ? r.value : { error: String(r.reason) };
    }

    return NextResponse.json({
      success: true,
      date: displayDate,
      method: "simple_avg",
      markets: {
        nyc:     summary(nycR),
        boston:  summary(bostonR),
        bayArea: summary(bayAreaR),
      },
    });
  } catch (err) {
    console.error("settle-market error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
