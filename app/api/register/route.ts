import { NextRequest, NextResponse } from "next/server";
import pool from "@/lib/db";
import bcrypt from "bcryptjs";

export async function POST(req: NextRequest) {
  const { username, email, password } = await req.json();

  // --- Validation ---
  if (!username || !email || !password) {
    return NextResponse.json(
      { error: "All fields are required." },
      { status: 400 }
    );
  }

  try {
    // --- Check if email is already taken ---
    const existing = await pool.query(
      "SELECT user_id FROM profile WHERE email = $1",
      [email]
    );
    if (existing.rows.length > 0) {
      return NextResponse.json(
        { error: "An account with that email already exists." },
        { status: 409 }
      );
    }

    // --- Hash the password (never store plain text passwords) ---
    // bcrypt turns "mypassword" into a scrambled string like "$2b$10$..."
    const hashedPassword = await bcrypt.hash(password, 10);

    // --- Insert the new user into the profile table ---
    await pool.query(
      `INSERT INTO profile (user_id, username, email, password, cash_balance, timestamp_created)
       VALUES (gen_random_uuid(), $1, $2, $3, 10000, NOW())`,
      [username, email, hashedPassword]
    );

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    console.error("Register error:", err);
    return NextResponse.json({ error: "Server error. Please try again." }, { status: 500 });
  }
}
