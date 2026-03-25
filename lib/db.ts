import { Pool } from "pg";

// One shared connection pool to the Supabase database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // required for Supabase
});

export default pool;
