import { NextResponse } from "next/server";
import pool from "@/lib/db";
import AdmZip from "adm-zip";
import {
  computeDamFeatures,
  computeRunningInputs,
  buildFeatureVector,
  scoreNP15Model,
} from "@/lib/np15-model";

// GET /api/cron/create-market-bayarea
// Called at ~4:30 PM ET each day.
// CAISO DAM results publish at ~1 PM PT (4 PM ET), so this fires after they're live.
// Creates the Bay Area market for tomorrow's operating day.
// Threshold = average of all 24 hourly DA prices for TH_NP15_GEN-APND.

function ptOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -7 : -8;
}

// Returns { threshold (avg), hourlyPrices (OPR_HR 1–24 in order) }
async function fetchBayAreaDAM(yyyymmdd: string): Promise<{ threshold: number; hourlyPrices: number[] }> {
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
  if (csv.trimStart().startsWith("<?xml")) {
    throw new Error(`CAISO returned no data for ${yyyymmdd} (XML error response). Preview: ${csv.slice(0, 300)}`);
  }
  const lines  = csv.trim().split("\n");
  const header = lines[0].split(",").map((h) => h.trim());
  const ltIdx  = header.indexOf("LMP_TYPE");
  const mwIdx  = header.indexOf("MW");
  const hrIdx  = header.indexOf("OPR_HR");
  if (ltIdx === -1 || mwIdx === -1 || hrIdx === -1) throw new Error("Unexpected CAISO DAM CSV format");

  const heMap = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols[ltIdx]?.trim() !== "LMP") continue;
    const hr = parseInt(cols[hrIdx]?.trim() ?? "");
    const p  = parseFloat(cols[mwIdx]?.trim());
    if (!isNaN(hr) && !isNaN(p)) heMap.set(hr, p);
  }
  if (heMap.size === 0) throw new Error("No Bay Area rows in CAISO DAM CSV");

  const hourlyPrices: number[] = [];
  for (let hr = 1; hr <= 24; hr++) {
    hourlyPrices.push(heMap.get(hr) ?? 0);
  }
  const threshold = hourlyPrices.reduce((a, b) => a + b, 0) / hourlyPrices.length;
  return { threshold, hourlyPrices };
}

// Fetch yesterday's NP15 5-min RT prices after 1 PM PT from price_snapshots
async function fetchNP15PriorRtAfternoon(yesterdayPT: string): Promise<number[]> {
  try {
    const result = await pool.query(
      `SELECT CAST(price AS float) AS price
       FROM price_snapshots
       WHERE node_id = 'CAISO_TH_NP15_GEN-APND'
         AND DATE(recorded_at AT TIME ZONE 'America/Los_Angeles') = $1
         AND (recorded_at AT TIME ZONE 'America/Los_Angeles')::time >= '13:00:00'
       ORDER BY recorded_at ASC`,
      [yesterdayPT]
    );
    return result.rows.map((r: { price: number }) => r.price);
  } catch {
    return [];
  }
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
    let yesterdayPT: string;

    if (dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) {
      displayDate = dateOverride;
      yyyymmdd    = dateOverride.replace(/-/g, "");
      humanDate   = new Intl.DateTimeFormat("en-US", {
        month: "long", day: "numeric", year: "numeric",
      }).format(new Date(dateOverride + "T12:00:00Z"));
      const prior = new Date(dateOverride + "T12:00:00Z");
      prior.setUTCDate(prior.getUTCDate() - 1);
      yesterdayPT = prior.toISOString().slice(0, 10);
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
      yesterdayPT = ptNow.toISOString().slice(0, 10);
    }

    const existing = await pool.query(
      `SELECT market_id, model_prob FROM markets WHERE resolution_date = $1 AND node = 'TH_NP15_GEN-APND'`,
      [displayDate]
    );
    if (existing.rows.length > 0) {
      // Backfill model_prob if missing
      if (existing.rows[0].model_prob == null) {
        const { threshold, hourlyPrices } = await fetchBayAreaDAM(yyyymmdd);
        const priorRt = await fetchNP15PriorRtAfternoon(yesterdayPT);
        const damFeatures = computeDamFeatures(hourlyPrices, priorRt);
        const inputs = computeRunningInputs([], damFeatures, displayDate);
        const modelProb = parseFloat(Math.max(0.02, Math.min(0.98, scoreNP15Model(buildFeatureVector(inputs)))).toFixed(4));
        await pool.query(
          `UPDATE markets SET model_prob = $1, dam_features = $2 WHERE resolution_date = $3 AND node = 'TH_NP15_GEN-APND'`,
          [modelProb, JSON.stringify(damFeatures), displayDate]
        );
        return NextResponse.json({ message: "Bay Area market backfilled with model_prob.", date: displayDate, model_prob: modelProb });
      }
      return NextResponse.json({ message: "Bay Area market already exists.", date: displayDate });
    }

    const { threshold: rawThreshold, hourlyPrices } = await fetchBayAreaDAM(yyyymmdd);
    const threshold = parseFloat(rawThreshold.toFixed(2));
    const priorRt = await fetchNP15PriorRtAfternoon(yesterdayPT);
    const damFeatures = computeDamFeatures(hourlyPrices, priorRt);
    const inputs = computeRunningInputs([], damFeatures, displayDate);
    const modelProb = parseFloat(Math.max(0.02, Math.min(0.98, scoreNP15Model(buildFeatureVector(inputs)))).toFixed(4));

    await pool.query(
      `INSERT INTO markets
         (market_id, name, description, node, resolution_date, threshold, direction, status, created_at, dam_features, model_prob)
       VALUES (gen_random_uuid(), $1, $2, 'TH_NP15_GEN-APND', $3, $4, 'higher', 'open', NOW(), $5, $6)`,
      [
        `NorCal Hub Average RT — ${humanDate}`,
        `Will the NorCal Hub Average RT 24-hr average RT price exceed $${threshold.toFixed(2)}/MWh?`,
        displayDate,
        threshold,
        JSON.stringify(damFeatures),
        modelProb,
      ]
    );

    return NextResponse.json({ success: true, date: displayDate, threshold, model_prob: modelProb });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("create-market-bayarea error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
