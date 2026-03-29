import { NextResponse } from "next/server";
import pool from "@/lib/db";

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

async function fetchNYCThreshold(yyyymmdd: string): Promise<number> {
  const url  = `https://mis.nyiso.com/public/csv/damlbmp/${yyyymmdd}damlbmp_zone.csv`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`NYISO DAM HTTP ${resp.status}`);
  const lines  = (await resp.text()).trim().split("\n");
  const strip  = (s: string) => s.trim().replace(/"/g, "");
  const header = lines[0].split(",");
  const nameIdx = header.findIndex((h) => strip(h).toLowerCase() === "name");
  const lbmpIdx = header.findIndex((h) => strip(h).toLowerCase().startsWith("lbmp"));
  if (nameIdx === -1 || lbmpIdx === -1) throw new Error("Unexpected NYISO DAM CSV format");
  const prices: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (strip(cols[nameIdx] ?? "").toLowerCase() !== "n.y.c.") continue;
    const p = parseFloat(cols[lbmpIdx]?.trim());
    if (!isNaN(p)) prices.push(p);
  }
  if (prices.length === 0) throw new Error("No NYC rows in NYISO DAM CSV");
  return prices.reduce((a, b) => a + b, 0) / prices.length;
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
) {
  const existing = await pool.query(
    `SELECT market_id FROM markets WHERE resolution_date = $1 AND node = $2`,
    [displayDate, node]
  );
  if (existing.rows.length > 0) return { skipped: true, threshold };

  await pool.query(
    `INSERT INTO markets
       (market_id, name, description, node, resolution_date, threshold, direction, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'higher', 'open', NOW())`,
    [
      `${displayName} — ${humanDate}`,
      `Will the ${displayName} 24-hr average RT price exceed $${threshold.toFixed(2)}/MWh?`,
      node,
      displayDate,
      threshold,
    ]
  );
  return { skipped: false, threshold };
}

// ── handler ───────────────────────────────────────────────────────────────────

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

    const [nycR, bostonR] = await Promise.allSettled([
      fetchNYCThreshold(yyyymmdd).then((t) =>
        upsertMarket("N.Y.C.", "NYC Average RT", parseFloat(t.toFixed(2)), displayDate, humanDate)
      ),
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
