"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { Zone, Market } from "@/app/map/page";

// Map zone IDs → market node identifiers (as stored in the markets table)
const ZONE_NODE: Record<string, string> = {
  "NYISO_N.Y.C.":            "N.Y.C.",
  "ISONE_.Z.NEMASSBOST":     ".Z.NEMASSBOST",
  "CAISO_TH_NP15_GEN-APND": "TH_NP15_GEN-APND",
};

function FitBounds() {
  const map = useMap();
  useEffect(() => { map.setView([41, -90], 4); }, [map]);
  return null;
}

// "Today" / "Tomorrow" / "Mar 25" label for an operating day
function dayLabel(iso: string): string {
  const fmtET = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
  const today    = fmtET(new Date());
  const tomorrow = fmtET(new Date(Date.now() + 86_400_000));
  const mktDay   = fmtET(new Date(iso + "T12:00:00"));
  if (mktDay === today)    return "Today";
  if (mktDay === tomorrow) return "Tomorrow";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Mini market popup ──────────────────────────────────────────────────────────

function MarketPanel({
  zone, fill, zoneMarkets, userId,
}: {
  zone:        Zone;
  fill:        string;
  zoneMarkets: Market[];
  userId:      string | null;
}) {
  // Sort so today's market always appears first, tomorrow's second
  const sorted = [...zoneMarkets].sort((a, b) =>
    a.resolution_date.localeCompare(b.resolution_date)
  );

  const [tabIdx, setTabIdx] = useState(0);
  const [qty, setQty]       = useState(1);
  const [busy, setBusy]     = useState(false);
  const [msg, setMsg]       = useState<{ ok: boolean; text: string } | null>(null);

  // Reset tab when available markets change
  useEffect(() => { setTabIdx(0); setMsg(null); }, [sorted.length]);

  const market = sorted[tabIdx] ?? null;

  const diff = market ? zone.price - market.threshold : null;
  const pct  = diff != null && market && market.threshold !== 0
    ? (diff / Math.abs(market.threshold)) * 100 : null;

  async function placeOrder(side: "yes" | "no") {
    if (!userId || !market) return;
    setBusy(true);
    setMsg(null);
    try {
      const res  = await fetch("/api/orders", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          user_id:       userId,
          market_id:     market.market_id,
          side:          "buy",
          contract_type: side,
          order_type:    "market",
          quantity:      qty,
        }),
      });
      const data = await res.json();
      setMsg({ ok: res.ok, text: res.ok ? "Order placed!" : (data.error ?? "Error placing order.") });
    } catch {
      setMsg({ ok: false, text: "Network error." });
    } finally {
      setBusy(false);
    }
  }

  const yesCents = market?.best_yes_ask != null ? Math.round(market.best_yes_ask * 100) : null;
  const noCents  = market?.best_no_ask  != null ? Math.round(market.best_no_ask  * 100) : null;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", width: "256px" }}>

      {/* Zone name */}
      <div style={{ fontWeight: 700, fontSize: "14px", color: "#1f2328", marginBottom: "10px" }}>
        {zone.name}
      </div>

      {/* No markets at all */}
      {sorted.length === 0 && (
        <div style={{ fontSize: "12px", color: "#8c959f", textAlign: "center", padding: "14px 0" }}>
          No active markets yet
        </div>
      )}

      {sorted.length > 0 && (
        <>
          {/* Operating-day tabs — only shown when 2 markets are open simultaneously */}
          {sorted.length > 1 && (
            <div style={{ display: "flex", gap: "4px", marginBottom: "10px" }}>
              {sorted.map((m, i) => (
                <button
                  key={m.market_id}
                  onClick={() => { setTabIdx(i); setMsg(null); }}
                  style={{
                    flex: 1, padding: "5px 0",
                    fontSize: "11px", fontWeight: tabIdx === i ? 700 : 400,
                    border:     `1px solid ${tabIdx === i ? "#0969da" : "#d0d7de"}`,
                    borderRadius: "4px",
                    background: tabIdx === i ? "#ddf4ff" : "#ffffff",
                    color:      tabIdx === i ? "#0969da" : "#656d76",
                    cursor: "pointer",
                  }}
                >
                  {dayLabel(m.resolution_date)}
                  <div style={{ fontSize: "10px", fontWeight: 400, marginTop: "1px", color: tabIdx === i ? "#0969da" : "#8c959f" }}>
                    {new Date(m.resolution_date + "T12:00:00")
                      .toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* RT + threshold price block */}
          {market && (
            <div style={{ background: "#f6f8fa", borderRadius: "6px", padding: "8px 10px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "3px" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#656d76" }}>Live RT</span>
                <span style={{ fontSize: "16px", fontWeight: 700, color: fill }}>
                  ${zone.price.toFixed(2)}<span style={{ fontSize: "10px", color: "#8c959f" }}>/MWh</span>
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#656d76" }}>DAM Threshold</span>
                <span style={{ fontSize: "13px", color: "#656d76" }}>
                  ${market.threshold.toFixed(2)}<span style={{ fontSize: "10px", color: "#8c959f" }}>/MWh</span>
                </span>
              </div>
              {pct != null && (
                <div style={{ textAlign: "right", marginTop: "3px", fontSize: "11px", fontWeight: 600, color: diff! > 0 ? "#cf222e" : "#1a7f37" }}>
                  {diff! > 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% vs threshold
                </div>
              )}
            </div>
          )}

          {/* Trade section */}
          {market && (
            <div style={{ borderTop: "1px solid #d0d7de", paddingTop: "10px" }}>

              {/* Current ask prices */}
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}>
                <span style={{ fontSize: "10px", color: "#8c959f" }}>
                  YES ask: <strong style={{ color: "#1a7f37" }}>{yesCents != null ? `${yesCents}¢` : "—"}</strong>
                </span>
                <span style={{ fontSize: "10px", color: "#8c959f" }}>
                  NO ask: <strong style={{ color: "#cf222e" }}>{noCents != null ? `${noCents}¢` : "—"}</strong>
                </span>
              </div>

              {/* Quantity input */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                <label style={{ fontSize: "12px", color: "#656d76" }}>Contracts</label>
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))}
                  style={{ width: "60px", padding: "4px 6px", border: "1px solid #d0d7de", borderRadius: "4px", fontSize: "12px", textAlign: "center" }}
                />
              </div>

              {/* Buy buttons or sign-in prompt */}
              {userId ? (
                <div style={{ display: "flex", gap: "6px" }}>
                  <button
                    onClick={() => placeOrder("yes")}
                    disabled={busy}
                    style={{ flex: 1, padding: "8px 0", background: "#1a7f37", color: "#fff", border: "none", borderRadius: "5px", fontWeight: 700, fontSize: "12px", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}
                  >
                    YES{yesCents != null ? ` · ${yesCents}¢` : ""}
                  </button>
                  <button
                    onClick={() => placeOrder("no")}
                    disabled={busy}
                    style={{ flex: 1, padding: "8px 0", background: "#cf222e", color: "#fff", border: "none", borderRadius: "5px", fontWeight: 700, fontSize: "12px", cursor: busy ? "wait" : "pointer", opacity: busy ? 0.7 : 1 }}
                  >
                    NO{noCents != null ? ` · ${noCents}¢` : ""}
                  </button>
                </div>
              ) : (
                <a
                  href="/login"
                  style={{ display: "block", textAlign: "center", padding: "8px 0", background: "#f6f8fa", border: "1px solid #d0d7de", borderRadius: "5px", fontSize: "12px", color: "#0969da", textDecoration: "none" }}
                >
                  Sign in to trade
                </a>
              )}

              {/* Order result message */}
              {msg && (
                <div style={{ marginTop: "7px", padding: "6px 8px", borderRadius: "4px", fontSize: "11px", textAlign: "center", background: msg.ok ? "#dafbe1" : "#ffebe9", color: msg.ok ? "#1a7f37" : "#cf222e" }}>
                  {msg.text}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Map component ──────────────────────────────────────────────────────────────

interface Props {
  zones:      Zone[];
  priceColor: (price: number) => string;
  markets:    Market[];
  userId:     string | null;
}

export default function LeafletMap({ zones, priceColor, markets, userId }: Props) {
  // Track which zone's popup is open so we can suppress all tooltips
  const [openZoneId, setOpenZoneId] = useState<string | null>(null);

  return (
    <MapContainer
      center={[41, -90]}
      zoom={4}
      style={{ height: "100%", width: "100%" }}
      scrollWheelZoom
      zoomControl
    >
      {/* CartoDB Voyager — light terrain style with city/state labels, free, no API key */}
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
        subdomains="abcd"
        maxZoom={19}
      />

      <FitBounds />

      {zones.map((zone) => {
        const fill        = priceColor(zone.price);
        const node        = ZONE_NODE[zone.id] ?? "";
        const zoneMarkets = markets.filter(m => m.node === node && m.status === "open");

        return (
          <CircleMarker
            key={zone.id}
            center={[zone.lat, zone.lon]}
            radius={15}
            pathOptions={{ fillColor: fill, fillOpacity: 1, color: "#ffffff", weight: 3 }}
            eventHandlers={{
              popupopen:  () => setOpenZoneId(zone.id),
              popupclose: () => setOpenZoneId(null),
            }}
          >
            {/* Tooltip suppressed while any popup is open */}
            {openZoneId === null && (
              <Tooltip sticky>
                <div style={{ fontFamily: "system-ui, sans-serif", minWidth: "130px" }}>
                  <div style={{ fontWeight: 700, marginBottom: "4px", fontSize: "13px", color: "#1f2328" }}>{zone.name}</div>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: fill, marginBottom: "4px" }}>
                    ${zone.price.toFixed(2)}<span style={{ fontSize: "11px", fontWeight: 400, color: "#656d76" }}>/MWh</span>
                  </div>
                  {zone.timestamp && (
                    <div style={{ fontSize: "10px", color: "#8c959f" }}>
                      {(() => {
                        try {
                          return new Date(zone.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" }) + " ET";
                        } catch { return zone.timestamp; }
                      })()}
                    </div>
                  )}
                </div>
              </Tooltip>
            )}

            {/* Click to open mini market — closes on map click or second dot click */}
            <Popup minWidth={260} maxWidth={300} closeButton>
              <MarketPanel zone={zone} fill={fill} zoneMarkets={zoneMarkets} userId={userId} />
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
