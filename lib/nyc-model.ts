/**
 * NYC DART Logistic Regression scorer — v2.
 *
 * v2 changes vs v1:
 *  - All dollar features replaced with relative (% of dam_daily_avg) versions
 *  - Removed dam_onpeak_avg, dam_offpeak_avg (caused out-of-distribution failures on
 *    high-price winter days where offpeak ≈ onpeak ≈ $113+)
 *  - Removed implied_remaining_avg in raw form; replaced with implied_vs_dam_pct
 *  - rt_avg_so_far replaced with rt_vs_dam_pct — scale-invariant DART signal
 *  - Trained on 2022-2025 only (higher-price years, more relevant distribution)
 *  - Stronger L2 regularization (C=0.1) to prevent large coefficients
 */

import weights from "./nyc-model-weights.json";

const { scaler_mean, scaler_scale, coef, intercept } = weights;

function sigmoid(x: number): number {
  if (x > 500) return 1;
  if (x < -500) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function scoreNYCModel(features: number[]): number {
  if (features.length !== coef.length) {
    throw new Error(`Expected ${coef.length} features, got ${features.length}`);
  }
  let dot = intercept;
  for (let i = 0; i < features.length; i++) {
    const z = (features[i] - scaler_mean[i]) / scaler_scale[i];
    dot += z * coef[i];
  }
  return sigmoid(dot);
}

export interface NYCModelInputs {
  dam_daily_avg:       number;
  dam_peak_ratio:      number;
  dam_max_over_avg:    number;   // dam_max_price / dam_daily_avg
  prior_rt_pct:        number;   // prior_rt_post1pm_avg / dam_daily_avg
  prior_rt_volatility: number;
  prior_rt_trend:      number;
  rt_vs_dam_pct:       number;   // (rt_avg_so_far - dam_daily_avg) / dam_daily_avg
  implied_vs_dam_pct:  number;   // (implied_remaining - dam_daily_avg) / dam_daily_avg
  pct_day_elapsed:     number;
  day_of_week:         number;   // 0=Mon … 6=Sun
  month:               number;   // 1–12
  is_weekend:          number;   // 0 or 1
}

export function buildFeatureVector(inputs: NYCModelInputs): number[] {
  return [
    inputs.dam_daily_avg,
    inputs.dam_peak_ratio,
    inputs.dam_max_over_avg,
    inputs.prior_rt_pct,
    inputs.prior_rt_volatility,
    inputs.prior_rt_trend,
    inputs.rt_vs_dam_pct,
    inputs.implied_vs_dam_pct,
    inputs.pct_day_elapsed,
    inputs.day_of_week,
    inputs.month,
    inputs.is_weekend,
  ];
}

/** Stored in markets.dam_features (JSONB) at market creation time. */
export interface DamFeatures {
  hourly_dam_prices:    number[];
  dam_daily_avg:        number;
  dam_onpeak_avg:       number;
  dam_offpeak_avg:      number;
  dam_peak_ratio:       number;
  dam_max_price:        number;
  prior_rt_post1pm_avg: number;
  prior_rt_volatility:  number;
  prior_rt_trend:       number;
}

export function computeDamFeatures(
  hourlyDamPrices: number[],
  priorRtPrices: number[],
): DamFeatures {
  const onPeak   = hourlyDamPrices.slice(6, 22);
  const offPeak  = [...hourlyDamPrices.slice(0, 6), ...hourlyDamPrices.slice(22, 24)];
  const avg      = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const std      = (arr: number[]) => {
    const m = avg(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
  };

  const dam_daily_avg   = avg(hourlyDamPrices);
  const dam_onpeak_avg  = avg(onPeak);
  const dam_offpeak_avg = avg(offPeak);

  const prior_rt_post1pm_avg = priorRtPrices.length > 0 ? avg(priorRtPrices) : 0;
  const prior_rt_volatility  = priorRtPrices.length > 1 ? std(priorRtPrices) : 0;
  const first10 = priorRtPrices.slice(0, 10);
  const last10  = priorRtPrices.slice(-10);
  const prior_rt_trend =
    first10.length > 0 && last10.length > 0 ? avg(last10) - avg(first10) : 0;

  return {
    hourly_dam_prices: hourlyDamPrices,
    dam_daily_avg,
    dam_onpeak_avg,
    dam_offpeak_avg,
    dam_peak_ratio: dam_offpeak_avg !== 0 ? dam_onpeak_avg / dam_offpeak_avg : 0,
    dam_max_price:  Math.max(...hourlyDamPrices),
    prior_rt_post1pm_avg,
    prior_rt_volatility,
    prior_rt_trend,
  };
}

export function computeRunningInputs(
  rtPricesSoFar: number[],
  dam: DamFeatures,
  operatingDate: string,
): NYCModelInputs {
  const TOTAL_INTERVALS = 288;
  const n         = rtPricesSoFar.length;
  const remaining = TOTAL_INTERVALS - n;

  const avgArr = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const dam_avg   = dam.dam_daily_avg || 1e-9;
  const rt_avg    = n > 0 ? avgArr(rtPricesSoFar) : dam_avg;
  const implied   = remaining > 0
    ? (dam_avg * TOTAL_INTERVALS - rt_avg * n) / remaining
    : rt_avg;

  const rt_vs_dam_pct      = (rt_avg  - dam_avg) / dam_avg;
  const implied_vs_dam_pct = (implied - dam_avg) / dam_avg;
  const prior_rt_pct       = dam.prior_rt_post1pm_avg / dam_avg;
  const dam_max_over_avg   = dam.dam_max_price / dam_avg;

  const d          = new Date(operatingDate + "T12:00:00");
  const day_of_week = (d.getDay() + 6) % 7;  // 0=Mon…6=Sun
  const month       = d.getMonth() + 1;

  return {
    dam_daily_avg:       dam_avg,
    dam_peak_ratio:      dam.dam_peak_ratio,
    dam_max_over_avg,
    prior_rt_pct,
    prior_rt_volatility: dam.prior_rt_volatility,
    prior_rt_trend:      dam.prior_rt_trend,
    rt_vs_dam_pct,
    implied_vs_dam_pct,
    pct_day_elapsed:     n / TOTAL_INTERVALS,
    day_of_week,
    month,
    is_weekend:          day_of_week >= 5 ? 1 : 0,
  };
}
