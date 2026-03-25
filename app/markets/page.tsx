"use client";

import { useEffect, useState } from "react";

type Market = {
  market_id: string;
  name: string;
  threshold: number;
  resolution_date: string;
  status: string;
  best_yes_ask: number | null;
  best_no_ask: number | null;
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

export default function MarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);

  useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json())
      .then((data) => setMarkets(Array.isArray(data) ? data.filter((m: Market) => m.status === "open") : []))
      .catch(() => {});
  }, []);

  return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>
      <h1 className="text-2xl font-bold mb-1">Markets</h1>
      <p className="text-sm mb-8" style={{ color: S.muted }}>Active prediction markets for today's operating day.</p>

      {markets.length === 0 ? (
        <p className="text-sm" style={{ color: S.faint }}>No active markets.</p>
      ) : (
        <div className="flex flex-col gap-3 max-w-2xl">
          {markets.map((m) => (
            <a
              key={m.market_id}
              href={`/markets/${m.market_id}`}
              className="block rounded p-5 transition-colors duration-150"
              style={{ background: S.surface, border: `1px solid ${S.border}` }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = S.blue)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = S.border)}
            >
              <h2 className="text-base font-semibold mb-1">{m.name}</h2>
              <p className="text-sm mb-4" style={{ color: S.muted }}>
                Will the average RT price exceed ${m.threshold.toFixed(2)}/MWh?
              </p>
              <div className="flex gap-3">
                <div className="rounded p-3 flex-1 text-center" style={{ background: S.elevated, border: `1px solid ${S.border}` }}>
                  <p className="text-xs mb-1 font-semibold" style={{ color: S.green }}>YES</p>
                  <p className="font-bold text-lg" style={{ color: S.green }}>
                    {m.best_yes_ask != null ? `$${m.best_yes_ask.toFixed(2)}` : "—"}
                  </p>
                </div>
                <div className="rounded p-3 flex-1 text-center" style={{ background: S.elevated, border: `1px solid ${S.border}` }}>
                  <p className="text-xs mb-1 font-semibold" style={{ color: S.red }}>NO</p>
                  <p className="font-bold text-lg" style={{ color: S.red }}>
                    {m.best_no_ask != null ? `$${m.best_no_ask.toFixed(2)}` : "—"}
                  </p>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
