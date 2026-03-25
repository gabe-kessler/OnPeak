"use client";

import { useEffect, useState } from "react";

type Market = {
  market_id: string;
  name: string;
  threshold: number;
  resolution_date: string;
  best_yes_ask: number | null;
  best_no_ask: number | null;
  orderbook: { side: string; contract_type: string; display_price: string; quantity: number }[];
};

type User = { user_id: string; username: string; cash_balance: number };

const S = {
  bg: "#f6f8fa",
  surface: "#ffffff",
  elevated: "#f0f3f6",
  border: "#d0d7de",
  text: "#1f2328",
  muted: "#656d76",
  faint: "#8c959f",
  blue: "#0969da",
  green: "#1a7f37",
  red: "#cf222e",
};

export default function NYCMarket() {
  const [user, setUser]       = useState<User | null>(null);
  const [market, setMarket]   = useState<Market | null>(null);
  const [loading, setLoading] = useState(true);
  const [contractType, setContractType] = useState<"yes" | "no">("yes");
  const [orderType, setOrderType]       = useState<"limit" | "market">("limit");
  const [price, setPrice]               = useState("");
  const [quantity, setQuantity]         = useState("");
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [success, setSuccess]           = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (stored) setUser(JSON.parse(stored));
    fetch("/api/markets").then(r => r.json()).then(data => { if (data.length > 0) setMarket(data[0]); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !market) return;
    setSubmitting(true); setError(null); setSuccess(null);
    const body: Record<string, unknown> = { user_id: user.user_id, market_id: market.market_id, side: "buy", contract_type: contractType, order_type: orderType, quantity: parseInt(quantity) };
    if (orderType === "limit") body.price = parseFloat(price);
    const res  = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setError(data.error ?? "Something went wrong."); } else { setSuccess("Order placed!"); setPrice(""); setQuantity(""); fetch("/api/markets").then(r => r.json()).then(d => { if (d.length > 0) setMarket(d[0]); }); }
    setSubmitting(false);
  }

  if (loading) return <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}><p style={{ color: S.faint }}>Loading...</p></main>;
  if (!market) return <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}><a href="/" style={{ color: S.muted }} className="text-sm mb-6 block">← Back</a><p style={{ color: S.faint }}>No active market.</p></main>;

  const cardStyle = { background: S.surface, border: `1px solid ${S.border}` };
  const inputStyle = { width: "100%", background: S.surface, border: `1px solid ${S.border}`, borderRadius: "4px", padding: "8px 12px", color: S.text, fontSize: "14px", outline: "none" };

  return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>
      <a href="/" className="text-sm mb-6 block" style={{ color: S.muted }}>← Back</a>
      <h1 className="text-2xl font-bold mb-1">{market.name}</h1>
      <p className="text-sm mb-6" style={{ color: S.muted }}>
        Will the NYC average DALMP exceed <span className="font-semibold" style={{ color: S.blue }}>${market.threshold.toFixed(2)}/MWh</span>?
      </p>

      <div className="rounded p-4 mb-5" style={cardStyle}>
        <p className="text-xs mb-1 font-medium uppercase tracking-wide" style={{ color: S.faint }}>Betting Line</p>
        <p className="text-2xl font-bold" style={{ color: S.blue }}>${market.threshold.toFixed(2)} <span className="text-base font-normal" style={{ color: S.muted }}>/MWh</span></p>
      </div>

      <div className="flex gap-3 mb-5">
        <div className="rounded p-4 flex-1 text-center" style={cardStyle}>
          <p className="text-xs mb-1 font-bold uppercase" style={{ color: S.green }}>YES</p>
          <p className="font-bold text-2xl" style={{ color: S.green }}>{market.best_yes_ask ? `$${market.best_yes_ask.toFixed(2)}` : "—"}</p>
          <p className="text-xs mt-1" style={{ color: S.faint }}>best ask</p>
        </div>
        <div className="rounded p-4 flex-1 text-center" style={cardStyle}>
          <p className="text-xs mb-1 font-bold uppercase" style={{ color: S.red }}>NO</p>
          <p className="font-bold text-2xl" style={{ color: S.red }}>{market.best_no_ask ? `$${market.best_no_ask.toFixed(2)}` : "—"}</p>
          <p className="text-xs mt-1" style={{ color: S.faint }}>best ask</p>
        </div>
      </div>

      {user ? (
        <div className="rounded p-5 mb-5" style={cardStyle}>
          <h2 className="text-xs font-bold uppercase tracking-wide mb-4" style={{ color: S.faint }}>Place Order</h2>
          <div className="flex gap-2 mb-4">
            {(["yes", "no"] as const).map(t => (
              <button key={t} type="button" onClick={() => setContractType(t)} className="flex-1 py-2 rounded text-sm font-bold transition-colors"
                style={{ background: contractType === t ? (t === "yes" ? S.green : S.red) : S.elevated, color: contractType === t ? "#000" : S.muted, border: `1px solid ${contractType === t ? (t === "yes" ? S.green : S.red) : S.border}` }}>
                BUY {t.toUpperCase()}
              </button>
            ))}
          </div>
          <form onSubmit={handleSubmit}>
            <div className="flex gap-3 mb-4">
              {orderType === "limit" && (
                <div className="flex-1">
                  <p className="text-xs mb-1" style={{ color: S.muted }}>Price ($)</p>
                  <input type="number" step="0.01" min="0.01" max="0.99" value={price} onChange={e => setPrice(e.target.value)} required style={inputStyle} placeholder="0.55" />
                </div>
              )}
              <div className="flex-1">
                <p className="text-xs mb-1" style={{ color: S.muted }}>Size (contracts)</p>
                <input type="number" min="1" step="1" value={quantity} onChange={e => setQuantity(e.target.value)} required style={inputStyle} placeholder="10" />
              </div>
            </div>
            <div className="flex gap-2 mb-4">
              {(["limit", "market"] as const).map(t => (
                <button key={t} type="button" onClick={() => setOrderType(t)} className="flex-1 py-1.5 rounded text-sm transition-colors capitalize"
                  style={{ background: orderType === t ? S.blue : S.elevated, color: orderType === t ? "#000" : S.muted, border: `1px solid ${orderType === t ? S.blue : S.border}` }}>
                  {t}
                </button>
              ))}
            </div>
            {error   && <p className="text-sm mb-3" style={{ color: S.red }}>{error}</p>}
            {success && <p className="text-sm mb-3" style={{ color: S.green }}>{success}</p>}
            <button type="submit" disabled={submitting} className="w-full py-2 rounded font-bold text-sm disabled:opacity-50" style={{ background: S.blue, color: "#ffffff" }}>
              {submitting ? "Placing..." : `Place ${orderType} — BUY ${contractType.toUpperCase()}`}
            </button>
          </form>
        </div>
      ) : (
        <div className="rounded p-5 mb-5 text-center" style={cardStyle}>
          <p className="text-sm mb-3" style={{ color: S.muted }}>Sign in to place orders.</p>
          <a href="/login" className="inline-block px-4 py-2 rounded font-bold text-sm" style={{ background: S.blue, color: "#ffffff" }}>Sign In</a>
        </div>
      )}

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
    </main>
  );
}
