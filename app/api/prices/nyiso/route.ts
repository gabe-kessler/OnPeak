import { NextResponse } from "next/server";

// GET /api/prices/nyiso
// Fetches the most recent NYISO real-time 5-min zone LBMP CSV and returns
// parsed prices for all zones.

// Approximate geographic centers for each NYISO zone
const ZONE_COORDS: Record<string, { name: string; lat: number; lon: number }> = {
  "WEST":    { name: "West (A)",          lat: 42.88, lon: -78.88 },
  "GENESE":  { name: "Genesee (B)",       lat: 43.05, lon: -77.60 },
  "CENTRL":  { name: "Central (C)",       lat: 43.10, lon: -76.10 },
  "NORTH":   { name: "North (D)",         lat: 44.20, lon: -73.80 },
  "MHK VL":  { name: "Mohawk Valley (E)", lat: 43.00, lon: -75.00 },
  "CAPITL":  { name: "Capital (F)",       lat: 42.75, lon: -73.75 },
  "HUD VL":  { name: "Hudson Valley (G)", lat: 41.70, lon: -73.95 },
  "MILLWD":  { name: "Millwood (H)",      lat: 41.20, lon: -73.80 },
  "DUNWOD":  { name: "Dunwoodie (I)",     lat: 40.95, lon: -73.87 },
  "N.Y.C.":  { name: "New York City (J)", lat: 40.71, lon: -74.01 },
  "LONGIL":  { name: "Long Island (K)",   lat: 40.75, lon: -73.10 },
};

export async function GET() {
  try {
    const url = "https://mis.nyiso.com/public/realtime/realtime_zone_lbmp.csv";
    const resp = await fetch(url, { next: { revalidate: 0 } });
    if (!resp.ok) {
      return NextResponse.json(
        { error: `NYISO fetch failed: HTTP ${resp.status}` },
        { status: 502 }
      );
    }

    const csv = await resp.text();
    const lines = csv.trim().split("\n");
    const header = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());

    const nameIdx = header.findIndex((h) => h === "name");
    const lbmpIdx = header.findIndex((h) => h.startsWith("lbmp"));
    const timeIdx = header.findIndex((h) => h.includes("time"));

    if (nameIdx === -1 || lbmpIdx === -1) {
      return NextResponse.json(
        { error: "Unexpected CSV format" },
        { status: 500 }
      );
    }

    let timestamp = "";
    const zones: {
      id: string;
      name: string;
      price: number;
      lat: number;
      lon: number;
    }[] = [];

    // Strip surrounding quotes from a CSV field
    const strip = (s: string) => s.trim().replace(/^"|"$/g, "");

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length <= lbmpIdx) continue;

      const zoneName = strip(cols[nameIdx]);
      const price = parseFloat(strip(cols[lbmpIdx]));
      if (isNaN(price)) continue;

      if (!timestamp && timeIdx !== -1) {
        timestamp = strip(cols[timeIdx]);
      }

      const coords = ZONE_COORDS[zoneName];
      if (!coords) continue;

      zones.push({
        id: zoneName,
        name: coords.name,
        price,
        lat: coords.lat,
        lon: coords.lon,
      });
    }

    return NextResponse.json({ timestamp, zones });
  } catch (err) {
    console.error("NYISO price fetch error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
