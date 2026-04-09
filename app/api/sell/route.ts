import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";

// POST /api/sell
// Sell contracts at current model_prob price — instant fill, no matching engine.
// Body: { user_id, market_id, contract_type, quantity }

export async function POST(req: NextRequest) {
  const { user_id, market_id, contract_type, quantity } = await req.json();

  if (!user_id || !market_id || !contract_type || !quantity) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }
  if (!["yes", "no"].includes(contract_type)) {
    return NextResponse.json({ error: "contract_type must be 'yes' or 'no'." }, { status: 400 });
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a positive whole number." }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const mktRes = await client.query(
      "SELECT status, model_prob FROM markets WHERE market_id = $1",
      [market_id]
    );
    if (mktRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Market not found." }, { status: 404 });
    }
    if (mktRes.rows[0].status !== "open") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "This market is not open for trading." }, { status: 400 });
    }

    const modelProb = Number(mktRes.rows[0].model_prob ?? 0.5);
    const price  = contract_type === "yes" ? modelProb : 1 - modelProb;
    const payout = price * quantity;

    // Validate position
    const posRes = await client.query(
      "SELECT yes_qty, no_qty FROM positions WHERE user_id = $1 AND market_id = $2",
      [user_id, market_id]
    );
    const pos = posRes.rows[0] ?? { yes_qty: 0, no_qty: 0 };
    const held = contract_type === "yes" ? Number(pos.yes_qty) : Number(pos.no_qty);
    if (held < quantity) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: `You only hold ${held} ${contract_type.toUpperCase()} contracts.` },
        { status: 400 }
      );
    }

    // Decrement position
    const col = contract_type === "yes" ? "yes_qty" : "no_qty";
    await client.query(
      `UPDATE positions SET ${col} = ${col} - $1 WHERE user_id = $2 AND market_id = $3`,
      [quantity, user_id, market_id]
    );

    // Credit cash
    await client.query(
      "UPDATE profile SET cash_balance = cash_balance + $1 WHERE user_id = $2",
      [payout, user_id]
    );

    await client.query("COMMIT");
    return NextResponse.json({ success: true, payout, price });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/sell error:", err);
    return NextResponse.json({ error: "Server error. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
