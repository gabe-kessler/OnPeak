/**
 * BOS (.Z.NEMASSBOST) DART Logistic Regression scorer.
 * Loads pre-trained weights from bos-model-weights.json.
 * All shared feature-building functions are re-exported from nyc-model.ts
 * since BOS uses the exact same 18-feature schema.
 */

import bosWeights from "./bos-model-weights.json";

// Re-export all shared helpers — BOS uses identical feature set and DAM structure
export {
  computeDamFeatures,
  computeRunningInputs,
  buildFeatureVector,
  type DamFeatures,
  type NYCModelInputs,
} from "./nyc-model";

const { scaler_mean, scaler_scale, coef, intercept } = bosWeights;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function scoreBOSModel(features: number[]): number {
  if (features.length !== coef.length) {
    throw new Error(`BOS model: expected ${coef.length} features, got ${features.length}`);
  }
  let dot = intercept;
  for (let i = 0; i < features.length; i++) {
    const z = (features[i] - scaler_mean[i]) / scaler_scale[i];
    dot += z * coef[i];
  }
  return sigmoid(dot);
}
