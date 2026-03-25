import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders — place a new order
//
// Request body:
//   user_id       string   — from localStorage (set at login)
//   market_id     string   — which market
//   side          string   — "buy" or "sell"
//   contract_type string   — "yes" or "no"
//   order_type    string   — "limit" or "market"
//   price         number   — required for limit orders; user-facing price
//                            (YES price if contract_type="yes", NO price if "no")
//   quantity      number   — whole number of contracts
//
// What this route does:
//   1. Validates all inputs
//   2. Confirms user and market exist
//   3. For SELL orders: checks the user owns enough contracts (positions table)
//   4. For LIMIT BUY orders: checks cash and reserves it upfront (deducted now,
//      returned at cancellation or transferred to seller at match)
//   5. For MARKET BUY orders: estimates cost from best resting order, validates
//      cash (engine deducts exact amount at match time)
//   6. Inserts into the orders table
//      → Postgres trigger fires pg_notify → Go engine picks it up instantly
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { user_id, market_id, side, contract_type, order_type, price, quantity } =
    await req.json();

  // ── Input validation ──────────────────────────────────────────────────────

  if (!user_id || !market_id || !side || !contract_type || !order_type || !quantity) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }
  if (!["buy", "sell"].includes(side)) {
    return NextResponse.json({ error: "side must be 'buy' or 'sell'." }, { status: 400 });
  }
  if (!["yes", "no"].includes(contract_type)) {
    return NextResponse.json({ error: "contract_type must be 'yes' or 'no'." }, { status: 400 });
  }
  if (!["limit", "market"].includes(order_type)) {
    return NextResponse.json({ error: "order_type must be 'limit' or 'market'." }, { status: 400 });
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a positive whole number." }, { status: 400 });
  }
  if (order_type === "limit") {
    if (price === undefined || price === null) {
      return NextResponse.json({ error: "Limit orders require a price." }, { status: 400 });
    }
    if (price <= 0 || price >= 1) {
      return NextResponse.json({ error: "Price must be between $0.01 and $0.99." }, { status: 400 });
    }
  }

  // Convert the user-facing price to the internal YES price.
  // All orders are stored using the YES price so the engine can use one sorted book.
  //   contract_type="yes" → stored price = price (as-is)
  //   contract_type="no"  → stored price = 1 - price  (e.g. user enters $0.45 NO → stored as $0.55)
  const yesPrice: number | null =
    order_type === "market" ? null :
    contract_type === "no"  ? 1 - price : price;

  try {
    // ── Verify user exists and get their cash balance ─────────────────────

    const userResult = await pool.query(
      "SELECT user_id, cash_balance FROM profile WHERE user_id = $1",
      [user_id]
    );
    if (userResult.rows.length === 0) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const cashBalance = Number(userResult.rows[0].cash_balance);

    // ── Verify market exists and is open ──────────────────────────────────

    const marketResult = await pool.query(
      "SELECT status FROM markets WHERE market_id = $1",
      [market_id]
    );
    if (marketResult.rows.length === 0) {
      return NextResponse.json({ error: "Market not found." }, { status: 404 });
    }
    if (marketResult.rows[0].status !== "open") {
      return NextResponse.json({ error: "This market is not open for trading." }, { status: 400 });
    }

    // ── SELL: validate ownership ──────────────────────────────────────────
    // Users can only sell contracts they already hold.

    if (side === "sell") {
      const posResult = await pool.query(
        "SELECT yes_qty, no_qty FROM positions WHERE user_id = $1 AND market_id = $2",
        [user_id, market_id]
      );
      const pos = posResult.rows[0] ?? { yes_qty: 0, no_qty: 0 };

      if (contract_type === "yes" && Number(pos.yes_qty) < quantity) {
        return NextResponse.json(
          { error: `You only hold ${pos.yes_qty} YES contracts.` },
          { status: 400 }
        );
      }
      if (contract_type === "no" && Number(pos.no_qty) < quantity) {
        return NextResponse.json(
          { error: `You only hold ${pos.no_qty} NO contracts.` },
          { status: 400 }
        );
      }

      // Sell orders require no cash — insert and let the engine handle the match.
      const result = await pool.query(
        `INSERT INTO orders (market_id, user_id, order_type, side, contract_type, price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING order_id`,
        [market_id, user_id, order_type, side, contract_type, yesPrice, quantity]
      );
      return NextResponse.json(
        { success: true, order_id: result.rows[0].order_id },
        { status: 201 }
      );
    }

    // ── LIMIT BUY: validate cash and reserve it ───────────────────────────
    // Cash is deducted now. If the order is later cancelled, it is refunded.
    // At match, the engine credits the seller — the buyer's reservation is the source.

    if (order_type === "limit") {
      const cost = contract_type === "yes"
        ? price * quantity
        : (1 - price) * quantity;

      if (cashBalance < cost) {
        return NextResponse.json(
          {
            error: `Insufficient funds. This order costs $${cost.toFixed(2)} but you have $${cashBalance.toFixed(2)}.`,
          },
          { status: 400 }
        );
      }

      // Deduct cash and insert order inside one transaction so they are atomic.
      // If the INSERT fails for any reason, the cash deduction rolls back too.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          "UPDATE profile SET cash_balance = cash_balance - $1 WHERE user_id = $2",
          [cost, user_id]
        );

        const result = await client.query(
          `INSERT INTO orders (market_id, user_id, order_type, side, contract_type, price, quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING order_id`,
          [market_id, user_id, order_type, side, contract_type, yesPrice, quantity]
        );

        await client.query("COMMIT");
        return NextResponse.json(
          { success: true, order_id: result.rows[0].order_id },
          { status: 201 }
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    // ── MARKET BUY: validate estimated cash, then insert ──────────────────
    // Price is unknown at placement — the engine fills at whatever the best
    // resting price is. We estimate the cost and reject if the user clearly
    // can't afford it. The engine deducts the exact amount at match time.

    // Find the best resting price on the opposite side of the book.
    // Market buy YES (bid) → look at asks: sell_yes or buy_no resting orders.
    // Market buy NO (ask) → look at bids: buy_yes or sell_no resting orders.
    const incomingIsBid = contract_type === "yes"; // buy_yes is a bid; buy_no is an ask

    const bestPriceResult = await pool.query(
      `SELECT price FROM orders
       WHERE market_id = $1
         AND status = 'resting'
         AND (
           ($2 = true  AND ((side = 'sell' AND contract_type = 'yes') OR (side = 'buy'  AND contract_type = 'no')))
        OR ($2 = false AND ((side = 'buy'  AND contract_type = 'yes') OR (side = 'sell' AND contract_type = 'no')))
         )
       ORDER BY price ${incomingIsBid ? "ASC" : "DESC"}
       LIMIT 1`,
      [market_id, incomingIsBid]
    );

    if (bestPriceResult.rows.length === 0) {
      return NextResponse.json(
        { error: "No resting orders available to fill a market order right now." },
        { status: 400 }
      );
    }

    const bestYesPrice = Number(bestPriceResult.rows[0].price);
    const estimatedCost = contract_type === "yes"
      ? bestYesPrice * quantity
      : (1 - bestYesPrice) * quantity;

    if (cashBalance < estimatedCost) {
      return NextResponse.json(
        {
          error: `Insufficient funds. Estimated cost is $${estimatedCost.toFixed(2)} but you have $${cashBalance.toFixed(2)}.`,
        },
        { status: 400 }
      );
    }

    // Insert with price = NULL — engine determines actual fill price at match.
    const result = await pool.query(
      `INSERT INTO orders (market_id, user_id, order_type, side, contract_type, price, quantity)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)
       RETURNING order_id`,
      [market_id, user_id, order_type, side, contract_type, quantity]
    );

    return NextResponse.json(
      { success: true, order_id: result.rows[0].order_id },
      { status: 201 }
    );

  } catch (err) {
    console.error("POST /api/orders error:", err);
    return NextResponse.json({ error: "Server error. Please try again." }, { status: 500 });
  }
}
