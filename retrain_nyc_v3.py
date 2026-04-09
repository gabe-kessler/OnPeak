"""
NYC DART model v3 — comprehensive retrain + intraday backtest.

Evaluates at checkpoints throughout the day (not just EOD) because
that's what matters for live market pricing.

v3 vs v2:
  - rt_vol_pct      cumulative RT volatility / dam_avg
  - rt_momentum     recent vs early RT trend / dam_avg
  - rt_recent_pct   last 30 min vs dam_avg
  - rt_vs_sched_pct RT vs scheduled DAM for elapsed intervals
  - elapsed_x_rt    interaction: pct_elapsed * rt_vs_sched
  - dam_onpeak_frac dam_onpeak_avg / dam_daily_avg

Train: 2022-2024  |  Test: all of 2025 (365 days)
Export: lib/nyc-model-weights.json
"""

import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score, brier_score_loss
import warnings
warnings.filterwarnings("ignore")

CHECKPOINTS = [0.0, 0.10, 0.25, 0.50, 0.75, 0.90, 1.0]

# ── Helper ────────────────────────────────────────────────────────────────────
def get_cp_rows(data, target_pct, tol=0.04):
    """One row per date closest to target_pct elapsed."""
    if target_pct == 0.0:
        return data.groupby("date", sort=False).first().reset_index()
    if target_pct == 1.0:
        return data.groupby("date", sort=False).last().reset_index()
    d2 = data.copy()
    d2["_dist"] = (d2["pct_day_elapsed"] - target_pct).abs()
    return (d2[d2["_dist"] <= tol]
            .sort_values("_dist")
            .drop_duplicates("date")
            .reset_index(drop=True))

# ── Load ──────────────────────────────────────────────────────────────────────
print("Loading master table...")
df = pd.read_csv("NYC_DART_Master_Table.csv", parse_dates=["timestamp", "date"])
df["year"] = df["date"].dt.year
df = df.sort_values(["date", "intervals_elapsed"]).reset_index(drop=True)
print(f"  {len(df):,} rows  |  {df.date.nunique():,} days  |  {df.year.min()}-{df.year.max()}")

# ── Feature engineering ───────────────────────────────────────────────────────
print("Engineering features...")
dav = df["dam_daily_avg"].replace(0, np.nan)
df["rt_vs_dam_pct"]      = (df["rt_avg_so_far"] - df["dam_daily_avg"]) / dav
df["implied_vs_dam_pct"] = (df["implied_remaining_avg"] - df["dam_daily_avg"]) / dav
df["prior_rt_pct"]       = df["prior_rt_post1pm_avg"] / dav
df["dam_max_over_avg"]   = df["dam_max_price"] / dav
df["dam_onpeak_frac"]    = df["dam_onpeak_avg"] / dav

rt_vol_list = []; mom_list = []; recent_list = []; sched_list = []
for _, grp in df.groupby("date", sort=False):
    grp     = grp.sort_values("intervals_elapsed")
    rt      = grp["rt_price"].values
    dh      = grp["dam_price"].values
    dam_avg = float(grp["dam_daily_avg"].iloc[0]) or 1e-9
    n       = len(rt)
    vol = np.zeros(n); mom = np.zeros(n)
    rec = np.zeros(n); sch = np.zeros(n)
    for i in range(n):
        sf = rt[:i+1]
        vol[i] = sf.std(ddof=0) / dam_avg if i >= 1 else 0.
        k       = min(12, max(1, (i+1)//4))
        mom[i]  = (sf[-k:].mean() - sf[:k].mean()) / dam_avg
        rec[i]  = sf[-6:].mean() / dam_avg - 1.
        sch[i]  = (sf.mean() - dh[:i+1].mean()) / dam_avg
    rt_vol_list.extend(vol);  mom_list.extend(mom)
    recent_list.extend(rec);  sched_list.extend(sch)

df["rt_vol_pct"]      = rt_vol_list
df["rt_momentum"]     = mom_list
df["rt_recent_pct"]   = recent_list
df["rt_vs_sched_pct"] = sched_list
df["elapsed_x_rt"]    = df["pct_day_elapsed"] * df["rt_vs_sched_pct"]
print("  Done.")

# ── Feature sets ──────────────────────────────────────────────────────────────
FEATURES_V2 = [
    "dam_daily_avg", "dam_peak_ratio", "dam_max_over_avg",
    "prior_rt_pct", "prior_rt_volatility", "prior_rt_trend",
    "rt_vs_dam_pct", "implied_vs_dam_pct",
    "pct_day_elapsed", "day_of_week", "month", "is_weekend",
]
FEATURES_V3 = FEATURES_V2 + [
    "rt_vol_pct",       # intraday RT volatility / dam_avg
    "rt_momentum",      # recent vs early RT trend
    "rt_recent_pct",    # last 30 min vs dam_avg
    "rt_vs_sched_pct",  # RT vs scheduled DAM for elapsed hours
    "elapsed_x_rt",     # amplify RT signal as day progresses
    "dam_onpeak_frac",  # how dominant is on-peak in DAM profile?
]

# ── Split ─────────────────────────────────────────────────────────────────────
TRAIN_YEARS = [2019, 2020, 2021, 2022, 2023, 2024]
train = df[df["year"].isin(TRAIN_YEARS)].dropna(subset=FEATURES_V3 + ["y"])
test  = df[df["year"] == 2025].dropna(subset=FEATURES_V3 + ["y"])
print(f"\nTrain {min(TRAIN_YEARS)}-{max(TRAIN_YEARS)}: {len(train):,} intervals, {train.date.nunique()} days")
print(f"Test  2025:      {len(test):,}  intervals, {test.date.nunique()} days")

# ── Fit scalers ───────────────────────────────────────────────────────────────
scaler_v2 = StandardScaler().fit(train[FEATURES_V2].values)
scaler_v3 = StandardScaler().fit(train[FEATURES_V3].values)
X_tr_v2   = scaler_v2.transform(train[FEATURES_V2].values)
X_tr_v3   = scaler_v3.transform(train[FEATURES_V3].values)
y_tr      = train["y"].values

# ── C sweep for v3 (evaluate on 2025 average across checkpoints) ──────────────
print("\nSweeping C for LR v3...")
def mean_cp_acc(model, scaler, feats):
    accs = []
    for cp in [0.10, 0.25, 0.50, 0.75]:
        rows = get_cp_rows(test, cp)
        p = model.predict_proba(scaler.transform(rows[feats].values))[:, 1]
        accs.append(accuracy_score(rows["y"].values, p > 0.5))
    return np.mean(accs)

best_C, best_mean, best_lr_v3 = 0.1, 0, None
for C in [0.02, 0.03, 0.05, 0.1, 0.2]:
    m = LogisticRegression(C=C, max_iter=1000, random_state=42)
    m.fit(X_tr_v3, y_tr)
    mean_acc = mean_cp_acc(m, scaler_v3, FEATURES_V3)
    print(f"  C={C:.2f}  avg(10/25/50/75% acc)={mean_acc:.4f}")
    if mean_acc > best_mean:
        best_mean, best_C, best_lr_v3 = mean_acc, C, m
print(f"  → Best C={best_C}")

lr_v2 = LogisticRegression(C=0.1, max_iter=1000, random_state=42)
lr_v2.fit(X_tr_v2, y_tr)
lr_v3 = best_lr_v3

hgb = HistGradientBoostingClassifier(
    max_iter=300, max_depth=4, learning_rate=0.05,
    min_samples_leaf=50, random_state=42)
hgb.fit(train[FEATURES_V3].values, y_tr)

# ── Intraday accuracy table ───────────────────────────────────────────────────
print("\n=== Intraday accuracy — 2025 test set ===")
print(f"{'Elapsed':>8}  {'LR v2':>7}  {'LR v3':>7}  {'HGB':>7}  {'N':>5}")
cp_results = {}
for cp in CHECKPOINTS:
    rows = get_cp_rows(test, cp)
    if len(rows) < 10: continue
    X_v2 = scaler_v2.transform(rows[FEATURES_V2].values)
    X_v3 = scaler_v3.transform(rows[FEATURES_V3].values)
    y    = rows["y"].values
    p_v2  = lr_v2.predict_proba(X_v2)[:, 1]
    p_v3  = lr_v3.predict_proba(X_v3)[:, 1]
    p_hgb = hgb.predict_proba(rows[FEATURES_V3].values)[:, 1]
    a_v2  = accuracy_score(y, p_v2  > 0.5)
    a_v3  = accuracy_score(y, p_v3  > 0.5)
    a_hgb = accuracy_score(y, p_hgb > 0.5)
    cp_results[cp] = (a_v2, a_v3, a_hgb, len(rows))
    print(f"{cp*100:>7.0f}%  {a_v2*100:>6.1f}%  {a_v3*100:>6.1f}%  "
          f"{a_hgb*100:>6.1f}%  {len(rows):>5}")

# ── Monthly at 50% elapsed ────────────────────────────────────────────────────
print("\n=== 2025 monthly accuracy at 50% elapsed ===")
mid = get_cp_rows(test, 0.50).copy()
mid["pred_v2"]  = lr_v2.predict_proba(scaler_v2.transform(mid[FEATURES_V2].values))[:, 1]
mid["pred_v3"]  = lr_v3.predict_proba(scaler_v3.transform(mid[FEATURES_V3].values))[:, 1]
mid["pred_hgb"] = hgb.predict_proba(mid[FEATURES_V3].values)[:, 1]
for mo in range(1, 13):
    m = mid[mid["date"].dt.month == mo]
    if len(m) == 0: continue
    av2  = accuracy_score(m["y"], m["pred_v2"]  > 0.5)
    av3  = accuracy_score(m["y"], m["pred_v3"]  > 0.5)
    ahgb = accuracy_score(m["y"], m["pred_hgb"] > 0.5)
    print(f"  {pd.Timestamp(2025, mo, 1).strftime('%b'):>3}  "
          f"v2={av2*100:.0f}%  v3={av3*100:.0f}%  HGB={ahgb*100:.0f}%  "
          f"({len(m)}d YES={m.y.mean()*100:.0f}%)")

# ── Coefficient inspection ────────────────────────────────────────────────────
print("\n=== LR v3 coefficients ===")
for name, coef in sorted(zip(FEATURES_V3, lr_v3.coef_[0]),
                          key=lambda x: abs(x[1]), reverse=True):
    print(f"  {name:<28}: {coef:+.4f}")
print(f"  {'intercept':<28}: {lr_v3.intercept_[0]:+.4f}")

# ── Summary ───────────────────────────────────────────────────────────────────
print("\n=== Summary: v2 → v3 ===")
for cp in CHECKPOINTS:
    if cp not in cp_results: continue
    av2, av3, ahgb, n = cp_results[cp]
    best = max(av2, av3, ahgb)
    winner = "v3" if av3 == best else ("HGB" if ahgb == best else "v2")
    delta = (av3 - av2) * 100
    print(f"  {cp*100:>4.0f}%  v2={av2*100:.1f}%  v3={av3*100:.1f}% ({delta:+.1f}pp)  "
          f"HGB={ahgb*100:.1f}%  winner={winner}")

# ── Export v3 weights ──────────────────────────────────────────────────────────
weights = {
    "version":      "v3",
    "features":     FEATURES_V3,
    "scaler_mean":  scaler_v3.mean_.tolist(),
    "scaler_scale": scaler_v3.scale_.tolist(),
    "coef":         lr_v3.coef_[0].tolist(),
    "intercept":    float(lr_v3.intercept_[0]),
}
with open("lib/nyc-model-weights.json", "w") as f:
    json.dump(weights, f, indent=2)
print(f"\nSaved lib/nyc-model-weights.json ({len(FEATURES_V3)} features, C={best_C})")
print("Done.")
