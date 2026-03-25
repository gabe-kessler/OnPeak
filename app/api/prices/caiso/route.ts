import { NextResponse } from "next/server";
import AdmZip from "adm-zip";

// GET /api/prices/caiso
// Fetches the most recent CAISO real-time 5-min LMPs for the 3 main pricing hubs.
// CAISO OASIS API returns a zipped CSV — we unzip and parse it server-side.

const CAISO_NODES = [
  { id: "TH_NP15_GEN-APND", name: "NP15 — Northern CA", lat: 38.5,  lon: -121.5 },
  { id: "TH_SP15_GEN-APND", name: "SP15 — Southern CA", lat: 34.05, lon: -118.5 },
  { id: "TH_ZP26_GEN-APND", name: "ZP26 — Central CA",  lat: 36.5,  lon: -119.5 },
];

// Returns Pacific time offset in hours (-7 for PDT, -8 for PST)
function ptOffset(): number {
  const m = new Date().getUTCMonth() + 1;
  return m >= 3 && m <= 11 ? -7 : -8;
}

// Format a Date as "YYYYMMDDTHH:MM-07:00" for CAISO OASIS
function caISOTime(date: Date, offsetHrs: number): string {
  const d = new Date(date.getTime() + offsetHrs * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd   = String(d.getUTCDate()).padStart(2, "0");
  const hh   = String(d.getUTCHours()).padStart(2, "0");
  const min  = String(d.getUTCMinutes()).padStart(2, "0");
  const sign = offsetHrs < 0 ? "-" : "+";
  const absH = String(Math.abs(offsetHrs)).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}:${min}${sign}${absH}:00`;
}

async function fetchAndUnzip(url: string): Promise<string> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`CAISO HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  // Return first CSV entry
  const csv = entries.find((e) => e.entryName.endsWith(".csv"));
  if (!csv) throw new Error("No CSV found in CAISO zip");
  return zip.readAsText(csv);
}

export async function GET() {
  try {
    const offset = ptOffset();
    const now    = new Date();

    // Use a window 2-3 hours ago to ensure data is published
    const endTime   = new Date(now.getTime() - 2 * 3600 * 1000);
    const startTime = new Date(now.getTime() - 3 * 3600 * 1000);

    const nodeList = CAISO_NODES.map((n) => n.id).join(",");
    const url = `http://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP` +
      `&startdatetime=${caISOTime(startTime, offset)}` +
      `&enddatetime=${caISOTime(endTime, offset)}` +
      `&version=1&market_run_id=RTM&node=${nodeList}&resultformat=6`;

    const csv = await fetchAndUnzip(url);

    // Parse CSV
    const lines  = csv.trim().split("\n");
    const header = lines[0].split(",").map((h) => h.trim());

    const nodeIdx      = header.indexOf("NODE");
    const lmpTypeIdx   = header.indexOf("LMP_TYPE");
    const mwIdx        = header.indexOf("MW");
    const intervalIdx  = header.indexOf("OPR_INTERVAL");
    const startTimeIdx = header.indexOf("INTERVALSTARTTIME_GMT");

    if (nodeIdx === -1 || lmpTypeIdx === -1 || mwIdx === -1) {
      return NextResponse.json({ error: "Unexpected CAISO CSV format" }, { status: 500 });
    }

    // Collect most recent LMP (total only) per node
    const latest: Record<string, { price: number; interval: number; timestamp: string }> = {};

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length <= mwIdx) continue;
      if (cols[lmpTypeIdx]?.trim() !== "LMP") continue;

      const node     = cols[nodeIdx]?.trim();
      const price    = parseFloat(cols[mwIdx]?.trim());
      const interval = parseInt(cols[intervalIdx]?.trim() ?? "0");
      const ts       = cols[startTimeIdx]?.trim() ?? "";

      if (!node || isNaN(price)) continue;
      if (!latest[node] || interval > latest[node].interval) {
        latest[node] = { price, interval, timestamp: ts };
      }
    }

    const zones = CAISO_NODES
      .filter((n) => latest[n.id])
      .map((n) => ({
        id:    n.id,
        name:  n.name,
        price: latest[n.id].price,
        lat:   n.lat,
        lon:   n.lon,
      }));

    const timestamp = Object.values(latest)[0]?.timestamp ?? "";
    return NextResponse.json({ timestamp, zones });
  } catch (err) {
    console.error("CAISO price fetch error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
