/**
 * NYC DART Logistic Regression scorer.
 * Loads pre-trained weights from nyc-model-weights.json and scores a feature
 * vector entirely in TypeScript — no Python, no external calls.
 *
 * Feature order must exactly match the training feature list in the JSON.
 */

import weights from "./nyc-model-weights.json";

const { scaler_mean, scaler_scale, coef, intercept } = weights;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Score a single feature vector and return P(RT daily avg > DAM daily avg).
 * Features must be in the same order as weights.features.
 */
export function scoreNYCModel(features: number[]): number {
  if (features.length !== coef.length) {
    throw new Error(
      `Expected ${coef.length} features, got ${features.length}`
    );
  }
  let dot = intercept;
  for (let i = 0; i < features.length; i++) {
    const z = (features[i] - scaler_mean[i]) / scaler_scale[i];
    dot += z * coef[i];
  }
  return sigmoid(dot);
}

/**
 * Build a feature vector from structured inputs.
 * All DAM fields come from the market's dam_features column.
 * RT fields are computed from today's price_snapshots rows.
 */
export interface NYCModelInputs {
  // Interval-level DAM price for the current hour (from dam_features.hourly_dam_prices)
  dam_price: number;
  // Day-level DAM fields (constants across the day, from dam_features)
  dam_daily_avg: number;
  dam_onpeak_avg: number;
  dam_offpeak_avg: number;
  dam_peak_ratio: number;
  dam_max_price: number;
  // Prior-day RT stats (constants across the day, from dam_features)
  prior_rt_post1pm_avg: number;
  prior_rt_volatility: number;
  prior_rt_trend: number;
  // Running RT stats (computed from today's snapshots)
  rt_avg_so_far: number;
  implied_remaining_avg: number;
  intervals_elapsed: number;
  intervals_remaining: number;
  pct_day_elapsed: number;
  // Calendar features
  day_of_week: number;  // 0=Mon … 6=Sun
  month: number;        // 1–12
  is_weekend: number;   // 0 or 1
  // Derived
  rt_vs_dam: number;    // rt_avg_so_far - dam_daily_avg
}

export function buildFeatureVector(inputs: NYCModelInputs): number[] {
  // Order must match weights.features exactly
  return [
    inputs.dam_price,
    inputs.dam_daily_avg,
    inputs.dam_onpeak_avg,
    inputs.dam_offpeak_avg,
    inputs.dam_peak_ratio,
    inputs.dam_max_price,
    inputs.prior_rt_post1pm_avg,
    inputs.prior_rt_volatility,
    inputs.prior_rt_trend,
    inputs.rt_avg_so_far,
    inputs.implied_remaining_avg,
    inputs.intervals_elapsed,
    inputs.intervals_remaining,
    inputs.pct_day_elapsed,
    inputs.day_of_week,
    inputs.month,
    inputs.is_weekend,
    inputs.rt_vs_dam,
  ];
}

/** Stored in markets.dam_features (JSONB) at market creation time. */
export interface DamFeatures {
  hourly_dam_prices: number[];   // index 0 = hour-ending 1, index 23 = hour-ending 24
  dam_daily_avg: number;
  dam_onpeak_avg: number;
  dam_offpeak_avg: number;
  dam_peak_ratio: number;
  dam_max_price: number;
  prior_rt_post1pm_avg: number;
  prior_rt_volatility: number;
  prior_rt_trend: number;
}

/**
 * Compute DamFeatures from raw inputs at market creation time.
 * hourlyDamPrices: array of 24 prices, index 0 = HE1, index 23 = HE24.
 * priorRtPrices: array of 5-min RT prices from yesterday afternoon (after 1 PM ET).
 */
export function computeDamFeatures(
  hourlyDamPrices: number[],
  priorRtPrices: number[],
): DamFeatures {
  // On-peak = HE7–HE22 (indices 6–21), off-peak = HE1–HE6 + HE23–HE24 (indices 0–5, 22–23)
  const onPeak  = hourlyDamPrices.slice(6, 22);
  const offPeak = [...hourlyDamPrices.slice(0, 6), ...hourlyDamPrices.slice(22, 24)];

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std = (arr: number[]) => {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  };

  const dam_daily_avg  = avg(hourlyDamPrices);
  const dam_onpeak_avg = avg(onPeak);
  const dam_offpeak_avg = avg(offPeak);

  // Prior RT stats
  const prior_rt_post1pm_avg = priorRtPrices.length > 0 ? avg(priorRtPrices) : 0;
  const prior_rt_volatility  = priorRtPrices.length > 1 ? std(priorRtPrices) : 0;

  // Trend = avg of last 10 intervals minus avg of first 10
  const first10 = priorRtPrices.slice(0, 10);
  const last10  = priorRtPrices.slice(-10);
  const prior_rt_trend =
    first10.length > 0 && last10.length > 0
      ? avg(last10) - avg(first10)
      : 0;

  return {
    hourly_dam_prices: hourlyDamPrices,
    dam_daily_avg,
    dam_onpeak_avg,
    dam_offpeak_avg,
    dam_peak_ratio: dam_offpeak_avg !== 0 ? dam_onpeak_avg / dam_offpeak_avg : 0,
    dam_max_price: Math.max(...hourlyDamPrices),
    prior_rt_post1pm_avg,
    prior_rt_volatility,
    prior_rt_trend,
  };
}

/**
 * Compute running RT model inputs from an ordered list of today's 5-min prices
 * and the stored DamFeatures. Call this every 5 minutes from the odds cron.
 *
 * @param rtPricesSoFar  Ordered array of RT prices from interval 1 to now
 * @param dam            Stored DamFeatures from the market row
 * @param operatingDate  "YYYY-MM-DD" of the operating day (ET)
 */
export function computeRunningInputs(
  rtPricesSoFar: number[],
  dam: DamFeatures,
  operatingDate: string,
): NYCModelInputs {
  const TOTAL_INTERVALS = 288;
  const intervals_elapsed   = rtPricesSoFar.length;
  const intervals_remaining = TOTAL_INTERVALS - intervals_elapsed;
  const pct_day_elapsed     = intervals_elapsed / TOTAL_INTERVALS;

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const rt_avg_so_far = avg(rtPricesSoFar);

  const implied_remaining_avg =
    intervals_remaining > 0
      ? (dam.dam_daily_avg * TOTAL_INTERVALS - rt_avg_so_far * intervals_elapsed) /
        intervals_remaining
      : rt_avg_so_far;

  // Current hour-ending (ET) → index into hourly_dam_prices
  // Hour-ending N covers the hour 00:00–01:00 ET for HE1, etc.
  // We pick whichever hour the current wall-clock is in.
  const etNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const currentHourEnding = etNow.getHours() === 0 ? 24 : etNow.getHours();
  const dam_price = dam.hourly_dam_prices[currentHourEnding - 1] ?? dam.dam_daily_avg;

  // Calendar features from operating date
  const d = new Date(operatingDate + "T12:00:00");
  const day_of_week = (d.getDay() + 6) % 7; // 0=Mon…6=Sun
  const month       = d.getMonth() + 1;
  const is_weekend  = day_of_week >= 5 ? 1 : 0;

  return {
    dam_price,
    dam_daily_avg:        dam.dam_daily_avg,
    dam_onpeak_avg:       dam.dam_onpeak_avg,
    dam_offpeak_avg:      dam.dam_offpeak_avg,
    dam_peak_ratio:       dam.dam_peak_ratio,
    dam_max_price:        dam.dam_max_price,
    prior_rt_post1pm_avg: dam.prior_rt_post1pm_avg,
    prior_rt_volatility:  dam.prior_rt_volatility,
    prior_rt_trend:       dam.prior_rt_trend,
    rt_avg_so_far,
    implied_remaining_avg,
    intervals_elapsed,
    intervals_remaining,
    pct_day_elapsed,
    day_of_week,
    month,
    is_weekend,
    rt_vs_dam: rt_avg_so_far - dam.dam_daily_avg,
  };
}
