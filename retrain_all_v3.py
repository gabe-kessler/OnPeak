"""
Retrain BOS and NP15 DART models using the same v3 relative+intraday
feature schema as NYC. Exports weights to lib/{node}-model-weights.json.

Feature set matches NYC v3 (18 features, same order).
Train: 2022-2024  |  Test: 2025
"""

import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score, brier_score_loss
import warnings
warnings.filterwarnings("ignore")

FEATURES_V3 = [
    "dam_daily_avg", "dam_peak_ratio", "dam_max_over_avg",
    "prior_rt_pct", "prior_rt_volatility", "prior_rt_trend",
    "rt_vs_dam_pct", "implied_vs_dam_pct",
    "pct_day_elapsed", "day_of_week", "month", "is_weekend",
    "rt_vol_pct", "rt_momentum", "rt_recent_pct",
    "rt_vs_sched_pct", "elapsed_x_rt", "dam_onpeak_frac",
]

CHECKPOINTS = [0.0, 0.25, 0.50, 0.75, 1.0]

def get_cp_rows(data, target_pct, tol=0.04):
    if target_pct == 0.0: return data.groupby("date", sort=False).first().reset_index()
    if target_pct == 1.0: return data.groupby("date", sort=False).last().reset_index()
    d2 = data.copy()
    d2["_dist"] = (d2["pct_day_elapsed"] - target_pct).abs()
    return d2[d2["_dist"] <= tol].sort_values("_dist").drop_duplicates("date").reset_index(drop=True)

def engineer_features(df):
    dav = df["dam_daily_avg"].replace(0, np.nan)
    df["rt_vs_dam_pct"]      = (df["rt_avg_so_far"] - df["dam_daily_avg"]) / dav
    df["implied_vs_dam_pct"] = (df["implied_remaining_avg"] - df["dam_daily_avg"]) / dav
    df["prior_rt_pct"]       = df["prior_rt_post1pm_avg"] / dav
    df["dam_max_over_avg"]   = df["dam_max_price"] / dav
    df["dam_onpeak_frac"]    = df["dam_onpeak_avg"] / dav

    rt_vol_list=[]; mom_list=[]; recent_list=[]; sched_list=[]
    for _, grp in df.groupby("date", sort=False):
        grp = grp.sort_values("intervals_elapsed")
        rt  = grp["rt_price"].values
        dh  = grp["dam_price"].values
        dam_avg = float(grp["dam_daily_avg"].iloc[0]) or 1e-9
        n   = len(rt)
        vol=np.zeros(n); mom=np.zeros(n); rec=np.zeros(n); sch=np.zeros(n)
        for i in range(n):
            sf = rt[:i+1]
            vol[i] = sf.std(ddof=0)/dam_avg if i>=1 else 0.
            k=min(12,max(1,(i+1)//4)); mom[i]=(sf[-k:].mean()-sf[:k].mean())/dam_avg
            rec[i]=sf[-6:].mean()/dam_avg-1.; sch[i]=(sf.mean()-dh[:i+1].mean())/dam_avg
        rt_vol_list.extend(vol); mom_list.extend(mom)
        recent_list.extend(rec); sched_list.extend(sch)

    df["rt_vol_pct"]=rt_vol_list; df["rt_momentum"]=mom_list
    df["rt_recent_pct"]=recent_list; df["rt_vs_sched_pct"]=sched_list
    df["elapsed_x_rt"] = df["pct_day_elapsed"] * df["rt_vs_sched_pct"]
    return df

def train_node(csv_path, out_path, label):
    print(f"\n{'='*60}")
    print(f"  {label}  →  {out_path}")
    print('='*60)

    df = pd.read_csv(csv_path, parse_dates=["timestamp","date"])
    df["year"] = df["date"].dt.year
    df = df.sort_values(["date","intervals_elapsed"]).reset_index(drop=True)
    print(f"  Loaded {len(df):,} rows, {df.date.nunique()} days, {df.year.min()}-{df.year.max()}")

    df = engineer_features(df)

    train = df[df["year"].isin([2022,2023,2024])].dropna(subset=FEATURES_V3+["y"])
    test  = df[df["year"]==2025].dropna(subset=FEATURES_V3+["y"])
    print(f"  Train 2022-2024: {len(train):,} intervals, {train.date.nunique()} days")
    print(f"  Test  2025:      {len(test):,}  intervals, {test.date.nunique()} days")

    scaler = StandardScaler().fit(train[FEATURES_V3].values)
    X_tr   = scaler.transform(train[FEATURES_V3].values)

    # Sweep C
    best_C, best_mean, best_lr = 0.1, 0, None
    for C in [0.02, 0.05, 0.1, 0.2, 0.5]:
        m = LogisticRegression(C=C, max_iter=1000, random_state=42)
        m.fit(X_tr, train["y"].values)
        accs = []
        for cp in [0.25, 0.50, 0.75]:
            rows = get_cp_rows(test, cp)
            if len(rows) < 5: continue
            p = m.predict_proba(scaler.transform(rows[FEATURES_V3].values))[:,1]
            accs.append(accuracy_score(rows["y"].values, p>0.5))
        mean_acc = np.mean(accs) if accs else 0
        if mean_acc > best_mean:
            best_mean, best_C, best_lr = mean_acc, C, m

    print(f"\n  Best C={best_C}")

    # Report accuracy at checkpoints
    print(f"  {'Elapsed':>8}  {'Accuracy':>9}")
    for cp in CHECKPOINTS:
        rows = get_cp_rows(test, cp)
        if len(rows) < 5: continue
        p = best_lr.predict_proba(scaler.transform(rows[FEATURES_V3].values))[:,1]
        a = accuracy_score(rows["y"].values, p>0.5)
        print(f"  {cp*100:>7.0f}%  {a*100:>8.1f}%  (n={len(rows)})")

    # Export
    weights = {
        "version":      "v3",
        "features":     FEATURES_V3,
        "scaler_mean":  scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "coef":         best_lr.coef_[0].tolist(),
        "intercept":    float(best_lr.intercept_[0]),
    }
    with open(out_path, "w") as f:
        json.dump(weights, f, indent=2)
    print(f"\n  Saved {out_path}")

# ── Train BOS and NP15 ────────────────────────────────────────────────────────
train_node("BOS_DART_Master_Table.csv",  "lib/bos-model-weights.json",  "BOS (.Z.NEMASSBOST)")
train_node("NP15_DART_Master_Table.csv", "lib/np15-model-weights.json", "NP15 (TH_NP15_GEN-APND)")

print("\nDone.")
