import pool from "./db";
import {
  computeDamFeatures,
  computeRunningInputs,
  buildFeatureVector,
  scoreBOSModel,
  type DamFeatures,
} from "./bos-model";

// Reusable core logic for updating model_prob on open BOS markets.
// Mirrors update-nyc-odds.ts exactly, with BOS-specific node IDs and ET timezone.
export async function updateBOSOdds(): Promise<{ updated: number; markets: object[] }> {
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());

  const tomorrowET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date(Date.now() + 86_400_000));

  const rows = await pool.query(
    `SELECT market_id, resolution_date, dam_features
     FROM markets
     WHERE node = '.Z.NEMASSBOST'
       AND status = 'open'
       AND resolution_date IN ($1, $2)
       AND dam_features IS NOT NULL`,
    [todayET, tomorrowET]
  );

  if (rows.rows.length === 0) return { updated: 0, markets: [] };

  // Today's post-1 PM ET prices — used as prior_rt for tomorrow's market
  const priorRtRows = await pool.query(
    `SELECT CAST(price AS float) AS price
     FROM price_snapshots
     WHERE node_id = 'ISONE_.Z.NEMASSBOST'
       AND DATE(recorded_at AT TIME ZONE 'America/New_York') = $1
       AND (recorded_at AT TIME ZONE 'America/New_York')::time >= '13:00:00'
     ORDER BY recorded_at ASC`,
    [todayET]
  );
  const priorRtPrices: number[] = priorRtRows.rows.map((r: { price: number }) => r.price);

  const results: object[] = [];

  for (const row of rows.rows) {
    try {
      const operatingDate: string =
        row.resolution_date instanceof Date
          ? row.resolution_date.toISOString().slice(0, 10)
          : String(row.resolution_date);

      const isToday = operatingDate === todayET;

      let modelProb: number;
      let inputs;

      if (isToday) {
        const snapshotRows = await pool.query(
          `SELECT CAST(price AS float) AS price
           FROM price_snapshots
           WHERE node_id = 'ISONE_.Z.NEMASSBOST'
             AND DATE(recorded_at AT TIME ZONE 'America/New_York') = $1
           ORDER BY recorded_at ASC`,
          [operatingDate]
        );
        const rtPrices: number[] = snapshotRows.rows.map((r: { price: number }) => r.price);
        const dam = row.dam_features as DamFeatures;
        inputs = computeRunningInputs(rtPrices, dam, operatingDate);
        modelProb = parseFloat(Math.max(0.02, Math.min(0.98, scoreBOSModel(buildFeatureVector(inputs)))).toFixed(4));

        await pool.query(
          `UPDATE markets SET model_prob = $1 WHERE market_id = $2`,
          [modelProb, row.market_id]
        );
      } else {
        const existingDam = row.dam_features as DamFeatures;
        const updatedDam = computeDamFeatures(existingDam.hourly_dam_prices, priorRtPrices);
        inputs = computeRunningInputs([], updatedDam, operatingDate);
        modelProb = parseFloat(Math.max(0.02, Math.min(0.98, scoreBOSModel(buildFeatureVector(inputs)))).toFixed(4));

        await pool.query(
          `UPDATE markets SET model_prob = $1, dam_features = $2 WHERE market_id = $3`,
          [modelProb, JSON.stringify(updatedDam), row.market_id]
        );
      }

      await pool.query(
        `INSERT INTO market_prob_history (market_id, prob, recorded_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT DO NOTHING`,
        [row.market_id, modelProb]
      );

      results.push({
        market_id: row.market_id,
        operating_date: operatingDate,
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
