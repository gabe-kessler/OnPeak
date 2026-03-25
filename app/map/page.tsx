"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import dynamic from "next/dynamic";

const LeafletMap = dynamic(() => import("@/components/LeafletMap"), { ssr: false });

function priceColor(price: number): string {
  if (price < 0)   return "#033d8b";  // deep navy
  if (price < 20)  return "#0969da";  // strong blue
  if (price < 40)  return "#54aeff";  // sky blue
  if (price < 60)  return "#d4a017";  // amber
  if (price < 100) return "#e16f24";  // orange
  if (price < 200) return "#cf222e";  // red
  return "#82071e";                   // deep red
}

const LEGEND = [
  { label: "< $0",     color: "#033d8b" },
  { label: "$0–20",    color: "#0969da" },
  { label: "$20–40",   color: "#54aeff" },
  { label: "$40–60",   color: "#d4a017" },
  { label: "$60–100",  color: "#e16f24" },
  { label: "$100–200", color: "#cf222e" },
  { label: "> $200",   color: "#82071e" },
];

export type Zone = {
  id: string;
  name: string;
  price: number;
  dam_price: number | null;
  lat: number;
  lon: number;
  timestamp: string;
};

export type Market = {
  market_id: string;
  name: string;
  node: string;
  resolution_date: string;
  threshold: number;
  direction: string;
  status: string;
  best_yes_ask: number | null;
  best_no_ask: number | null;
};

const REFRESH_MS = 5 * 60 * 1000;

const S = {
  bg: "#f6f8fa",
  surface: "#ffffff",
  elevated: "#f0f3f6",
  border: "#d0d7de",
  text: "#1f2328",
  muted: "#656d76",
  faint: "#8c959f",
  blue: "#0969da",
  red: "#cf222e",
};

export { priceColor };

// ── time-slider helpers ────────────────────────────────────────────────────────

// Convert any ISO 8601 timestamp → ET slot index (0–287, 5-min slots per day)
function tsToSlot(ts: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ts));
    const h = parseInt(parts.find(p => p.type === "hour")!.value) % 24;
    const m = parseInt(parts.find(p => p.type === "minute")!.value);
    if (isNaN(h) || isNaN(m)) return -1;
    return h * 12 + Math.floor(m / 5);
  } catch { return -1; }
}

// Slot index → "H:MM AM/PM ET"
function slotTimeLabel(slot: number): string {
  const h  = Math.floor(slot / 12) % 24;
  const m  = (slot % 12) * 5;
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ET`;
}

// ET offset string, client-side
function etOffStr(): string {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? "-04:00" : "-05:00";
}

// Slot index → ISO 8601 timestamp in ET (for tooltip display)
function slotToISO(slot: number, etDateStr: string): string {
  const h = Math.floor(slot / 12) % 24;
  const m = (slot % 12) * 5;
  return `${etDateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00${etOffStr()}`;
}

// Slot index + ET date string → full label "Mar 24, 2026 8:10 PM ET"
function slotFullLabel(slot: number, etDateStr: string): string {
  const h   = Math.floor(slot / 12) % 24;
  const m   = (slot % 12) * 5;
  const [y, mo, d] = etDateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, mo - 1, d));
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${months[base.getUTCMonth()]} ${base.getUTCDate()}, ${y}  ${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} ET`;
}

// ── static zone metadata (lat/lon never changes) ──────────────────────────────
// Used as fallback so zones missing from the live API still render on the map.

const ZONE_META: Record<string, { name: string; lat: number; lon: number }> = {
  "NYISO_N.Y.C.":            { name: "New York City (Zone J)", lat: 40.71,  lon: -74.01  },
  "ISONE_.Z.NEMASSBOST":     { name: "Boston (NEMASSBOST)",    lat: 42.36,  lon: -71.06  },
  "CAISO_TH_NP15_GEN-APND": { name: "Bay Area (NP15)",        lat: 37.77,  lon: -122.42 },
};

// ── component ─────────────────────────────────────────────────────────────────

export default function MapPage() {
  const [zones, setZones]           = useState<Zone[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Markets + auth — fetched once on mount
  const [markets, setMarkets]       = useState<Market[]>([]);
  const [userId, setUserId]         = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("user");
      if (raw) setUserId(JSON.parse(raw)?.user_id ?? null);
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/api/markets")
      .then(r => r.json())
      .then((data: Market[]) => {
        if (Array.isArray(data)) setMarkets(data.filter(m => m.status === "open"));
      })
      .catch(() => {});
  }, []);

  // Price history: slot index → (zoneId → price)
  const [priceHistory, setPriceHistory] = useState<Map<number, Map<string, number>>>(new Map());
  const [latestSlot, setLatestSlot]     = useState<number>(0);
  // selectedSlot === -1 means "LATEST" (follow live data)
  const [selectedSlot, setSelectedSlot] = useState<number>(-1);

  // ET operating day for this session (resets on navigation)
  const etDate = useRef(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()));

  const isAtLatest  = selectedSlot === -1;
  const sliderValue = isAtLatest ? latestSlot : selectedSlot;

  // Uncontrolled range input — we drive it via ref so React never re-positions
  // the hidden thumb mid-drag (which caused the snap-back glitch).
  const rangeRef    = useRef<HTMLInputElement>(null);
  const isDragging  = useRef(false);

  useEffect(() => {
    if (!isDragging.current && rangeRef.current) {
      rangeRef.current.value = String(sliderValue);
    }
  }, [sliderValue]);

  // ── fetch live prices ────────────────────────────────────────────────────────

  const fetchPrices = useCallback(async () => {
    try {
      const res      = await fetch("/api/prices/all", { cache: "no-store" });
      const data     = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to fetch prices."); return; }
      const newZones = data.zones ?? [];
      setZones(newZones);
      setLastUpdated(new Date());
      setError(null);

      // Add the new reading to in-memory history and advance latestSlot
      if (newZones.length > 0) {
        const slot = tsToSlot(newZones[0].timestamp);
        if (slot >= 0) {
          setPriceHistory(prev => {
            const next = new Map(prev);
            const sm   = new Map(next.get(slot) ?? []);
            for (const z of newZones) sm.set(z.id, z.price);
            next.set(slot, sm);
            return next;
          });
          setLatestSlot(s => Math.max(s, slot));
        }
      }
    } catch {
      setError("Could not reach price API.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + 5-min auto-refresh
  useEffect(() => {
    fetchPrices();
    const iv = setInterval(fetchPrices, REFRESH_MS);
    return () => clearInterval(iv);
  }, [fetchPrices]);

  // ── load today's stored history on mount ─────────────────────────────────────

  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    etDate.current = today;
    setHistoryLoading(true);

    fetch(`/api/prices/history?date=${today}`, { cache: "no-store" })
      .then(r => r.json())
      .then((data: { rows: { node_id: string; price: number; recorded_at: string }[] }) => {
        if (!data || !Array.isArray(data.rows)) return;
        const hist = new Map<number, Map<string, number>>();
        for (const row of data.rows) {
          const slot = tsToSlot(row.recorded_at);
          if (slot < 0) continue;
          if (!hist.has(slot)) hist.set(slot, new Map());
          hist.get(slot)!.set(row.node_id, Number(row.price));
        }
        setPriceHistory(hist);
        if (hist.size > 0) setLatestSlot(prev => Math.max(prev, ...hist.keys()));
      })
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, []);

  // ── zones to display (live or historical) ────────────────────────────────────

  const displayZones = useMemo(() => {
    // Per-zone nearest-before lookup.
    // Each zone independently finds the closest historical slot ≤ targetSlot
    // that has data for that specific zone.  Using a single shared "bestSlot"
    // breaks Boston because NYISO fills all 288 slots and its best slot almost
    // never has Boston data.
    function nearestFor(id: string, targetSlot: number): { price: number; slot: number } | null {
      let best: { price: number; slot: number } | null = null;
      for (const [s, sm] of priceHistory.entries()) {
        if (s <= targetSlot && sm.has(id) && (!best || s > best.slot)) {
          best = { price: sm.get(id)!, slot: s };
        }
      }
      return best;
    }

    const targetSlot = isAtLatest ? latestSlot : selectedSlot;

    // Update live zones with historical prices when scrubbing;
    // in LIVE mode keep the prices exactly as returned by the API.
    const result: Zone[] = zones.map(z => {
      if (isAtLatest) return z;
      const h = nearestFor(z.id, targetSlot);
      if (!h) return z;
      return { ...z, price: h.price, timestamp: slotToISO(h.slot, etDate.current) };
    });

    // Append any ZONE_META zone that has history data but is absent from the
    // live API response (e.g. CAISO when OASIS is down).
    const liveIds = new Set(zones.map(z => z.id));
    for (const [id, meta] of Object.entries(ZONE_META)) {
      if (liveIds.has(id)) continue;
      const h = nearestFor(id, targetSlot);
      if (!h) continue;
      result.push({
        id, name: meta.name, lat: meta.lat, lon: meta.lon,
        price: h.price, dam_price: null,
        timestamp: slotToISO(h.slot, etDate.current),
      });
    }

    return result;
  }, [isAtLatest, selectedSlot, latestSlot, zones, priceHistory]);

  // ── slider step helpers ───────────────────────────────────────────────────────

  function stepBack() {
    const cur = isAtLatest ? latestSlot : selectedSlot;
    if (cur > 0) setSelectedSlot(cur - 1);
  }

  // ── live date/time label (right side of slider) ───────────────────────────────

  const dateLabel = isAtLatest
    ? (zones[0]?.timestamp
        ? new Date(zones[0].timestamp).toLocaleString("en-US", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit",
            timeZone: "America/New_York", timeZoneName: "short",
          })
        : "")
    : slotFullLabel(selectedSlot, etDate.current);

  // ── pill position calculation ─────────────────────────────────────────────────
  // Track always represents full 24h (288 slots 0–287). Pill moves to sliderValue/287.

  const TOTAL_SLOTS = 287;
  const PILL_W      = 108; // px — width of the pill label
  const pct         = sliderValue / TOTAL_SLOTS;
  const pillLeft    = `calc(${PILL_W / 2}px + ${pct} * (100% - ${PILL_W}px))`;

  return (
    <main className="min-h-screen p-8" style={{ background: S.bg, color: S.text }}>

      <div style={{ maxWidth: "1400px", margin: "0 auto 20px" }}>
        <h1 className="text-2xl font-bold mb-1">Live LMP Map</h1>
        {/* Subtitle row — NYISO text left-aligned, hover hint centered over full width */}
        <div style={{ position: "relative" }}>
          <p className="text-sm" style={{ color: S.muted }}>
            NYISO · ISO-NE · CAISO — real-time 5-min LMPs
          </p>
          <span className="text-xs" style={{
            position: "absolute", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            color: S.faint, whiteSpace: "nowrap", pointerEvents: "none",
          }}>
            Hover over nodes to see live prices. Click to Trade.
          </span>
        </div>
        {lastUpdated && (
          <p className="text-xs mt-1" style={{ color: S.faint }}>
            Updated {lastUpdated.toLocaleTimeString()} · refreshes every 5 min
          </p>
        )}
      </div>

      {error && <p className="text-sm mb-4" style={{ color: S.red, maxWidth: "1400px", margin: "0 auto 16px" }}>{error}</p>}

      {loading ? (
        <p className="text-sm" style={{ color: S.faint }}>Loading prices...</p>
      ) : (
        <div style={{ maxWidth: "1400px", margin: "0 auto" }}>

          {/* ── Time slider ─────────────────────────────────────────────────── */}
          {historyLoading && (
            <p className="text-xs mb-2" style={{ color: S.faint }}>Loading today's price history…</p>
          )}
          {latestSlot > 0 && (
            <div className="mb-3">

              {/* Row: ◀  [track]  ▶  LIVE
                  LIVE is always rendered (visibility:hidden when at latest) so the
                  track's flex-1 width never changes mid-drag — that layout shift was
                  the root cause of the snap-back oscillation near the right edge. */}
              <div className="flex items-center gap-2">

                {/* Step back */}
                <button
                  onClick={stepBack}
                  disabled={sliderValue === 0}
                  className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded disabled:opacity-30"
                  style={{ background: S.elevated, border: `1px solid ${S.border}`, color: S.muted, fontSize: "11px" }}
                >◀</button>

                {/* Track + pill */}
                <div style={{ flex: 1, position: "relative", height: "36px" }}>
                  {/* Full-day track (light = future / no data) */}
                  <div style={{
                    position: "absolute", top: "50%", transform: "translateY(-50%)",
                    width: "100%", height: "6px", borderRadius: "3px", background: "#d0d7de",
                  }} />
                  {/* Elapsed/available portion (dark) */}
                  <div style={{
                    position: "absolute", top: "50%", transform: "translateY(-50%)",
                    width: `${(latestSlot / TOTAL_SLOTS) * 100}%`,
                    height: "6px", borderRadius: "3px", background: "#24292f",
                    pointerEvents: "none",
                  }} />
                  {/* Pill label — tracks the thumb */}
                  <div style={{
                    position: "absolute", top: "50%",
                    left: pillLeft,
                    transform: "translate(-50%, -50%)",
                    background: S.surface,
                    border: `1px solid ${S.border}`,
                    borderRadius: "999px",
                    padding: "3px 0",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: S.text,
                    whiteSpace: "nowrap",
                    pointerEvents: "none",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                    width: `${PILL_W}px`,
                    textAlign: "center",
                  }}>
                    {isAtLatest ? "LATEST ◈" : slotTimeLabel(selectedSlot)}
                  </div>
                  {/* Invisible range input — uncontrolled, driven via rangeRef */}
                  <input
                    ref={rangeRef}
                    type="range"
                    min={0}
                    max={TOTAL_SLOTS}
                    defaultValue={0}
                    onPointerDown={() => { isDragging.current = true; }}
                    onPointerUp={() => { isDragging.current = false; }}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      if (v >= latestSlot) {
                        setSelectedSlot(-1);
                      } else if (isAtLatest && v > latestSlot - 6) {
                        // Deadband: stay in LATEST for first 6 slots (~30 min) of leftward drag
                      } else {
                        setSelectedSlot(v);
                      }
                    }}
                    style={{
                      position: "absolute", top: 0, left: 0,
                      width: "100%", height: "100%",
                      opacity: 0, cursor: "pointer", margin: 0,
                    }}
                  />
                </div>

                {/* LIVE — always in layout so track width stays constant */}
                <button
                  onClick={() => setSelectedSlot(-1)}
                  className="flex-shrink-0 text-xs font-bold px-2.5 py-1 rounded"
                  style={{
                    background: S.blue, color: "#ffffff", border: "none", whiteSpace: "nowrap",
                    visibility: isAtLatest ? "hidden" : "visible",
                    pointerEvents: isAtLatest ? "none" : "auto",
                  }}
                >▶| LIVE</button>

              </div>

              {/* Date/time label — own row so the pill can never overlap it */}
              <div
                className="text-xs mt-1"
                style={{
                  color: S.muted,
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "right",
                  paddingRight: "2px",
                }}
              >
                {dateLabel}
              </div>

            </div>
          )}

          {/* ── Map ─────────────────────────────────────────────────────────── */}
          <div className="rounded overflow-hidden mb-4" style={{ border: `1px solid ${S.border}`, height: "700px" }}>
            <LeafletMap zones={displayZones} priceColor={priceColor} markets={markets} userId={userId} />
          </div>

          {/* ── Legend ──────────────────────────────────────────────────────── */}
          <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: S.faint }}>LMP ($/MWh)</span>
            {LEGEND.map((l) => (
              <div key={l.label} className="flex items-center gap-1.5" style={{ color: S.muted }}>
                <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                <span className="text-xs">{l.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
