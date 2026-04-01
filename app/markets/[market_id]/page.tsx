"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";

type Market = {
  market_id: string;
  name: string;
  node: string;
  threshold: number;
  resolution_date: string;
  status: string;
  settlement_value: number | null;
  model_prob: number | null;
  best_yes_ask: number | null;
  best_no_ask: number | null;
  orderbook: { side: string; contract_type: string; display_price: string; quantity: number }[];
};

type User = { user_id: string; username: string; cash_balance: number };
type PricePoint = { minutes: number; price: number };

function priceColor(price: number): string {
  if (price < 0)   return "#033d8b";
  if (price < 20)  return "#0969da";
  if (price < 40)  return "#54aeff";
  if (price < 60)  return "#d4a017";
  if (price < 100) return "#e16f24";
  if (price < 200) return "#cf222e";
  return "#82071e";
}

const NODE_LABEL: Record<string, string> = {
  "N.Y.C.":           "NYC avg RT LBMP",
  ".Z.NEMASSBOST":    "Boston avg RT LMP",
  "TH_NP15_GEN-APND": "NorCal Hub avg RT LMP",
};

const NODE_ID: Record<string, string> = {
  "N.Y.C.":           "NYISO_N.Y.C.",
  ".Z.NEMASSBOST":    "ISONE_.Z.NEMASSBOST",
  "TH_NP15_GEN-APND": "CAISO_TH_NP15_GEN-APND",
};

const S = {
  bg: "#f6f8fa", surface: "#ffffff", elevated: "#f0f3f6",
  border: "#d0d7de", text: "#1f2328", muted: "#656d76",
  faint: "#8c959f", blue: "#0969da", green: "#1a7f37", red: "#cf222e",
  greenFill: "rgba(34,197,94,0.38)",
  redFill:   "rgba(207,34,46,0.32)",
};

function etDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

function minutesSinceMidnight(ts: string): number {
  const s = new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

// ── SVG price chart ────────────────────────────────────────────────────────────

const W = 580, H = 130;
const PAD = { top: 10, right: 62, bottom: 22, left: 40 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;
const X_HOURS = [0, 6, 12, 18, 24];
const X_LABELS: Record<number, string> = { 0: "12a", 6: "6a", 12: "12p", 18: "6p", 24: "12a" };

type Tooltip = { x: number; y: number; price: number; minutes: number };

function fmtTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function PriceChart({ points, threshold }: { points: PricePoint[]; threshold: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const hasData = points.length >= 2;

  const prices = hasData ? points.map(p => p.price) : [];
  const allVals = [...prices, threshold];
  const rawMin = hasData ? Math.min(...allVals) : threshold * 0.8;
  const rawMax = hasData ? Math.max(...allVals) : threshold * 1.2;
  const pad = (rawMax - rawMin) * 0.12 || threshold * 0.1;
  const minP = rawMin - pad;
  const maxP = rawMax + pad;
  const range = maxP - minP;

  function toX(minutes: number) { return (minutes / 1440) * CW; }
  function toY(price: number)   { return CH - ((price - minP) / range) * CH; }

  const damY = toY(threshold);
  const yTicks = [0, 1, 2, 3].map(i => minP + (range / 3) * i);

  const greenSegs: string[] = [];
  const redSegs:   string[] = [];

  if (hasData) {
    const svgPts = points.map(p => ({ x: toX(p.minutes), y: toY(p.price) }));
    for (let i = 0; i < svgPts.length - 1; i++) {
      const p1 = svgPts[i], p2 = svgPts[i + 1];
      const a1 = p1.y <= damY, a2 = p2.y <= damY;
      if (a1 && a2) {
        greenSegs.push(`M${p1.x},${damY} L${p1.x},${p1.y} L${p2.x},${p2.y} L${p2.x},${damY} Z`);
      } else if (!a1 && !a2) {
        redSegs.push(`M${p1.x},${damY} L${p1.x},${p1.y} L${p2.x},${p2.y} L${p2.x},${damY} Z`);
      } else {
        const xi = p1.x + (damY - p1.y) / (p2.y - p1.y) * (p2.x - p1.x);
        if (a1) {
          greenSegs.push(`M${p1.x},${damY} L${p1.x},${p1.y} L${xi},${damY} Z`);
          redSegs.push(`M${xi},${damY} L${p2.x},${p2.y} L${p2.x},${damY} Z`);
        } else {
          redSegs.push(`M${p1.x},${damY} L${p1.x},${p1.y} L${xi},${damY} Z`);
          greenSegs.push(`M${xi},${damY} L${p2.x},${p2.y} L${p2.x},${damY} Z`);
        }
      }
    }
  }

  const polyline = hasData ? points.map(p => `${toX(p.minutes)},${toY(p.price)}`).join(" ") : "";

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!hasData || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const rawX = e.clientX - rect.left - PAD.left;
    const clampedX = Math.max(0, Math.min(CW, rawX));
    const hoverMinutes = (clampedX / CW) * 1440;
    let nearest = points[0];
    let minDist = Infinity;
    for (const p of points) {
      const d = Math.abs(p.minutes - hoverMinutes);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    setTooltip({ x: toX(nearest.minutes), y: toY(nearest.price), price: nearest.price, minutes: nearest.minutes });
  }

  const BOX_W = 90, BOX_H = 36;

  return (
    <svg ref={svgRef} width={W} height={H} style={{ display: "block", overflow: "visible", cursor: hasData ? "crosshair" : "default" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setTooltip(null)}
    >
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {yTicks.map((v, i) => {
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={0} y1={y} x2={CW} y2={y} stroke={S.border} strokeWidth={0.5} />
              <text x={-5} y={y + 3.5} textAnchor="end" fontSize={9} fill={S.faint}>${v.toFixed(0)}</text>
            </g>
          );
        })}
        {greenSegs.length > 0 && <path d={greenSegs.join(" ")} fill={S.greenFill} />}
        {redSegs.length > 0   && <path d={redSegs.join(" ")}   fill={S.redFill} />}
        <line x1={0} y1={damY} x2={CW} y2={damY} stroke={S.blue} strokeWidth={1.5} strokeDasharray="5 3" />
        <text x={CW + 5} y={damY + 4} fontSize={9} fill={S.blue}>{`DAM $${threshold.toFixed(2)}`}</text>
        {hasData && <polyline points={polyline} fill="none" stroke={S.text} strokeWidth={1.5} strokeLinejoin="round" />}
        <line x1={0} y1={CH} x2={CW} y2={CH} stroke={S.border} strokeWidth={0.5} />
        {X_HOURS.map(h => (
          <text key={h} x={(h / 24) * CW} y={CH + 14} textAnchor="middle" fontSize={9} fill={S.faint}>
            {X_LABELS[h]}
          </text>
        ))}

        {/* Hover tooltip */}
        {tooltip && (
          <>
            <line x1={tooltip.x} y1={0} x2={tooltip.x} y2={CH} stroke={S.faint} strokeWidth={1} strokeDasharray="3 2" />
            <circle cx={tooltip.x} cy={tooltip.y} r={4} fill={S.text} stroke="#fff" strokeWidth={1.5} />
            {(() => {
              const boxX = tooltip.x + 8 + BOX_W > CW ? tooltip.x - 8 - BOX_W : tooltip.x + 8;
              const boxY = Math.max(0, Math.min(CH - BOX_H, tooltip.y - BOX_H / 2));
              return (
                <g>
                  <rect x={boxX} y={boxY} width={BOX_W} height={BOX_H} rx={4} fill="#1f2328" opacity={0.9} />
                  <text x={boxX + BOX_W / 2} y={boxY + 13} textAnchor="middle" fontSize={9} fill={S.faint}>{fmtTime(tooltip.minutes)}</text>
                  <text x={boxX + BOX_W / 2} y={boxY + 27} textAnchor="middle" fontSize={11} fontWeight="700" fill="#ffffff">${tooltip.price.toFixed(2)}/MWh</text>
                </g>
              );
            })()}
          </>
        )}
      </g>
    </svg>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function MarketPage() {
  const { market_id } = useParams<{ market_id: string }>();
  const [user, setUser]       = useState<User | null>(null);
  const [market, setMarket]   = useState<Market | null>(null);
  const [loading, setLoading] = useState(true);
  const [side, setSide]         = useState<"yes" | "no" | null>(null);
  const [qty, setQty]           = useState(1);
  const [hoverYes, setHoverYes]   = useState(false);
  const [hoverNo, setHoverNo]     = useState(false);
  const [hoverExec, setHoverExec] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [success, setSuccess]       = useState<string | null>(null);

  const [points, setPoints]         = useState<PricePoint[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  const today = etDateStr();

  function loadMarket() {
    return fetch("/api/markets")
      .then(r => r.json())
      .then((data: Market[]) => {
        const found = data.find(m => m.market_id === market_id);
        if (found) setMarket(found);
      });
  }

  const fetchHistory = useCallback(async () => {
    try {
      const data = await fetch(`/api/prices/history?date=${today}`, { cache: "no-store" }).then(r => r.json());
      // We don't know the node yet when this first runs, so we store all rows keyed by node_id
      // and resolve once market is available — handled in the effect below
      return data.rows ?? [];
    } catch { return []; }
  }, [today]);

  const fetchLive = useCallback(async () => {
    try {
      const data = await fetch("/api/prices/all", { cache: "no-store" }).then(r => r.json());
      return data.zones ?? [];
    } catch { return []; }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) setUser(JSON.parse(stored));
    loadMarket().finally(() => setLoading(false));
  }, [market_id]);

  useEffect(() => {
    if (!market) return;
    const nodeId = NODE_ID[market.node];
    if (!nodeId) return;

    async function refresh() {
      const [rows, zones] = await Promise.all([fetchHistory(), fetchLive()]);
      const pts: PricePoint[] = (rows as { node_id: string; price: string; recorded_at: string }[])
        .filter(r => r.node_id === nodeId)
        .map(r => ({ minutes: minutesSinceMidnight(r.recorded_at), price: Number(r.price) }))
        .sort((a, b) => a.minutes - b.minutes);
      setPoints(pts);
      const z = (zones as { id: string; price: number }[]).find(z => z.id === nodeId);
      setCurrentPrice(z?.price ?? null);
    }

    refresh();
    const iv = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [market, fetchHistory, fetchLive]);

  async function handleSubmit() {
    if (!user || !market || !side) return;
    setSubmitting(true); setError(null); setSuccess(null);
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: user.user_id, market_id: market.market_id,
        side: "buy", contract_type: side,
        order_type: "market", quantity: qty,
      }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? "Something went wrong."); }
    else { setSuccess("Order placed!"); setSide(null); setQty(1); loadMarket(); }
    setSubmitting(false);
  }

  const cardStyle = { background: S.surface, border: `1px solid ${S.border}` };

  if (loading) return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>
      <p style={{ color: S.faint }}>Loading...</p>
    </main>
  );

  if (!market) return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>
      <a href="/" style={{ color: S.muted }} className="text-sm mb-6 block">← Back</a>
      <p style={{ color: S.faint }}>Market not found.</p>
    </main>
  );

  const nodeLabel   = NODE_LABEL[market.node] ?? market.node;
  const resolveDate = new Date(market.resolution_date + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const isSettled   = market.status === "settled";
  const yesWins     = isSettled && market.settlement_value != null && market.settlement_value > market.threshold;
  const avg         = points.length > 0 ? points.reduce((s, p) => s + p.price, 0) / points.length : null;
  const isToday     = market.resolution_date === today;

  return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>
      <div style={{ maxWidth: "680px", margin: "0 auto" }}>
      <a href="/markets" className="text-sm mb-6 block" style={{ color: S.muted }}>← Back</a>
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold">{market.name}</h1>
        {isSettled && (
          <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ background: yesWins ? S.green : S.red, color: "#ffffff" }}>
            🔒 SETTLED {yesWins ? "YES" : "NO"}
          </span>
        )}
      </div>
      <p className="text-sm mb-6" style={{ color: S.muted }}>
        Will the {nodeLabel} exceed{" "}
        <span className="font-semibold" style={{ color: S.blue }}>${market.threshold.toFixed(2)}/MWh</span>
        {" "}on {resolveDate}?
      </p>

      {/* Threshold + settlement */}
      <div className="flex gap-3 mb-5">
        <div className="rounded p-4" style={{ background: S.surface, border: `1px solid ${S.border}`, flex: 1 }}>
          <p className="text-xs mb-1 font-medium uppercase tracking-wide" style={{ color: S.faint }}>DAM Threshold</p>
          <p className="text-2xl font-bold" style={{ color: S.blue }}>
            ${market.threshold.toFixed(2)}{" "}
            <span className="text-base font-normal" style={{ color: S.muted }}>/MWh</span>
          </p>
        </div>
        {isSettled && market.settlement_value != null && (
          <div className="rounded p-4" style={{ background: S.surface, border: `1px solid ${S.border}`, flex: 1 }}>
            <p className="text-xs mb-1 font-medium uppercase tracking-wide" style={{ color: S.faint }}>Settlement Value</p>
            <p className="text-2xl font-bold" style={{ color: yesWins ? S.green : S.red }}>
              ${market.settlement_value.toFixed(2)}{" "}
              <span className="text-base font-normal" style={{ color: S.muted }}>/MWh</span>
            </p>
          </div>
        )}
      </div>

      {/* Model probability — NYC markets only */}
      {market.model_prob != null && !isSettled && (() => {
        const prob    = market.model_prob;
        const yesCents = Math.round(prob * 100);
        const noCents  = 100 - yesCents;
        const barColor = prob >= 0.5 ? S.green : S.red;
        return (
          <div className="rounded p-4 mb-5" style={{ background: S.surface, border: `1px solid ${S.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "10px" }}>
              <p className="text-xs font-medium uppercase tracking-wide" style={{ color: S.faint }}>
                Model Probability
              </p>
              <p style={{ fontSize: "11px", color: S.faint }}>updated every 5 min</p>
            </div>
            <div style={{ display: "flex", gap: "16px", alignItems: "center", marginBottom: "10px" }}>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: "11px", color: S.green, fontWeight: 600, marginBottom: "2px" }}>YES</p>
                <p style={{ fontSize: "22px", fontWeight: 700, color: S.green }}>{yesCents}¢</p>
              </div>
              <div style={{ flex: 1 }}>
                {/* Progress bar */}
                <div style={{ height: "10px", borderRadius: "5px", background: S.elevated, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${yesCents}%`, background: barColor, borderRadius: "5px", transition: "width 0.4s ease" }} />
                </div>
              </div>
              <div style={{ textAlign: "center" }}>
                <p style={{ fontSize: "11px", color: S.red, fontWeight: 600, marginBottom: "2px" }}>NO</p>
                <p style={{ fontSize: "22px", fontWeight: 700, color: S.red }}>{noCents}¢</p>
              </div>
            </div>
            <p style={{ fontSize: "11px", color: S.faint }}>
              Model estimates {yesCents}% chance NYC avg RT exceeds DAM on this day.
            </p>
          </div>
        );
      })()}

      {/* Price chart */}
      <div className="rounded p-5 mb-5" style={cardStyle}>
        {isToday && (
          <div style={{ display: "flex", gap: "32px", marginBottom: "14px" }}>
            <div>
              <p style={{ fontSize: "11px", color: S.faint, marginBottom: "2px" }}>Today&apos;s Avg</p>
              <p style={{ fontSize: "16px", fontWeight: 700, color: avg != null ? priceColor(avg) : S.text }}>{avg != null ? `$${avg.toFixed(2)}/MWh` : "—"}</p>
            </div>
            <div>
              <p style={{ fontSize: "11px", color: S.faint, marginBottom: "2px" }}>Current RT</p>
              <p style={{ fontSize: "16px", fontWeight: 700, color: currentPrice != null ? priceColor(currentPrice) : S.text }}>
                {currentPrice != null ? `$${currentPrice.toFixed(2)}/MWh` : "—"}
              </p>
            </div>
          </div>
        )}
        <PriceChart points={isToday ? points : []} threshold={market.threshold} />
      </div>

      {/* Trading section */}
      {isSettled ? (
        <div className="flex gap-3 mb-5">
          <div className="rounded p-4 flex-1 text-center" style={{ background: yesWins ? "#dcfce7" : S.surface, border: `2px solid ${yesWins ? S.green : S.border}` }}>
            <p className="text-xs mb-1 font-bold uppercase" style={{ color: S.green }}>YES</p>
            <p className="font-bold text-2xl" style={{ color: S.green }}>{yesWins ? "✓ WON" : "—"}</p>
            <p className="text-xs mt-1" style={{ color: S.faint }}>{yesWins ? "settled YES" : ""}</p>
          </div>
          <div className="rounded p-4 flex-1 text-center" style={{ background: !yesWins ? "#fee2e2" : S.surface, border: `2px solid ${!yesWins ? S.red : S.border}` }}>
            <p className="text-xs mb-1 font-bold uppercase" style={{ color: S.red }}>NO</p>
            <p className="font-bold text-2xl" style={{ color: S.red }}>{!yesWins ? "✓ WON" : "—"}</p>
            <p className="text-xs mt-1" style={{ color: S.faint }}>{!yesWins ? "settled NO" : ""}</p>
          </div>
        </div>
      ) : user ? (
        <div className="mb-5">
          {/* BUY YES / BUY NO */}
          <div className="flex gap-3 mb-4">
            <button
              onClick={() => { setSide(side === "yes" ? null : "yes"); setError(null); setSuccess(null); }}
              onMouseEnter={() => setHoverYes(true)}
              onMouseLeave={() => setHoverYes(false)}
              style={{ flex: 1, padding: "14px 0", background: S.green, color: "#fff", border: `2px solid ${hoverYes || side === "yes" ? "#0d4720" : S.green}`, borderRadius: "6px", fontWeight: 700, fontSize: "15px", cursor: "pointer", opacity: side && side !== "yes" ? 0.55 : 1, transition: "border-color 0.1s, opacity 0.1s" }}
            >
              BUY YES · {market.model_prob != null ? `${Math.round(market.model_prob * 100)}¢` : "50¢"}
            </button>
            <button
              onClick={() => { setSide(side === "no" ? null : "no"); setError(null); setSuccess(null); }}
              onMouseEnter={() => setHoverNo(true)}
              onMouseLeave={() => setHoverNo(false)}
              style={{ flex: 1, padding: "14px 0", background: S.red, color: "#fff", border: `2px solid ${hoverNo || side === "no" ? "#7a0a0f" : S.red}`, borderRadius: "6px", fontWeight: 700, fontSize: "15px", cursor: "pointer", opacity: side && side !== "no" ? 0.55 : 1, transition: "border-color 0.1s, opacity 0.1s" }}
            >
              BUY NO · {market.model_prob != null ? `${100 - Math.round(market.model_prob * 100)}¢` : "50¢"}
            </button>
          </div>

          {/* Contracts */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
            <label style={{ fontSize: "14px", color: S.muted }}>Contracts</label>
            <input
              type="number" min={1} value={qty}
              onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: "110px", padding: "7px 10px", border: `1px solid ${S.border}`, borderRadius: "4px", fontSize: "14px", textAlign: "center", background: S.surface, color: S.text }}
            />
          </div>

          {/* Payout + Execute */}
          {side && (
            <>
              <div style={{ background: S.elevated, borderRadius: "6px", padding: "10px 14px", marginBottom: "10px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: S.muted, marginBottom: "5px" }}>
                  <span>Cost</span>
                  <strong style={{ color: S.text }}>${(qty * 0.50).toFixed(2)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: S.muted }}>
                  <span>Payout if correct</span>
                  <strong style={{ color: side === "yes" ? S.green : S.red }}>${(qty * 1.00).toFixed(2)}</strong>
                </div>
              </div>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                onMouseEnter={() => setHoverExec(true)}
                onMouseLeave={() => setHoverExec(false)}
                style={{ width: "100%", padding: "12px 0", background: side === "yes" ? S.green : S.red, color: "#fff", border: `2px solid ${hoverExec ? (side === "yes" ? "#0d4720" : "#7a0a0f") : (side === "yes" ? S.green : S.red)}`, borderRadius: "6px", fontWeight: 700, fontSize: "14px", cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.7 : 1, transition: "border-color 0.1s" }}
              >
                {submitting ? "Placing…" : `Execute Order · ${side.toUpperCase()}`}
              </button>
            </>
          )}

          {error   && <p style={{ marginTop: "8px", fontSize: "12px", color: S.red }}>{error}</p>}
          {success && <p style={{ marginTop: "8px", fontSize: "12px", color: S.green }}>{success}</p>}
        </div>
      ) : (
        <div className="rounded p-5 mb-5 text-center" style={cardStyle}>
          <p className="text-sm mb-3" style={{ color: S.muted }}>Sign in to place orders.</p>
          <a href="/login" className="inline-block px-4 py-2 rounded font-bold text-sm" style={{ background: S.blue, color: "#000" }}>Sign In</a>
        </div>
      )}

      {/* Order book */}
      <div className="rounded p-5" style={cardStyle}>
        <h2 className="text-xs font-bold uppercase tracking-wide mb-4" style={{ color: S.faint }}>Order Book</h2>
        {market.orderbook.length === 0 ? (
          <p className="text-sm" style={{ color: S.faint }}>No resting orders.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: S.faint, borderBottom: `1px solid ${S.border}` }}>
                <th className="text-left pb-2 text-xs font-medium">Action</th>
                <th className="text-left pb-2 text-xs font-medium">Contract</th>
                <th className="text-left pb-2 text-xs font-medium">Price</th>
                <th className="text-left pb-2 text-xs font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {market.orderbook.map((o, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${S.elevated}` }}>
                  <td className="py-2 font-bold" style={{ color: o.side === "buy" ? S.green : S.red }}>{o.side.toUpperCase()}</td>
                  <td className="py-2" style={{ color: S.text }}>{o.contract_type.toUpperCase()}</td>
                  <td className="py-2" style={{ color: S.blue }}>${o.display_price}</td>
                  <td className="py-2" style={{ color: S.muted }}>{o.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </main>
  );
}
