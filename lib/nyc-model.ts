/**
 * NYC DART Logistic Regression scorer — v3.
 *
 * v3 changes vs v2:
 *  - 6 new intraday features (all scale-invariant):
 *      rt_vol_pct      — cumulative std of RT / dam_daily_avg
 *      rt_momentum     — avg(last 12) - avg(first 12) RT / dam_avg
 *      rt_recent_pct   — avg(last 6 intervals, 30 min) / dam_avg - 1
 *      rt_vs_sched_pct — RT avg vs avg scheduled DAM for elapsed intervals
 *      elapsed_x_rt    — pct_day_elapsed × rt_vs_sched_pct (amplifies signal over time)
 *      dam_onpeak_frac — dam_onpeak_avg / dam_daily_avg (on-peak dominance)
 *  - Training extended to 2019-2024 (relative features generalise across price epochs)
 *  - Result: +7pp at open, +3pp at 75% elapsed vs v2
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
  // v3 intraday features
  rt_vol_pct:          number;   // cumulative std of RT prices / dam_daily_avg
  rt_momentum:         number;   // avg(last k RT) - avg(first k RT) / dam_avg
  rt_recent_pct:       number;   // avg(last 6 intervals) / dam_avg - 1
  rt_vs_sched_pct:     number;   // (rt_avg - avg_dam_for_elapsed_hours) / dam_avg
  elapsed_x_rt:        number;   // pct_day_elapsed * rt_vs_sched_pct
  dam_onpeak_frac:     number;   // dam_onpeak_avg / dam_daily_avg
  // extra fields for logging (not model features)
  intervals_elapsed:   number;
  rt_avg_so_far:       number;
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
    // v3 new features — must match FEATURES_V3 order in retrain_nyc_v3.py
    inputs.rt_vol_pct,
    inputs.rt_momentum,
    inputs.rt_recent_pct,
    inputs.rt_vs_sched_pct,
    inputs.elapsed_x_rt,
    inputs.dam_onpeak_frac,
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

  const dam_avg = dam.dam_daily_avg || 1e-9;
  const rt_avg  = n > 0 ? avgArr(rtPricesSoFar) : dam_avg;
  const implied = remaining > 0
    ? (dam_avg * TOTAL_INTERVALS - rt_avg * n) / remaining
    : rt_avg;

  // ── core v2 features ──────────────────────────────────────────────────────
  const rt_vs_dam_pct      = (rt_avg  - dam_avg) / dam_avg;
  const implied_vs_dam_pct = (implied - dam_avg) / dam_avg;
  const prior_rt_pct       = dam.prior_rt_post1pm_avg / dam_avg;
  const dam_max_over_avg   = dam.dam_max_price / dam_avg;

  const d          = new Date(operatingDate + "T12:00:00");
  const day_of_week = (d.getDay() + 6) % 7;  // 0=Mon…6=Sun
  const month       = d.getMonth() + 1;

  // ── v3 intraday features ──────────────────────────────────────────────────
  // rt_vol_pct: cumulative std of RT so far / dam_avg
  let rt_vol_pct = 0;
  if (n > 1) {
    const mean = rt_avg;
    const variance = rtPricesSoFar.reduce((s, p) => s + (p - mean) ** 2, 0) / n;
    rt_vol_pct = Math.sqrt(variance) / dam_avg;
  }

  // rt_momentum: avg(last k) - avg(first k) / dam_avg
  const k = Math.min(12, Math.max(1, Math.floor(n / 4)));
  const avgFirst = n > 0 ? avgArr(rtPricesSoFar.slice(0, k))  : dam_avg;
  const avgLast  = n > 0 ? avgArr(rtPricesSoFar.slice(-k))    : dam_avg;
  const rt_momentum = (avgLast - avgFirst) / dam_avg;

  // rt_recent_pct: avg(last 6 intervals = 30 min) / dam_avg - 1
  const recent6 = rtPricesSoFar.slice(-6);
  const rt_recent_pct = recent6.length > 0 ? avgArr(recent6) / dam_avg - 1 : 0;

  // rt_vs_sched_pct: rt_avg vs avg scheduled DAM for elapsed intervals
  // interval i → hour = floor(i/12) → dam.hourly_dam_prices[hour]
  let rt_vs_sched_pct = 0;
  if (n > 0 && dam.hourly_dam_prices && dam.hourly_dam_prices.length === 24) {
    let dam_elapsed_sum = 0;
    for (let i = 0; i < n; i++) {
      const hour = Math.min(Math.floor(i / 12), 23);
      dam_elapsed_sum += dam.hourly_dam_prices[hour];
    }
    const avg_dam_elapsed = dam_elapsed_sum / n;
    rt_vs_sched_pct = (rt_avg - avg_dam_elapsed) / dam_avg;
  }

  const pct_day_elapsed = n / TOTAL_INTERVALS;
  const elapsed_x_rt    = pct_day_elapsed * rt_vs_sched_pct;

  // dam_onpeak_frac: how dominant is the on-peak period in today's DAM?
  const dam_onpeak_frac = dam.dam_onpeak_avg / dam_avg;

  return {
    dam_daily_avg:       dam_avg,
    dam_peak_ratio:      dam.dam_peak_ratio,
    dam_max_over_avg,
    prior_rt_pct,
    prior_rt_volatility: dam.prior_rt_volatility,
    prior_rt_trend:      dam.prior_rt_trend,
    rt_vs_dam_pct,
    implied_vs_dam_pct,
    pct_day_elapsed,
    day_of_week,
    month,
    is_weekend:          day_of_week >= 5 ? 1 : 0,
    rt_vol_pct,
    rt_momentum,
    rt_recent_pct,
    rt_vs_sched_pct,
    elapsed_x_rt,
    dam_onpeak_frac,
    // logging fields
    intervals_elapsed:   n,
    rt_avg_so_far:       rt_avg,
  };
}
