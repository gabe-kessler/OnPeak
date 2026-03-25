"use client";

import { useEffect, useState } from "react";

type User = {
  user_id: string;
  username: string;
  cash_balance: number;
};

type Position = {
  market_id: string;
  name: string;
  threshold: number;
  direction: string;
  yes_qty: number;
  no_qty: number;
};

type SettledPosition = {
  market_id: string;
  name: string;
  threshold: number;
  resolution_date: string;
  settlement_value: number;
  yes_wins: boolean;
  yes_qty: number;
  no_qty: number;
};

type OpenOrder = {
  order_id: string;
  market_name: string;
  side: string;
  contract_type: string;
  order_type: string;
  display_price: string | null;
  quantity: number;
  status: string;
};

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

export default function Portfolio() {
  const [user, setUser]             = useState<User | null>(null);
  const [ready, setReady]           = useState(false);
  const [cashBalance, setCashBalance] = useState<number | null>(null);
  const [positions, setPositions]   = useState<Position[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [settledPositions, setSettledPositions] = useState<SettledPosition[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("user");
    if (!stored) { setReady(true); return; }

    const u = JSON.parse(stored) as User;
    setUser(u);

    fetch(`/api/portfolio?user_id=${u.user_id}`)
      .then((r) => r.json())
      .then((data) => {
        setCashBalance(data.cash_balance);
        setPositions(data.positions ?? []);
        setOpenOrders(data.open_orders ?? []);
        setSettledPositions(data.settled_positions ?? []);
        setReady(true);
      })
      .catch(() => setReady(true));
  }, []);

  if (!ready) return null;

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center p-8" style={{ background: S.bg, color: S.text }}>
        <div className="text-center">
          <p className="text-sm mb-4" style={{ color: S.muted }}>Sign in to view your portfolio.</p>
          <a href="/login" className="inline-block px-4 py-2 rounded text-sm font-bold" style={{ background: S.blue, color: "#ffffff" }}>
            Sign In
          </a>
        </div>
      </main>
    );
  }

  const displayBalance = cashBalance ?? user.cash_balance;

  async function cancelOrder(orderId: string) {
    if (!user) return;
    setCancelling(orderId);
    setCancelError(null);
    const res = await fetch(`/api/orders/${orderId}?user_id=${user.user_id}`, { method: "DELETE" });
    if (res.ok) {
      setOpenOrders((prev) => prev.filter((o) => o.order_id !== orderId));
      fetch(`/api/portfolio?user_id=${user.user_id}`)
        .then((r) => r.json())
        .then((data) => setCashBalance(data.cash_balance));
    } else {
      const data = await res.json();
      setCancelError(data.error ?? "Failed to cancel order.");
    }
    setCancelling(null);
  }

  const cardStyle = { background: S.surface, border: `1px solid ${S.border}` };

  return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>

      <a href="/" className="text-sm mb-6 block" style={{ color: S.muted }}>← Back</a>
      <h1 className="text-2xl font-bold mb-1">My Portfolio</h1>
      <p className="text-sm mb-6" style={{ color: S.muted }}>Positions and open orders for {user.username}</p>

      <div className="rounded p-5 mb-5" style={cardStyle}>
        <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: S.faint }}>Cash Balance</p>
        <p className="text-3xl font-bold" style={{ color: S.blue }}>
          ${Number(displayBalance).toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </p>
      </div>

      <div className="rounded p-5 mb-5" style={cardStyle}>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-4" style={{ color: S.faint }}>Current Positions</h2>
        {positions.length === 0 ? (
          <p className="text-sm" style={{ color: S.faint }}>No open positions.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: S.faint, borderBottom: `1px solid ${S.border}` }}>
                <th className="text-left pb-2 text-xs font-medium">Market</th>
                <th className="text-left pb-2 text-xs font-medium" style={{ color: S.green }}>YES</th>
                <th className="text-left pb-2 text-xs font-medium" style={{ color: S.red }}>NO</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.market_id} style={{ borderBottom: `1px solid ${S.elevated}` }}>
                  <td className="py-2.5">
                    <p className="font-medium" style={{ color: S.text }}>{p.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: S.faint }}>Line: ${Number(p.threshold).toFixed(2)} — {p.direction}</p>
                  </td>
                  <td className="py-2.5 font-semibold" style={{ color: S.green }}>{p.yes_qty > 0 ? p.yes_qty : <span style={{ color: S.faint }}>—</span>}</td>
                  <td className="py-2.5 font-semibold" style={{ color: S.red }}>{p.no_qty > 0 ? p.no_qty : <span style={{ color: S.faint }}>—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {settledPositions.length > 0 && (
        <div className="rounded p-5 mb-5" style={cardStyle}>
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-4" style={{ color: S.faint }}>Settled History</h2>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: S.faint, borderBottom: `1px solid ${S.border}` }}>
                <th className="text-left pb-2 text-xs font-medium">Market</th>
                <th className="text-left pb-2 text-xs font-medium">Result</th>
                <th className="text-left pb-2 text-xs font-medium">Your Position</th>
                <th className="text-left pb-2 text-xs font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {settledPositions.map((p) => {
                const userWon = (p.yes_wins && p.yes_qty > 0) || (!p.yes_wins && p.no_qty > 0);
                const winQty  = p.yes_wins ? p.yes_qty : p.no_qty;
                return (
                  <tr key={p.market_id} style={{ borderBottom: `1px solid ${S.elevated}` }}>
                    <td className="py-2.5">
                      <p className="font-medium" style={{ color: S.text }}>{p.name}</p>
                      <p className="text-xs mt-0.5" style={{ color: S.faint }}>
                        RT avg: ${p.settlement_value.toFixed(2)} · Line: ${p.threshold.toFixed(2)}/MWh
                      </p>
                    </td>
                    <td className="py-2.5">
                      <span className="text-xs font-bold px-1.5 py-0.5 rounded" style={{ background: p.yes_wins ? "#dcfce7" : "#fee2e2", color: p.yes_wins ? S.green : S.red }}>
                        {p.yes_wins ? "YES" : "NO"}
                      </span>
                    </td>
                    <td className="py-2.5 text-xs" style={{ color: S.muted }}>
                      {p.yes_qty > 0 && <span style={{ color: S.green }}>{p.yes_qty} YES</span>}
                      {p.yes_qty > 0 && p.no_qty > 0 && " / "}
                      {p.no_qty > 0  && <span style={{ color: S.red }}>{p.no_qty} NO</span>}
                    </td>
                    <td className="py-2.5 font-semibold text-sm" style={{ color: userWon ? S.green : S.red }}>
                      {userWon ? `+$${winQty.toFixed(2)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded p-5" style={cardStyle}>
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-4" style={{ color: S.faint }}>Pending Orders</h2>
        {cancelError && <p className="text-sm mb-3" style={{ color: S.red }}>{cancelError}</p>}
        {openOrders.length === 0 ? (
          <p className="text-sm" style={{ color: S.faint }}>No pending orders.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: S.faint, borderBottom: `1px solid ${S.border}` }}>
                <th className="text-left pb-2 text-xs font-medium">Market</th>
                <th className="text-left pb-2 text-xs font-medium">Order</th>
                <th className="text-left pb-2 text-xs font-medium">Price</th>
                <th className="text-left pb-2 text-xs font-medium">Size</th>
                <th className="text-left pb-2 text-xs font-medium">Status</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {openOrders.map((o) => (
                <tr key={o.order_id} style={{ borderBottom: `1px solid ${S.elevated}` }}>
                  <td className="py-2.5" style={{ color: S.muted }}>{o.market_name}</td>
                  <td className="py-2.5">
                    <span style={{ color: o.side === "buy" ? S.green : S.red }}>{o.side.toUpperCase()}</span>
                    <span style={{ color: S.faint }}> {o.contract_type.toUpperCase()} · {o.order_type}</span>
                  </td>
                  <td className="py-2.5" style={{ color: S.text }}>{o.display_price ? `$${o.display_price}` : "market"}</td>
                  <td className="py-2.5" style={{ color: S.text }}>{o.quantity}</td>
                  <td className="py-2.5 capitalize" style={{ color: S.faint }}>{o.status}</td>
                  <td className="py-2.5">
                    <button
                      onClick={() => cancelOrder(o.order_id)}
                      disabled={cancelling === o.order_id}
                      className="text-xs transition-colors disabled:opacity-40"
                      style={{ color: S.red }}
                    >
                      {cancelling === o.order_id ? "Cancelling..." : "Cancel"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

    </main>
  );
}
