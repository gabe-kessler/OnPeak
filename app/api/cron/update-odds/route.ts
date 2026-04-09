import { NextResponse } from "next/server";
import { updateNYCOdds } from "@/lib/update-nyc-odds";
import { updateBOSOdds } from "@/lib/update-bos-odds";
import { updateNP15Odds } from "@/lib/update-np15-odds";

// POST /api/cron/update-odds
// Called every 5 minutes via GitHub Actions.
// Updates model_prob and records market_prob_history for all open markets.

export async function POST(req: Request) { return handler(req); }
export async function GET(req: Request)  { return handler(req); }

async function handler(req: Request) {
  if (process.env.CRON_SECRET && req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [nycR, bosR, np15R] = await Promise.allSettled([
    updateNYCOdds(),
    updateBOSOdds(),
    updateNP15Odds(),
  ]);

  return NextResponse.json({
    nyc:  nycR.status  === "fulfilled" ? nycR.value  : { error: String(nycR.reason) },
    bos:  bosR.status  === "fulfilled" ? bosR.value  : { error: String(bosR.reason) },
    np15: np15R.status === "fulfilled" ? np15R.value : { error: String(np15R.reason) },
  });
}
