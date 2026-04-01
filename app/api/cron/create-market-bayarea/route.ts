import { NextResponse } from "next/server";
import pool from "@/lib/db";
import AdmZip from "adm-zip";

// GET /api/cron/create-market-bayarea
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

  const resp  = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OnPeak/1.0)" },
  });
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
  // When CAISO has no data for the requested date it still returns a ZIP,
  // but the files inside contain XML error documents despite having .csv
  // extensions.  Detect this and surface a clear error.
  if (csv.trimStart().startsWith("<?xml")) {
    throw new Error(`CAISO returned no data for ${yyyymmdd} (XML error response). Preview: ${csv.slice(0, 300)}`);
  }
  const lines  = csv.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim());
  const ltIdx  = header.indexOf("LMP_TYPE");
  const mwIdx  = header.indexOf("MW");
  if (ltIdx === -1 || mwIdx === -1) throw new Error("Unexpected CAISO DAM CSV format");

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

export async function POST(req: Request) { return handler(req); }
export async function GET(req: Request) { return handler(req); }
async function handler(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Optional ?date=YYYY-MM-DD override for manual backfill
    const url          = new URL(req.url);
    const dateOverride = url.searchParams.get("date");

    let displayDate: string;
    let yyyymmdd: string;
    let humanDate: string;

    if (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
      displayDate = dateOverride;
      yyyymmdd    = dateOverride.replace(/-/g, "");
      humanDate   = new Intl.DateTimeFormat("en-US", {
        month: "long", day: "numeric", year: "numeric",
      }).format(new Date(dateOverride + "T12:00:00Z"));
    } else {
      // Compute "tomorrow in PT" — toISOString() uses UTC, so after 8 PM ET
      // (midnight UTC) the UTC date has already rolled over and +1 would
      // request a date whose CAISO DAM data isn't published yet.
      const offset     = ptOffset();
      const ptNow      = new Date(Date.now() + offset * 3_600_000);
      const ptTomorrow = new Date(ptNow.getTime() + 86_400_000);
      yyyymmdd    = ptTomorrow.toISOString().slice(0, 10).replace(/-/g, "");
      displayDate = ptTomorrow.toISOString().slice(0, 10);
      humanDate   = new Intl.DateTimeFormat("en-US", {
        month: "long", day: "numeric", year: "numeric",
      }).format(new Date(displayDate + "T12:00:00Z"));
    }

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
        `NorCal Hub Average RT — ${humanDate}`,
        `Will the NorCal Hub Average RT 24-hr average RT price exceed $${threshold.toFixed(2)}/MWh?`,
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
