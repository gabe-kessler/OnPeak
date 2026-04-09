/**
 * NP15 (TH_NP15_GEN-APND) DART Logistic Regression scorer — v3.
 * Uses the same 18-feature v3 schema as NYC and BOS.
 * Weights retrained on 2022-2024 NP15 data with relative features.
 */

import np15Weights from "./np15-model-weights.json";

// Re-export all shared helpers — NP15 uses the same v3 feature set
export {
  computeDamFeatures,
  computeRunningInputs,
  buildFeatureVector,
  type DamFeatures,
  type NYCModelInputs,
} from "./nyc-model";

const { scaler_mean, scaler_scale, coef, intercept } = np15Weights;

function sigmoid(x: number): number {
  if (x > 500) return 1;
  if (x < -500) return 0;
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
