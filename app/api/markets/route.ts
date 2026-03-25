import { NextResponse } from "next/server";
import pool from "@/lib/db";

// GET /api/markets
// Returns all open markets with their best current YES and NO ask prices
// and all resting orders for the order book display.

export async function GET() {
  try {
    const marketsResult = await pool.query(
      `SELECT market_id, name, description, node, resolution_date, threshold, direction, status, settlement_value
       FROM markets
       WHERE status IN ('open', 'settled')
       ORDER BY created_at DESC`
    );

    // For each market, fetch the best ask prices and resting order book
    const markets = await Promise.all(
      marketsResult.rows.map(async (market) => {
        // Best YES ask = lowest resting ask-side price (sell_yes or buy_no)
        const yesAskResult = await pool.query(
          `SELECT MIN(price) AS best_yes_ask
           FROM orders
           WHERE market_id = $1 AND status = 'resting'
             AND ((side = 'sell' AND contract_type = 'yes')
               OR (side = 'buy'  AND contract_type = 'no'))`,
          [market.market_id]
        );

        // Best NO ask = highest resting bid-side YES price → NO price = 1 - that
        const noBidResult = await pool.query(
          `SELECT MAX(price) AS best_bid
           FROM orders
           WHERE market_id = $1 AND status = 'resting'
             AND ((side = 'buy'  AND contract_type = 'yes')
               OR (side = 'sell' AND contract_type = 'no'))`,
          [market.market_id]
        );

        // All resting orders for the order book table
        const orderbookResult = await pool.query(
          `SELECT side, contract_type, price, quantity
           FROM orders
           WHERE market_id = $1 AND status = 'resting'
           ORDER BY price DESC, created_at ASC`,
          [market.market_id]
        );

        const bestYesAsk = yesAskResult.rows[0].best_yes_ask;
        const bestBid    = noBidResult.rows[0].best_bid;

        // Convert stored YES prices to user-facing display prices
        const orderbook = orderbookResult.rows.map((o) => ({
          side:          o.side,
          contract_type: o.contract_type,
          // User-facing price: NO orders show (1 - stored_yes_price)
          display_price: o.contract_type === "no"
            ? (1 - Number(o.price)).toFixed(2)
            : Number(o.price).toFixed(2),
          stored_price: Number(o.price),
          quantity:      o.quantity,
        }));

        return {
          ...market,
          resolution_date:  market.resolution_date instanceof Date
            ? market.resolution_date.toISOString().slice(0, 10)
            : String(market.resolution_date).slice(0, 10),
          threshold:        Number(market.threshold),
          settlement_value: market.settlement_value != null ? Number(market.settlement_value) : null,
          best_yes_ask:     bestYesAsk ? Number(bestYesAsk) : null,
          best_no_ask:      bestBid    ? Number((1 - Number(bestBid)).toFixed(2)) : null,
          orderbook,
        };
      })
    );

    return NextResponse.json(markets);
  } catch (err) {
    console.error("GET /api/markets error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
