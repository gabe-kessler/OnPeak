import pool from "./db";

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_snapshots (
      node_id     VARCHAR(60)   NOT NULL,
      name        VARCHAR(100)  NOT NULL,
      price       NUMERIC(10,4) NOT NULL,
      recorded_at TIMESTAMPTZ   NOT NULL,
      PRIMARY KEY (node_id, recorded_at)
    )
  `);
  tableReady = true;
}

export async function saveSnapshots(
  zones: { id: string; name: string; price: number; timestamp: string }[]
) {
  try {
    await ensureTable();
    for (const z of zones) {
      if (!z.timestamp) continue;
      await pool.query(
        `INSERT INTO price_snapshots (node_id, name, price, recorded_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (node_id, recorded_at) DO NOTHING`,
        [z.id, z.name, z.price, z.timestamp]
      );
    }
  } catch (err) {
    console.error("saveSnapshots error:", err);
  }
}

export async function getSnapshotsForDay(
  etDate: string // "YYYY-MM-DD" in ET
): Promise<{ node_id: string; name: string; price: number; recorded_at: string }[]> {
  await ensureTable();
  const result = await pool.query(
    `SELECT node_id, name, CAST(price AS float) AS price, recorded_at
     FROM price_snapshots
     WHERE DATE(recorded_at AT TIME ZONE 'America/New_York') = $1
     ORDER BY recorded_at ASC`,
    [etDate]
  );
  return result.rows;
}
