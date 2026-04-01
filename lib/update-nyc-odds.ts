import pool from "./db";
import {
  computeRunningInputs,
  buildFeatureVector,
  scoreNYCModel,
  type DamFeatures,
} from "./nyc-model";

// Reusable core logic for updating model_prob on all open NYC markets resolving today.
// Called from /api/cron/update-nyc-odds (manual trigger) and piggybacked on
// /api/prices/all (fires every 5 min as part of the RT price refresh cycle).
export async function updateNYCOdds(): Promise<{ updated: number; markets: object[] }> {
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());

  const markets = await pool.query(
    `SELECT market_id, resolution_date, dam_features
     FROM markets
     WHERE node = 'N.Y.C.'
       AND status = 'open'
       AND resolution_date = $1
       AND dam_features IS NOT NULL`,
    [todayET]
  );

  if (markets.rows.length === 0) {
    return { updated: 0, markets: [] };
  }

  const results: object[] = [];

  for (const row of markets.rows) {
    try {
      const dam = row.dam_features as DamFeatures;
      const operatingDate: string =
        row.resolution_date instanceof Date
          ? row.resolution_date.toISOString().slice(0, 10)
          : String(row.resolution_date);

      const snapshotRows = await pool.query(
        `SELECT CAST(price AS float) AS price
         FROM price_snapshots
         WHERE node_id = 'NYISO_N.Y.C.'
           AND DATE(recorded_at AT TIME ZONE 'America/New_York') = $1
         ORDER BY recorded_at ASC`,
        [operatingDate]
      );

      const rtPrices: number[] = snapshotRows.rows.map(
        (r: { price: number }) => r.price
      );

      const inputs = computeRunningInputs(rtPrices, dam, operatingDate);
      const modelProb = parseFloat(
        scoreNYCModel(buildFeatureVector(inputs)).toFixed(4)
      );

      await pool.query(
        `UPDATE markets SET model_prob = $1 WHERE market_id = $2`,
        [modelProb, row.market_id]
      );

      results.push({
        market_id: row.market_id,
        intervals_elapsed: inputs.intervals_elapsed,
        rt_avg_so_far: parseFloat(inputs.rt_avg_so_far.toFixed(2)),
        model_prob: modelProb,
      });
    } catch (err) {
      results.push({ market_id: row.market_id, error: String(err) });
    }
  }

  return { updated: results.length, markets: results };
}
