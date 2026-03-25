import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";

// DELETE /api/orders/[id]?user_id=xxx
// Cancels a resting order owned by the user.
// Refunds reserved cash for limit buy orders.

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: orderId } = await params;
  const userId  = req.nextUrl.searchParams.get("user_id");

  if (!orderId || !userId) {
    return NextResponse.json({ error: "Missing order_id or user_id." }, { status: 400 });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch the order — lock the row
    const result = await client.query(
      `SELECT order_id, user_id, side, order_type, price, quantity, status
       FROM orders WHERE order_id = $1 FOR UPDATE`,
      [orderId]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Order not found." }, { status: 404 });
    }

    const order = result.rows[0];

    if (order.user_id !== userId) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Not your order." }, { status: 403 });
    }

    if (order.status !== "resting" && order.status !== "pending") {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: `Cannot cancel an order with status '${order.status}'.` },
        { status: 409 }
      );
    }

    // Cancel the order
    await client.query(
      `UPDATE orders SET status = 'cancelled' WHERE order_id = $1`,
      [orderId]
    );

    // Refund reserved cash for limit buy orders
    if (order.side === "buy" && order.order_type === "limit") {
      const refund = parseFloat(order.price) * parseInt(order.quantity);
      await client.query(
        `UPDATE profile SET cash_balance = cash_balance + $1 WHERE user_id = $2`,
        [refund, userId]
      );
    }

    // Notify the Go engine to remove this order from its in-memory book
    await client.query(`SELECT pg_notify('cancel_order', $1)`, [orderId]);

    await client.query("COMMIT");
    return NextResponse.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("cancel order error:", err);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  } finally {
    client.release();
  }
}
