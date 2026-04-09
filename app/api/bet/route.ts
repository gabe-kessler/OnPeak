import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";

// POST /api/bet
// Instant fill at model_prob price — no matching engine.
// Body: { user_id, market_id, contract_type, quantity }
//
// To revert to order-book trading: delete this file and swap the UI back to /api/orders.

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

    const userRes = await client.query(
      "SELECT cash_balance FROM profile WHERE user_id = $1",
      [user_id]
    );
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const cashBalance = Number(userRes.rows[0].cash_balance);

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
    const price = contract_type === "yes" ? modelProb : 1 - modelProb;
    const cost  = price * quantity;

    if (cashBalance < cost) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: `Insufficient funds. This bet costs $${cost.toFixed(2)} but you have $${cashBalance.toFixed(2)}.` },
        { status: 400 }
      );
    }

    await client.query(
      "UPDATE profile SET cash_balance = cash_balance - $1 WHERE user_id = $2",
      [cost, user_id]
    );

    const col = contract_type === "yes" ? "yes_qty" : "no_qty";
    await client.query(
      `INSERT INTO positions (user_id, market_id, yes_qty, no_qty)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, market_id) DO UPDATE
       SET ${col} = positions.${col} + EXCLUDED.${col}`,
      [
        user_id, market_id,
        contract_type === "yes" ? quantity : 0,
        contract_type === "no"  ? quantity : 0,
      ]
    );

    await client.query("COMMIT");
    return NextResponse.json({ success: true, cost, price });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("POST /api/bet error:", err);
    return NextResponse.json({ error: "Server error. Please try again." }, { status: 500 });
  } finally {
    client.release();
  }
}
