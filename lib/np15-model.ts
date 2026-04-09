/**
 * NP15 (TH_NP15_GEN-APND) DART Logistic Regression scorer.
 * Loads pre-trained weights from np15-model-weights.json.
 * Uses the same 18-feature schema as NYC/BOS, but computeRunningInputs
 * uses Pacific Time for the current-hour DAM price lookup.
 */

import np15Weights from "./np15-model-weights.json";
import type { DamFeatures, NYCModelInputs } from "./nyc-model";

export { computeDamFeatures, buildFeatureVector } from "./nyc-model";
export type { DamFeatures, NYCModelInputs };

const { scaler_mean, scaler_scale, coef, intercept } = np15Weights;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function scoreNP15Model(features: number[]): number {
  if (features.length !== coef.length) {
    throw new Error(`NP15 model: expected ${coef.length} features, got ${features.length}`);
  }
  let dot = intercept;
  for (let i = 0; i < features.length; i++) {
    const z = (features[i] - scaler_mean[i]) / scaler_scale[i];
    dot += z * coef[i];
  }
  return sigmoid(dot);
}

/**
 * Same as computeRunningInputs in nyc-model.ts, but uses Pacific Time
 * for the current-hour DAM price lookup (NP15 operating day is in PT).
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

  const rt_avg_so_far = rtPricesSoFar.length > 0 ? avg(rtPricesSoFar) : dam.dam_daily_avg;

  const implied_remaining_avg =
    intervals_remaining > 0
      ? (dam.dam_daily_avg * TOTAL_INTERVALS - rt_avg_so_far * intervals_elapsed) /
        intervals_remaining
      : rt_avg_so_far;

  // Use Pacific Time for current hour — NP15 DAM prices are indexed by PT hour
  const ptNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
  );
  const currentHourEnding = ptNow.getHours() === 0 ? 24 : ptNow.getHours();
  const dam_price = dam.hourly_dam_prices[currentHourEnding - 1] ?? dam.dam_daily_avg;

  const d = new Date(operatingDate + "T12:00:00");
  const day_of_week = (d.getDay() + 6) % 7;
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
