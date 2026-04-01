import { NextResponse } from "next/server";
import pool from "@/lib/db";
import {
  computeDamFeatures,
  computeRunningInputs,
  buildFeatureVector,
  scoreNYCModel,
  type DamFeatures,
} from "@/lib/nyc-model";

// POST /api/cron/create-market
// Called at ~11:30 AM ET each day.
// Creates NYC and Boston markets for tomorrow's operating day.
// Threshold = average of all 24 hourly DA prices from each ISO's DAM auction.
// CAISO (Bay Area) DAM publishes at ~1 PM PT / 4 PM ET, so it has its own
// endpoint: /api/cron/create-market-bayarea (fired at 4:30 PM ET).
//
// Nodes:
//   NYC    — NYISO N.Y.C. zone     — public CSV, no auth
//   Boston — ISO-NE .Z.NEMASSBOST  — Basic Auth REST API

// ── per-ISO DAM threshold fetchers ───────────────────────────────────────────

// Returns { threshold (avg), hourlyPrices (HE1–HE24 in order) }
async function fetchNYCDAM(yyyymmdd: string): Promise<{ threshold: number; hourlyPrices: number[] }> {
  const url  = `https://mis.nyiso.com/public/csv/damlbmp/${yyyymmdd}damlbmp_zone.csv`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`NYISO DAM HTTP ${resp.status}`);
  const lines  = (await resp.text()).trim().split("\n");
  const strip  = (s: string) => s.trim().replace(/"/g, "");
  const header = lines[0].split(",");
  const nameIdx = header.findIndex((h) => strip(h).toLowerCase() === "name");
  const lbmpIdx = header.findIndex((h) => strip(h).toLowerCase().startsWith("lbmp"));
  const tsIdx   = 0; // timestamp is always first column
  if (nameIdx === -1 || lbmpIdx === -1) throw new Error("Unexpected NYISO DAM CSV format");

  // NYISO DAM CSV has one row per hour-ending; timestamp encodes the HE
  // e.g. "01/01/2025 00:00:00" = HE24 of prior day OR HE1 depending on convention.
  // We collect all NYC rows in CSV order (they are in HE order) and sort by HE.
  const heMap = new Map<number, number>();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (strip(cols[nameIdx] ?? "").toLowerCase() !== "n.y.c.") continue;
    const p = parseFloat(cols[lbmpIdx]?.trim());
    if (isNaN(p)) continue;
    // Parse hour from timestamp to determine HE
    const tsRaw = strip(cols[tsIdx] ?? "");
    const hrMatch = tsRaw.match(/\s+(\d+):/);
    const hr = hrMatch ? parseInt(hrMatch[1]) : -1; // 0–23 hour
    const he = hr === 0 ? 24 : hr; // HE24 is midnight (hour 0 of next day = midnight)
    heMap.set(he, p);
  }
  if (heMap.size === 0) throw new Error("No NYC rows in NYISO DAM CSV");

  // Build ordered array HE1–HE24; fall back to avg for any missing
  const hourlyPrices: number[] = [];
  for (let he = 1; he <= 24; he++) {
    hourlyPrices.push(heMap.get(he) ?? 0);
  }
  const threshold = hourlyPrices.reduce((a, b) => a + b, 0) / hourlyPrices.length;
  return { threshold, hourlyPrices };
}

// Fetch yesterday's NYC 5-min RT prices after 1 PM ET from price_snapshots
async function fetchPriorRtAfternoon(yesterdayDate: string): Promise<number[]> {
  try {
    const result = await pool.query(
      `SELECT CAST(price AS float) AS price
       FROM price_snapshots
       WHERE node_id = 'NYISO_N.Y.C.'
         AND DATE(recorded_at AT TIME ZONE 'America/New_York') = $1
         AND (recorded_at AT TIME ZONE 'America/New_York')::time >= '13:00:00'
       ORDER BY recorded_at ASC`,
      [yesterdayDate]
    );
    return result.rows.map((r: { price: number }) => r.price);
  } catch {
    return [];
  }
}

// ISO-NE publishes DA LMP as a public CSV — no auth required
// URL discovered from gridstatus open-source library
async function fetchBostonThreshold(yyyymmdd: string): Promise<number> {
  const url  = `https://www.iso-ne.com/static-transform/csv/histRpts/da-lmp/WW_DALMP_ISO_${yyyymmdd}.csv`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`ISO-NE DAM HTTP ${resp.status}`);
  const lines  = (await resp.text()).split("\n");
  // Columns: "D", Date, HE, LocationID, LocationName, LocationType, LMP, Energy, Congestion, Loss
  const prices = lines
    .filter((l) => l.includes(".Z.NEMASSBOST"))
    .map((l) => parseFloat(l.replace(/"/g, "").split(",")[6]))
    .filter((p) => !isNaN(p));
  if (prices.length === 0) throw new Error("No NEMASSBOST rows in ISO-NE DAM CSV");
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

// ── market insert helper ──────────────────────────────────────────────────────

async function upsertMarket(
  node: string,
  displayName: string,
  threshold: number,
  displayDate: string,
  humanDate: string,
  damFeatures?: DamFeatures,
  modelProb?: number,
) {
  const existing = await pool.query(
    `SELECT market_id FROM markets WHERE resolution_date = $1 AND node = $2`,
    [displayDate, node]
  );
  if (existing.rows.length > 0) return { skipped: true, threshold };

  await pool.query(
    `INSERT INTO markets
       (market_id, name, description, node, resolution_date, threshold, direction, status, created_at, dam_features, model_prob)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'higher', 'open', NOW(), $6, $7)`,
    [
      `${displayName} — ${humanDate}`,
      `Will the ${displayName} 24-hr average RT price exceed $${threshold.toFixed(2)}/MWh?`,
      node,
      displayDate,
      threshold,
      damFeatures ? JSON.stringify(damFeatures) : null,
      modelProb ?? null,
    ]
  );
  return { skipped: false, threshold, model_prob: modelProb };
}

// ── handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) { return handler(req); }
export async function GET(req: Request) { return handler(req); }
async function handler(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
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

    // Yesterday's date string for prior RT lookup
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayDate = yesterday.toISOString().slice(0, 10);

    const [nycR, bostonR] = await Promise.allSettled([
      // NYC: fetch full DAM + prior RT → compute model features + initial odds
      (async () => {
        const { threshold, hourlyPrices } = await fetchNYCDAM(yyyymmdd);
        const priorRt = await fetchPriorRtAfternoon(yesterdayDate);
        const damFeatures = computeDamFeatures(hourlyPrices, priorRt);
        // At market creation, no RT has elapsed yet
        const inputs = computeRunningInputs([], damFeatures, displayDate);
        const modelProb = scoreNYCModel(buildFeatureVector(inputs));
        return upsertMarket(
          "N.Y.C.", "NYC Average RT",
          parseFloat(threshold.toFixed(2)),
          displayDate, humanDate,
          damFeatures,
          parseFloat(modelProb.toFixed(4)),
        );
      })(),
      fetchBostonThreshold(yyyymmdd).then((t) =>
        upsertMarket(".Z.NEMASSBOST", "Boston Average RT", parseFloat(t.toFixed(2)), displayDate, humanDate)
      ),
    ]);

    return NextResponse.json({
      success: true,
      date: displayDate,
      markets: {
        nyc:    nycR.status    === "fulfilled" ? nycR.value    : { error: String(nycR.reason) },
        boston: bostonR.status === "fulfilled" ? bostonR.value : { error: String(bostonR.reason) },
      },
    });
  } catch (err) {
    console.error("create-market error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
