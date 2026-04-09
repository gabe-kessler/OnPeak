"""
NYC DART model backtest v3 — uses new v3 relative+intraday feature weights.

Downloads NYISO monthly ZIP archives (DAM + RT) and scores the model
at every 5-min interval throughout each day.
"""

import json, math, requests, io, zipfile, re, os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from collections import defaultdict
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

ET = ZoneInfo("America/New_York")
os.makedirs("charts/backtest", exist_ok=True)

with open("lib/nyc-model-weights.json") as f:
    W = json.load(f)
MEAN, SCALE, COEF, INTER = W["scaler_mean"], W["scaler_scale"], W["coef"], W["intercept"]
FEATURES = W["features"]

def sigmoid(x):
    try: return 1 / (1 + math.exp(-x))
    except OverflowError: return 0.0 if x < 0 else 1.0

def score_model(features):
    dot = INTER
    for i, v in enumerate(features):
        dot += ((v - MEAN[i]) / SCALE[i]) * COEF[i]
    return sigmoid(dot)

def avg(arr): return sum(arr) / len(arr) if arr else 0
def std(arr):
    if len(arr) < 2: return 0
    m = avg(arr)
    return math.sqrt(sum((x - m)**2 for x in arr) / len(arr))

# ── NYISO monthly zip cache ───────────────────────────────────────────────────
_dam_cache: dict = {}
_rt_cache:  dict = {}

def _load_zip(url_tmpl, month_key, cache, parser):
    if month_key in cache: return
    url = url_tmpl.format(yyyymm=month_key)
    print(f"  Fetching {url} ...")
    r = requests.get(url, timeout=60); r.raise_for_status()
    z = zipfile.ZipFile(io.BytesIO(r.content))
    cache[month_key] = {}
    for name in z.namelist():
        if name.endswith(".csv"):
            cache[month_key][name[:8]] = parser(z.read(name).decode("utf-8", errors="replace"))

def _parse_dam(text):
    lines = text.strip().split("\n")
    strip = lambda s: s.strip().strip('"')
    header = [strip(h) for h in lines[0].split(",")]
    ni = next((i for i,h in enumerate(header) if h.lower()=="name"), -1)
    li = next((i for i,h in enumerate(header) if h.lower().startswith("lbmp")), -1)
    if ni<0 or li<0: return []
    he_map = {}
    for line in lines[1:]:
        cols = [strip(c) for c in line.split(",")]
        if len(cols) <= max(ni,li) or cols[ni].lower() != "n.y.c.": continue
        try: p = float(cols[li])
        except: continue
        m = re.search(r'\s+(\d+):', cols[0])
        hr = int(m.group(1)) if m else -1
        he = 24 if hr==0 else hr
        if 1<=he<=24: he_map[he]=p
    return [he_map.get(he, 0.) for he in range(1, 25)]

def _parse_rt(text):
    lines = text.strip().split("\n")
    strip = lambda s: s.strip().strip('"')
    header = [strip(h) for h in lines[0].split(",")]
    ni = next((i for i,h in enumerate(header) if h.lower()=="name"), -1)
    li = next((i for i,h in enumerate(header) if h.lower().startswith("lbmp")), -1)
    if ni<0 or li<0: return []
    out = []
    for line in lines[1:]:
        cols = [strip(c) for c in line.split(",")]
        if len(cols) <= max(ni,li) or cols[ni].lower() != "n.y.c.": continue
        try: p = float(cols[li])
        except: continue
        m = re.match(r'(\d+)/(\d+)/(\d+)\s+(\d+):(\d+)', cols[0])
        if m: out.append((int(m.group(4))*60 + int(m.group(5)), p))
    return sorted(out)

DAM_URL = "https://mis.nyiso.com/public/csv/damlbmp/{yyyymm}01damlbmp_zone_csv.zip"
RT_URL  = "https://mis.nyiso.com/public/csv/realtime/{yyyymm}01realtime_zone_csv.zip"

def get_dam(d): mk=d.strftime("%Y%m"); _load_zip(DAM_URL,mk,_dam_cache,_parse_dam); return _dam_cache[mk].get(d.strftime("%Y%m%d"),[])
def get_rt(d):  mk=d.strftime("%Y%m"); _load_zip(RT_URL, mk,_rt_cache, _parse_rt);  return _rt_cache[mk].get(d.strftime("%Y%m%d"),[])

# ── Feature computation (v3) ──────────────────────────────────────────────────
def compute_dam_features(hourly_dam, prior_rt):
    on_peak  = hourly_dam[6:22]
    off_peak = hourly_dam[0:6] + hourly_dam[22:24]
    dam_avg  = avg(hourly_dam)
    onp, offp = avg(on_peak), avg(off_peak)
    return {
        "hourly_dam_prices":    hourly_dam,
        "dam_daily_avg":        dam_avg,
        "dam_onpeak_avg":       onp,
        "dam_offpeak_avg":      offp,
        "dam_peak_ratio":       onp/offp if offp else 0,
        "dam_max_price":        max(hourly_dam) if hourly_dam else 0,
        "prior_rt_post1pm_avg": avg(prior_rt),
        "prior_rt_volatility":  std(prior_rt),
        "prior_rt_trend":       (avg(prior_rt[-10:]) - avg(prior_rt[:10]))
                                if len(prior_rt) >= 10 else 0,
    }

def build_features(rt_so_far, dam, interval_idx, op_date: date):
    TOTAL   = 288
    n       = len(rt_so_far)
    rem     = TOTAL - n
    dam_avg = dam["dam_daily_avg"] or 1e-9
    rt_avg  = avg(rt_so_far) if rt_so_far else dam_avg
    implied = ((dam_avg * TOTAL - rt_avg * n) / rem) if rem > 0 else rt_avg

    rt_vs_dam_pct      = (rt_avg  - dam_avg) / dam_avg
    implied_vs_dam_pct = (implied - dam_avg) / dam_avg
    prior_rt_pct       = dam["prior_rt_post1pm_avg"] / dam_avg
    dam_max_over_avg   = dam["dam_max_price"] / dam_avg

    dow = op_date.weekday()
    pct_elapsed = n / TOTAL

    # ── v3 intraday features ────────────────────────────────────────────────
    # rt_vol_pct
    rt_vol_pct = std(rt_so_far) / dam_avg if len(rt_so_far) > 1 else 0.

    # rt_momentum
    k = min(12, max(1, n // 4))
    rt_momentum = (avg(rt_so_far[-k:]) - avg(rt_so_far[:k])) / dam_avg if n > 0 else 0.

    # rt_recent_pct
    recent6 = rt_so_far[-6:] if rt_so_far else []
    rt_recent_pct = avg(recent6) / dam_avg - 1. if recent6 else 0.

    # rt_vs_sched_pct: rt_avg vs avg DAM for elapsed intervals
    hourly = dam["hourly_dam_prices"]
    if n > 0 and len(hourly) == 24:
        dam_elapsed_avg = avg([hourly[min(i // 12, 23)] for i in range(n)])
        rt_vs_sched_pct = (rt_avg - dam_elapsed_avg) / dam_avg
    else:
        rt_vs_sched_pct = 0.

    # elapsed_x_rt
    elapsed_x_rt = pct_elapsed * rt_vs_sched_pct

    # dam_onpeak_frac
    dam_onpeak_frac = dam["dam_onpeak_avg"] / dam_avg

    # Feature order must match FEATURES list in weights JSON
    return [
        dam_avg,
        dam["dam_peak_ratio"],
        dam_max_over_avg,
        prior_rt_pct,
        dam["prior_rt_volatility"],
        dam["prior_rt_trend"],
        rt_vs_dam_pct,
        implied_vs_dam_pct,
        pct_elapsed,
        float(dow),
        float(op_date.month),
        1. if dow >= 5 else 0.,
        rt_vol_pct,
        rt_momentum,
        rt_recent_pct,
        rt_vs_sched_pct,
        elapsed_x_rt,
        dam_onpeak_frac,
    ]

# ── Backtest one day ──────────────────────────────────────────────────────────
all_results = []

def backtest_day(target: date):
    prior      = target - timedelta(days=1)
    hourly_dam = get_dam(target)
    if len(hourly_dam) != 24: print(f"  SKIP {target} — DAM missing"); return
    prior_rt_raw = get_rt(prior)
    prior_rt     = [p for (m,p) in prior_rt_raw if m >= 780]
    dam = compute_dam_features(hourly_dam, prior_rt)

    rt_raw = get_rt(target)
    if not rt_raw: print(f"  SKIP {target} — RT missing"); return

    slots = defaultdict(list)
    for (minute, price) in rt_raw:
        s = minute // 5
        if 0 <= s < 288: slots[s].append(price)
    rt_intervals = [avg(slots[i]) if i in slots else None for i in range(288)]

    rt_so_far, prob_path = [], []
    for i in range(288):
        if rt_intervals[i] is not None: rt_so_far.append(rt_intervals[i])
        prob = max(0.02, min(0.98, score_model(build_features(rt_so_far, dam, i, target))))
        prob_path.append((i * 5, prob))

    rt_all    = [p for p in rt_intervals if p is not None]
    rt_settle = avg(rt_all) if rt_all else None
    yes_wins  = rt_settle > dam["dam_daily_avg"] if rt_settle is not None else None
    eod_prob  = prob_path[-1][1]
    correct   = yes_wins is not None and ((yes_wins and eod_prob > 0.5) or (not yes_wins and eod_prob < 0.5))

    all_results.append({"date": target, "yes_wins": yes_wins, "eod_prob": eod_prob, "correct": correct,
                        "dam_avg": dam["dam_daily_avg"], "rt_settle": rt_settle})

    print(f"  {target} ({target.strftime('%a')})  DAM ${dam['dam_daily_avg']:.2f}  "
          f"RT ${rt_settle:.2f}  {'YES' if yes_wins else 'NO '}  "
          f"model EOD {eod_prob*100:.1f}¢  {'✓' if correct else '✗'}")

    # Chart
    base  = datetime(target.year, target.month, target.day, tzinfo=ET)
    end   = base + timedelta(days=1)
    times = [base] + [base + timedelta(minutes=m) for (m,_) in prob_path] + [end]
    yes_c = [50.] + [p*100 for (_,p) in prob_path] + ([100. if yes_wins else 0.] if yes_wins is not None else [50.])
    no_c  = [50.] + [(1-p)*100 for (_,p) in prob_path] + ([0. if yes_wins else 100.] if yes_wins is not None else [50.])

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 6),
                                    gridspec_kw={"height_ratios": [3, 1]}, sharex=True)
    ax1.plot(times, yes_c, color="#1a7f37", linewidth=1.5, label="YES")
    ax1.plot(times, no_c,  color="#cf222e", linewidth=1.5, label="NO")
    ax1.axhline(50, color="#d0d7de", linewidth=0.8, linestyle="--", alpha=0.7)
    if yes_wins is not None:
        col = "#1a7f37" if yes_wins else "#cf222e"
        ax1.axvline(end, color=col, linewidth=1.2, linestyle=":", alpha=0.8)
        ax1.plot(end, 100 if yes_wins else 0,   "o", color="#1a7f37", markersize=6, zorder=5)
        ax1.plot(end, 0   if yes_wins else 100, "o", color="#cf222e", markersize=6, zorder=5)
        ax1.text(end - timedelta(minutes=20), 54,
                 f"Settled {'YES' if yes_wins else 'NO'}  RT ${rt_settle:.2f}  {'✓ correct' if correct else '✗ wrong'}",
                 ha="right", fontsize=7.5, color=col)
    ax1.set_ylim(-5, 108); ax1.set_ylabel("Price (¢)", fontsize=9)
    ax1.set_title(f"NYC DART Backtest v3 — {target}  ({target.strftime('%A')})\n"
                  f"DAM ${dam['dam_daily_avg']:.2f}  |  RT ${rt_settle:.2f}  |  "
                  f"prior RT ${dam['prior_rt_post1pm_avg']:.2f}", fontsize=10)
    ax1.legend(fontsize=8, loc="upper left"); ax1.grid(axis="y", linewidth=0.4, alpha=0.5)

    rt_t = [base + timedelta(minutes=i*5) for i in range(288) if rt_intervals[i] is not None]
    rt_p = [rt_intervals[i] for i in range(288) if rt_intervals[i] is not None]
    ax2.plot(rt_t, rt_p, color="#656d76", linewidth=1, label="RT price")
    ax2.axhline(dam["dam_daily_avg"], color="#0969da", linewidth=1, linestyle="--",
                label=f"DAM ${dam['dam_daily_avg']:.2f}")
    ax2.set_ylabel("$/MWh", fontsize=8); ax2.legend(fontsize=7, loc="upper left")
    ax2.grid(axis="y", linewidth=0.4, alpha=0.5)
    ax2.xaxis.set_major_formatter(mdates.DateFormatter("%-I %p", tz=ET))
    ax2.xaxis.set_major_locator(mdates.HourLocator(interval=2))
    ax2.set_xlim(base, end + timedelta(minutes=20))
    plt.xticks(rotation=0, fontsize=8); fig.tight_layout()
    fig.savefig(f"charts/backtest/nyc_{target}_v3.png", dpi=150)
    plt.close(fig)

test_dates = [
    # Original 13-day validation set (Jan-Mar 2026)
    date(2026, 1, 6),  date(2026, 1, 13), date(2026, 1, 21),
    date(2026, 1, 27), date(2026, 1, 30),
    date(2026, 2, 3),  date(2026, 2, 11), date(2026, 2, 18),
    date(2026, 2, 24),
    date(2026, 3, 3),  date(2026, 3, 10), date(2026, 3, 17),
    date(2026, 3, 24),
]

print("Running backtest with v3 model...\n")
for d in test_dates:
    try: backtest_day(d)
    except Exception as e: print(f"  ERROR {d}: {e}")

print(f"\n=== Summary ===")
correct = sum(1 for r in all_results if r["correct"])
total   = len(all_results)
print(f"  Correct: {correct}/{total}  ({correct/total*100:.0f}%)")
print(f"\nCharts in charts/backtest/ (v3 suffix)")
