"use client";

import { useEffect, useState, useCallback } from "react";

type Market = {
  market_id: string;
  name: string;
  node: string;
  threshold: number;
  resolution_date: string;
  status: string;
  settlement_value: number | null;
  best_yes_ask: number | null;
  best_no_ask: number | null;
  model_prob: number | null;
};

type PricePoint = { minutes: number; price: number };

// Map market node → full node_id used in history/live APIs
const NODE_ID: Record<string, string> = {
  "N.Y.C.":           "NYISO_N.Y.C.",
  ".Z.NEMASSBOST":    "ISONE_.Z.NEMASSBOST",
  "TH_NP15_GEN-APND": "CAISO_TH_NP15_GEN-APND",
};

const S = {
  bg:          "#f6f8fa",
  surface:     "#ffffff",
  elevated:    "#f0f3f6",
  border:      "#d0d7de",
  text:        "#1f2328",
  muted:       "#656d76",
  faint:       "#8c959f",
  blue:        "#0969da",
  green:       "#1a7f37",
  red:         "#cf222e",
  greenFill:   "rgba(34,197,94,0.38)",
  redFill:     "rgba(207,34,46,0.32)",
};

function priceColor(price: number): string {
  if (price < 0)   return "#033d8b";
  if (price < 20)  return "#0969da";
  if (price < 40)  return "#54aeff";
  if (price < 60)  return "#d4a017";
  if (price < 100) return "#e16f24";
  if (price < 200) return "#cf222e";
  return "#82071e";
}

function etDateStr(offset = 0): string {
  const d = new Date();
  if (offset) d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

function minutesSinceMidnight(ts: string): number {
  const s = new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour:     "2-digit",
    minute:   "2-digit",
    hour12:   false,
  });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

// ── SVG price chart ────────────────────────────────────────────────────────────

const W = 420, H = 125;
const PAD = { top: 8, right: 6, bottom: 22, left: 38 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;

const X_HOURS = [0, 6, 12, 18, 24];
const X_LABELS: Record<number, string> = { 0: "12a", 6: "6a", 12: "12p", 18: "6p", 24: "12a" };

function PriceChart({ points, threshold }: { points: PricePoint[]; threshold: number }) {
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

  // Y-axis ticks
  const yStep = range / 3;
  const yTicks = [0, 1, 2, 3].map(i => minP + yStep * i);

  // Build fill segments (green above DAM, red below)
  const greenSegs: string[] = [];
  const redSegs:   string[] = [];

  if (hasData) {
    const svgPts = points.map(p => ({ x: toX(p.minutes), y: toY(p.price) }));
    for (let i = 0; i < svgPts.length - 1; i++) {
      const p1 = svgPts[i], p2 = svgPts[i + 1];
      const a1 = p1.y <= damY, a2 = p2.y <= damY; // above = y ≤ damY in SVG coords
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

  const polyline = hasData
    ? points.map(p => `${toX(p.minutes)},${toY(p.price)}`).join(" ")
    : "";

  return (
    <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {/* Gridlines + Y labels */}
        {yTicks.map((v, i) => {
          const y = toY(v);
          return (
            <g key={i}>
              <line x1={0} y1={y} x2={CW} y2={y} stroke={S.border} strokeWidth={0.5} />
              <text x={-5} y={y + 3.5} textAnchor="end" fontSize={8.5} fill={S.faint}>
                ${v < 0 ? v.toFixed(0) : v.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* Green fill */}
        {greenSegs.length > 0 && <path d={greenSegs.join(" ")} fill={S.greenFill} />}
        {/* Red fill */}
        {redSegs.length > 0 && <path d={redSegs.join(" ")} fill={S.redFill} />}

        {/* DAM threshold line */}
        <line x1={0} y1={damY} x2={CW} y2={damY} stroke={S.blue} strokeWidth={1.5} strokeDasharray="5 3" />
        <text x={CW + 3} y={damY + 4} fontSize={8} fill={S.blue}>{`DAM $${threshold.toFixed(2)}`}</text>

        {/* RT line */}
        {hasData && (
          <polyline points={polyline} fill="none" stroke={S.text} strokeWidth={1.5} strokeLinejoin="round" />
        )}

        {/* X axis */}
        <line x1={0} y1={CH} x2={CW} y2={CH} stroke={S.border} strokeWidth={0.5} />
        {X_HOURS.map(h => (
          <text key={h} x={(h / 24) * CW} y={CH + 13} textAnchor="middle" fontSize={8} fill={S.faint}>
            {X_LABELS[h]}
          </text>
        ))}
      </g>
    </svg>
  );
}

// ── Market card ────────────────────────────────────────────────────────────────

function MarketCard({ market, points, currentPrice, isToday }: {
  market:       Market;
  points:       PricePoint[];
  currentPrice: number | null;
  isToday:      boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const avg = points.length > 0
    ? points.reduce((s, p) => s + p.price, 0) / points.length
    : null;

  return (
    <a
      href={`/markets/${market.market_id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: "block", background: S.surface, border: `1px solid ${hovered ? S.blue : S.border}`, borderRadius: "8px", overflow: "hidden", transition: "border-color 0.12s", textDecoration: "none", color: "inherit" }}
    >
      {/* Header */}
      <div style={{ padding: "14px 16px 10px" }}>
        <h3 style={{ fontWeight: 700, fontSize: "14px", marginBottom: "4px", color: S.text }}>{market.name}</h3>
        <p style={{ fontSize: "11px", color: S.muted, marginBottom: "10px" }}>
          Will the average RT price exceed ${market.threshold.toFixed(2)}/MWh?
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <div style={{ flex: 1, background: S.elevated, border: `1px solid ${S.border}`, borderRadius: "5px", padding: "6px 0", textAlign: "center" }}>
            <p style={{ fontSize: "10px", fontWeight: 700, color: S.green, marginBottom: "2px" }}>YES</p>
            <p style={{ fontSize: "16px", fontWeight: 700, color: S.green }}>
              {market.model_prob != null ? `${Math.round(market.model_prob * 100)}¢` : "50¢"}
            </p>
          </div>
          <div style={{ flex: 1, background: S.elevated, border: `1px solid ${S.border}`, borderRadius: "5px", padding: "6px 0", textAlign: "center" }}>
            <p style={{ fontSize: "10px", fontWeight: 700, color: S.red, marginBottom: "2px" }}>NO</p>
            <p style={{ fontSize: "16px", fontWeight: 700, color: S.red }}>
              {market.model_prob != null ? `${Math.round((1 - market.model_prob) * 100)}¢` : "50¢"}
            </p>
          </div>
        </div>
      </div>

      {/* Chart — no RT data for tomorrow */}
      <div style={{ padding: "4px 6px 0" }}>
        <PriceChart points={isToday ? points : []} threshold={market.threshold} />
      </div>

      {/* Stats footer — today only */}
      {isToday && (
        <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 16px 12px", borderTop: `1px solid ${S.border}`, marginTop: "4px" }}>
          <div>
            <p style={{ fontSize: "10px", color: S.faint, marginBottom: "2px" }}>Today&apos;s Avg</p>
            <p style={{ fontSize: "13px", fontWeight: 600, color: avg != null ? priceColor(avg) : S.text }}>
              {avg != null ? `$${avg.toFixed(2)}/MWh` : "—"}
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <p style={{ fontSize: "10px", color: S.faint, marginBottom: "2px" }}>Current RT</p>
            <p style={{ fontSize: "13px", fontWeight: 600, color: currentPrice != null ? priceColor(currentPrice) : S.text }}>
              {currentPrice != null ? `$${currentPrice.toFixed(2)}/MWh` : "—"}
            </p>
          </div>
        </div>
      )}
    </a>
  );
}

// ── Locked card (past midnight, awaiting settlement) ───────────────────────────

function LockedCard({ market }: { market: Market }) {
  return (
    <div style={{ background: S.elevated, border: `1px solid ${S.border}`, borderRadius: "8px", overflow: "hidden", opacity: 0.82, cursor: "default", position: "relative" }}>
      <div style={{ position: "absolute", top: "10px", right: "10px", fontSize: "13px" }}>🔒</div>
      <div style={{ padding: "14px 36px 12px 16px" }}>
        <h3 style={{ fontWeight: 700, fontSize: "14px", marginBottom: "4px", color: S.text }}>{market.name}</h3>
        <p style={{ fontSize: "11px", color: S.muted, marginBottom: "10px" }}>
          Will the average RT price exceed ${market.threshold.toFixed(2)}/MWh?
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <div style={{ flex: 1, background: S.surface, border: `1px solid ${S.border}`, borderRadius: "5px", padding: "6px 0", textAlign: "center" }}>
            <p style={{ fontSize: "10px", fontWeight: 700, color: S.green, marginBottom: "2px" }}>YES</p>
            <p style={{ fontSize: "14px", fontWeight: 700, color: S.muted }}>50¢</p>
          </div>
          <div style={{ flex: 1, background: S.surface, border: `1px solid ${S.border}`, borderRadius: "5px", padding: "6px 0", textAlign: "center" }}>
            <p style={{ fontSize: "10px", fontWeight: 700, color: S.red, marginBottom: "2px" }}>NO</p>
            <p style={{ fontSize: "14px", fontWeight: 700, color: S.muted }}>50¢</p>
          </div>
        </div>
      </div>
      <div style={{ padding: "6px 16px 10px", borderTop: `1px solid ${S.border}` }}>
        <p style={{ fontSize: "11px", color: S.faint, fontStyle: "italic" }}>Trading closed · pending settlement</p>
      </div>
    </div>
  );
}

// ── Settled card (non-interactive) ────────────────────────────────────────────

function SettledCard({ market }: { market: Market }) {
  const yesWins = market.settlement_value != null && market.settlement_value > market.threshold;
  return (
    <div style={{ background: S.elevated, border: `1px solid ${S.border}`, borderRadius: "8px", overflow: "hidden", opacity: 0.75, cursor: "default", position: "relative" }}>
      {/* Lock badge */}
      <div style={{ position: "absolute", top: "10px", right: "10px", fontSize: "13px" }}>🔒</div>

      <div style={{ padding: "14px 36px 12px 16px" }}>
        <h3 style={{ fontWeight: 700, fontSize: "14px", marginBottom: "4px", color: S.text }}>{market.name}</h3>
        <p style={{ fontSize: "11px", color: S.muted, marginBottom: "10px" }}>
          Will the average RT price exceed ${market.threshold.toFixed(2)}/MWh?
        </p>
        <div style={{ display: "flex", gap: "8px" }}>
          <div style={{ flex: 1, background: yesWins ? "#dcfce7" : S.surface, border: `2px solid ${yesWins ? S.green : S.border}`, borderRadius: "5px", padding: "6px 0", textAlign: "center" }}>
            <p style={{ fontSize: "10px", fontWeight: 700, color: S.green, marginBottom: "2px" }}>YES</p>
            <p style={{ fontSize: "14px", fontWeight: 700, color: S.green }}>{yesWins ? "✓ WON" : "—"}</p>
          </div>
          <div style={{ flex: 1, background: !yesWins ? "#fee2e2" : S.surface, border: `2px solid ${!yesWins ? S.red : S.border}`, borderRadius: "5px", padding: "6px 0", textAlign: "center" }}>
            <p style={{ fontSize: "10px", fontWeight: 700, color: S.red, marginBottom: "2px" }}>NO</p>
            <p style={{ fontSize: "14px", fontWeight: 700, color: S.red }}>{!yesWins ? "✓ WON" : "—"}</p>
          </div>
        </div>
      </div>

      {market.settlement_value != null && (
        <div style={{ padding: "6px 16px 12px", borderTop: `1px solid ${S.border}` }}>
          <p style={{ fontSize: "10px", color: S.faint, marginBottom: "2px" }}>Final RT Avg</p>
          <p style={{ fontSize: "13px", fontWeight: 600, color: priceColor(market.settlement_value) }}>
            ${market.settlement_value.toFixed(2)}/MWh
          </p>
        </div>
      )}
    </div>
  );
}

const NODE_ORDER = ["N.Y.C.", ".Z.NEMASSBOST", "TH_NP15_GEN-APND"];

// ── Page ───────────────────────────────────────────────────────────────────────

export default function MarketsPage() {
  const [markets,   setMarkets]   = useState<Market[]>([]);
  const [history,   setHistory]   = useState<Record<string, PricePoint[]>>({});
  const [livePrice, setLivePrice] = useState<Record<string, number>>({});

  const today    = etDateStr(0);
  const tomorrow = etDateStr(1);

  const fetchLive = useCallback(async () => {
    try {
      const data = await fetch("/api/prices/all", { cache: "no-store" }).then(r => r.json());
      const map: Record<string, number> = {};
      for (const z of data.zones ?? []) map[z.id] = z.price;
      setLivePrice(map);
    } catch {}
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await fetch(`/api/prices/history?date=${today}`, { cache: "no-store" }).then(r => r.json());
      const map: Record<string, PricePoint[]> = {};
      for (const row of data.rows ?? []) {
        if (!map[row.node_id]) map[row.node_id] = [];
        map[row.node_id].push({ minutes: minutesSinceMidnight(row.recorded_at), price: Number(row.price) });
      }
      for (const k of Object.keys(map)) map[k].sort((a, b) => a.minutes - b.minutes);
      setHistory(map);
    } catch {}
  }, [today]);

  useEffect(() => {
    fetch("/api/markets")
      .then(r => r.json())
      .then(data => setMarkets(Array.isArray(data) ? data.filter((m: Market) => m.status === "open" || m.status === "settled") : []))
      .catch(() => {});
    fetchHistory();
    fetchLive();
    const iv = setInterval(() => { fetchHistory(); fetchLive(); }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [fetchHistory, fetchLive]);

  function getPoints(market: Market): PricePoint[] {
    const nodeId = NODE_ID[market.node];
    return nodeId ? (history[nodeId] ?? []) : [];
  }

  function getLive(market: Market): number | null {
    const nodeId = NODE_ID[market.node];
    return nodeId != null ? (livePrice[nodeId] ?? null) : null;
  }

  function renderSection(title: string, list: Market[], isToday: boolean, emptyText?: string, pinNodes?: string[]) {
    if (list.length === 0 && !emptyText) return null;
    return (
      <section style={{ marginBottom: "40px" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 700, color: S.text, marginBottom: "14px", borderBottom: `1px solid ${S.border}`, paddingBottom: "8px" }}>
          {title}
        </h2>
        {list.length === 0 ? (
          <p style={{ fontSize: "13px", color: S.faint }}>{emptyText}</p>
        ) : pinNodes ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
            {pinNodes.map(node => {
              const m = list.find(m => m.node === node);
              return m
                ? <MarketCard key={m.market_id} market={m} points={getPoints(m)} currentPrice={getLive(m)} isToday={isToday} />
                : <div key={node} />;
            })}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(list.length, 3)}, 1fr)`, gap: "16px" }}>
            {list.map(m => (
              <MarketCard key={m.market_id} market={m} points={getPoints(m)} currentPrice={getLive(m)} isToday={isToday} />
            ))}
          </div>
        )}
      </section>
    );
  }

  // Open markets from a past operating day — past midnight but not yet settled
  const lockedMarkets   = markets.filter(m => m.status === "open" && m.resolution_date < today);
  const hasLocked       = lockedMarkets.length > 0;
  // While locked markets exist, today's open markets stay in "Tomorrow's" until settlement clears
  const todayOpenMarkets    = markets.filter(m => m.status === "open" && m.resolution_date === today);
  const tomorrowOpenMarkets = markets.filter(m => m.status === "open" && m.resolution_date === (hasLocked ? today : tomorrow));
  const settledMarkets      = markets.filter(m => m.status === "settled");

  const hasAny = lockedMarkets.length > 0 || todayOpenMarkets.length > 0 || tomorrowOpenMarkets.length > 0 || settledMarkets.length > 0;

  return (
    <main style={{ minHeight: "100vh", padding: "32px 40px", background: S.bg, color: S.text }}>
      <h1 style={{ fontSize: "22px", fontWeight: 700, marginBottom: "4px" }}>Markets</h1>
      <p style={{ fontSize: "13px", color: S.muted, marginBottom: "28px" }}>Active prediction markets.</p>

      {!hasAny ? (
        <p style={{ fontSize: "13px", color: S.faint }}>No active markets.</p>
      ) : (
        <>
          {/* Past-midnight locked markets stay in "Today's" until formally settled */}
          {lockedMarkets.length > 0 && (
            <section style={{ marginBottom: "40px" }}>
              <h2 style={{ fontSize: "15px", fontWeight: 700, color: S.text, marginBottom: "14px", borderBottom: `1px solid ${S.border}`, paddingBottom: "8px" }}>
                Today&apos;s Markets
              </h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
                {NODE_ORDER.map(node => {
                  const m = lockedMarkets.find(m => m.node === node);
                  return m ? <LockedCard key={m.market_id} market={m} /> : <div key={node} />;
                })}
              </div>
            </section>
          )}

          {/* Today's active markets — only shown once locked markets have settled */}
          {!hasLocked && renderSection("Today's Markets", todayOpenMarkets, true, undefined, NODE_ORDER)}

          {/* Tomorrow's markets — shows today's date if locked markets still exist */}
          {renderSection("Tomorrow's Markets", tomorrowOpenMarkets, false, "No markets yet.", NODE_ORDER)}

          <section style={{ marginBottom: "40px" }}>
            <h2 style={{ fontSize: "15px", fontWeight: 700, color: S.text, marginBottom: "14px", borderBottom: `1px solid ${S.border}`, paddingBottom: "8px" }}>
              Settled Markets
            </h2>
            {settledMarkets.length === 0 ? (
              <p style={{ fontSize: "13px", color: S.faint }}>No settled markets yet.</p>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
                {NODE_ORDER.map(node => {
                  const m = settledMarkets.find(m => m.node === node);
                  return m ? <SettledCard key={m.market_id} market={m} /> : <div key={node} />;
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
