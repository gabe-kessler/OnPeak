import { NextResponse } from "next/server";
import { updateNYCOdds } from "@/lib/update-nyc-odds";

// POST /api/cron/update-nyc-odds
// Manual trigger endpoint — the same logic runs automatically as a side effect of
// /api/prices/all every time it refreshes (every ~5 min), so no cron needed.

export async function POST(req: Request) { return handler(req); }
export async function GET(req: Request)  { return handler(req); }

async function handler(req: Request) {
  if (
    process.env.CRON_SECRET &&
    req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await updateNYCOdds();
  return NextResponse.json({ success: true, ...result });
}
