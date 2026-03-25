package main

import (
	"database/sql"
	"log"
	"os"

	_ "github.com/lib/pq"
	"onpeak/matching-engine/internal/orderbook"
	"onpeak/matching-engine/internal/supabase"
)

func main() {
	// ─────────────────────────────────────────────────────────────────────────
	// STEP 1: Read the database connection string from the environment.
	// Set SUPABASE_DB_URL before running — same value as DATABASE_URL in .env.local.
	// ─────────────────────────────────────────────────────────────────────────
	connStr := os.Getenv("SUPABASE_DB_URL")
	if connStr == "" {
		log.Fatal("SUPABASE_DB_URL environment variable is not set")
	}

	// ─────────────────────────────────────────────────────────────────────────
	// STEP 2: Open a connection pool to Supabase (direct Postgres, not HTTP).
	// This pool is shared by all orderbooks for their DB writes.
	// ─────────────────────────────────────────────────────────────────────────
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		log.Fatalf("ERROR: could not open database: %v", err)
	}
	defer db.Close()

	// Verify the connection is actually alive before doing anything else.
	if err := db.Ping(); err != nil {
		log.Fatalf("ERROR: could not reach database: %v", err)
	}
	log.Println("STARTUP: connected to Supabase")

	// ─────────────────────────────────────────────────────────────────────────
	// STEP 3: Load all active markets from the DB and create one OrderBook each.
	// ─────────────────────────────────────────────────────────────────────────
	books := loadMarkets(db)
	log.Printf("STARTUP: initialized %d orderbook(s)", len(books))

	// ─────────────────────────────────────────────────────────────────────────
	// STEP 4: Create the listener and reload any resting orders from the DB.
	// This handles the case where the engine was restarted mid-session.
	// ─────────────────────────────────────────────────────────────────────────
	listener := supabase.NewListener(connStr, db, books)
	listener.LoadRestingOrders()

	// ─────────────────────────────────────────────────────────────────────────
	// STEP 5: Start listening for new orders.
	// This blocks forever — the engine runs until the process is killed.
	// ─────────────────────────────────────────────────────────────────────────
	log.Println("STARTUP: engine is live")
	listener.ListenForOrders()
}

// loadMarkets queries the `markets` table for all open markets
// and returns a map of market_id → OrderBook.
func loadMarkets(db *sql.DB) map[string]*orderbook.OrderBook {
	rows, err := db.Query(`
		SELECT market_id, name
		FROM markets
		WHERE status = 'open'
	`)
	if err != nil {
		log.Fatalf("ERROR: could not query markets: %v", err)
	}
	defer rows.Close()

	books := make(map[string]*orderbook.OrderBook)
	for rows.Next() {
		var marketID, name string
		if err := rows.Scan(&marketID, &name); err != nil {
			log.Printf("ERROR: scanning market row: %v", err)
			continue
		}
		books[marketID] = orderbook.New(marketID, db)
		log.Printf("STARTUP: loaded market %q (%s)", name, marketID)
	}

	return books
}
