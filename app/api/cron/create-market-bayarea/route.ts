import { NextResponse } from "next/server";
import pool from "@/lib/db";
import AdmZip from "adm-zip";

// POST /api/cron/create-market-bayarea
// Called at ~4:30 PM ET each day.
// CAISO DAM results publish at ~1 PM PT (4 PM ET), so this fires after they're live.
// Creates the Bay Area market for tomorrow's operating day.
// Threshold = average of all 24 hourly DA prices for TH_NP15_GEN-APND.

function ptOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -7 : -8;
}

async function fetchBayAreaThreshold(yyyymmdd: string): Promise<number> {
  const offset = ptOffset();
  const y  = yyyymmdd.slice(0, 4);
  const m  = yyyymmdd.slice(4, 6);
  const d  = yyyymmdd.slice(6, 8);
  const tz = `${offset < 0 ? "-" : "+"}${String(Math.abs(offset)).padStart(2, "0")}:00`;
  const url = `https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_LMP` +
    `&startdatetime=${y}${m}${d}T00:00${tz}&enddatetime=${y}${m}${d}T23:59${tz}` +
    `&version=1&market_run_id=DAM&node=TH_NP15_GEN-APND&resultformat=6`;

  const resp  = await fetch(url);
  if (!resp.ok) throw new Error(`CAISO HTTP ${resp.status}`);
  const buf   = Buffer.from(await resp.arrayBuffer());
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    const preview = buf.slice(0, 200).toString("utf8");
    throw new Error(`CAISO response is not a ZIP. Preview: ${preview}`);
  }
  const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
  if (!entry) throw new Error("No CSV in CAISO zip");
  const csv    = zip.readAsText(entry);
  const lines  = csv.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim());
  const ltIdx  = header.indexOf("LMP_TYPE");
  const mwIdx  = header.indexOf("MW");
  if (ltIdx === -1 || mwIdx === -1) throw new Error(`Unexpected CAISO DAM CSV format. Headers: ${lines[0]}`);

  const prices: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols[ltIdx]?.trim() !== "LMP") continue;
    const p = parseFloat(cols[mwIdx]?.trim());
    if (!isNaN(p)) prices.push(p);
  }
  if (prices.length === 0) throw new Error("No Bay Area rows in CAISO DAM CSV");
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

export async function POST(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("x-cron-secret") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const now      = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yyyymmdd    = tomorrow.toISOString().slice(0, 10).replace(/-/g, "");
    const displayDate = tomorrow.toISOString().slice(0, 10);
    const humanDate   = new Intl.DateTimeFormat("en-US", {
      month: "long", day: "numeric", year: "numeric",
    }).format(tomorrow);

    const existing = await pool.query(
      `SELECT market_id FROM markets WHERE resolution_date = $1 AND node = 'TH_NP15_GEN-APND'`,
      [displayDate]
    );
    if (existing.rows.length > 0) {
      return NextResponse.json({ message: "Bay Area market already exists.", date: displayDate });
    }

    const threshold = parseFloat((await fetchBayAreaThreshold(yyyymmdd)).toFixed(2));

    await pool.query(
      `INSERT INTO markets
         (market_id, name, description, node, resolution_date, threshold, direction, status, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'TH_NP15_GEN-APND', $3, $4, 'higher', 'open', NOW())`,
      [
        `Bay Area Average RT — ${humanDate}`,
        `Will the Bay Area Average RT 24-hr average RT price exceed $${threshold.toFixed(2)}/MWh?`,
        displayDate,
        threshold,
      ]
    );

    return NextResponse.json({ success: true, date: displayDate, threshold });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("create-market-bayarea error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
