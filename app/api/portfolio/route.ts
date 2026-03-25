import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";

// GET /api/portfolio?user_id=...
// Returns the user's fresh cash balance, current positions, and open orders.

export async function GET(req: NextRequest) {
  const user_id = req.nextUrl.searchParams.get("user_id");

  if (!user_id) {
    return NextResponse.json({ error: "user_id is required." }, { status: 400 });
  }

  try {
    // Fresh cash balance (localStorage goes stale after trades)
    const profileResult = await pool.query(
      "SELECT cash_balance FROM profile WHERE user_id = $1",
      [user_id]
    );
    if (profileResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const cash_balance = Number(profileResult.rows[0].cash_balance);

    // Open positions (markets not yet settled)
    const positionsResult = await pool.query(
      `SELECT p.yes_qty, p.no_qty, m.market_id, m.name, m.threshold, m.direction, m.status
       FROM positions p
       JOIN markets m ON m.market_id = p.market_id
       WHERE p.user_id = $1
         AND (p.yes_qty > 0 OR p.no_qty > 0)
         AND m.status = 'open'
       ORDER BY m.resolution_date DESC`,
      [user_id]
    );

    // Settled positions (historical)
    const settledResult = await pool.query(
      `SELECT p.yes_qty, p.no_qty, m.market_id, m.name, m.threshold, m.direction,
              m.resolution_date, m.settlement_value
       FROM positions p
       JOIN markets m ON m.market_id = p.market_id
       WHERE p.user_id = $1
         AND (p.yes_qty > 0 OR p.no_qty > 0)
         AND m.status = 'settled'
       ORDER BY m.resolution_date DESC`,
      [user_id]
    );

    // Open orders (pending or resting) joined with market names
    const ordersResult = await pool.query(
      `SELECT o.order_id, o.side, o.contract_type, o.order_type,
              o.price, o.quantity, o.status, o.created_at,
              m.name AS market_name, m.market_id
       FROM orders o
       JOIN markets m ON m.market_id = o.market_id
       WHERE o.user_id = $1
         AND o.status IN ('pending', 'resting')
       ORDER BY o.created_at DESC`,
      [user_id]
    );

    // Convert stored YES price back to user-facing price for display
    const openOrders = ordersResult.rows.map((o) => ({
      ...o,
      display_price: o.price === null ? null :
        o.contract_type === "no" ? (1 - Number(o.price)).toFixed(2) : Number(o.price).toFixed(2),
    }));

    const settledPositions = settledResult.rows.map((r) => ({
      ...r,
      threshold:        Number(r.threshold),
      settlement_value: Number(r.settlement_value),
      yes_wins:         Number(r.settlement_value) > Number(r.threshold),
    }));

    return NextResponse.json({ cash_balance, positions: positionsResult.rows, open_orders: openOrders, settled_positions: settledPositions });
  } catch (err) {
    console.error("GET /api/portfolio error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
