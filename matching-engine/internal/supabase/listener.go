package supabase

import (
	"database/sql"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/lib/pq"
	"onpeak/matching-engine/internal/orderbook"
)

// Listener holds the Postgres connection used for LISTEN/NOTIFY
// and a reference to all active orderbooks (one per market).
type Listener struct {
	mu         sync.Mutex                       // guards the orderbooks map
	connStr    string
	orderbooks map[string]*orderbook.OrderBook // keyed by market_id
	db         *sql.DB                         // shared pool for loading resting orders
}

// NewListener creates a Listener. Call ListenForOrders() to start it.
func NewListener(connStr string, db *sql.DB, books map[string]*orderbook.OrderBook) *Listener {
	return &Listener{
		connStr:    connStr,
		orderbooks: books,
		db:         db,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// LoadRestingOrders — called once at startup
// ─────────────────────────────────────────────────────────────────────────────

// LoadRestingOrders queries the DB for any orders still in 'resting' status
// and puts them back into the correct in-memory orderbook.
// This lets the engine recover cleanly after a restart — no open orders are lost.
func (l *Listener) LoadRestingOrders() {
	rows, err := l.db.Query(`
		SELECT order_id, market_id, user_id, order_type, side, contract_type, price, quantity, status, created_at
		FROM orders
		WHERE status = 'resting'
	`)
	if err != nil {
		log.Fatalf("ERROR: could not load resting orders: %v", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		o := &orderbook.Order{}
		var price sql.NullFloat64 // price can be NULL for market orders (shouldn't be resting, but be safe)

		err := rows.Scan(
			&o.OrderID, &o.MarketID, &o.UserID,
			&o.OrderType, &o.Side, &o.ContractType,
			&price, &o.Quantity, &o.Status, &o.CreatedAt,
		)
		if err != nil {
			log.Printf("ERROR: scanning resting order row: %v", err)
			continue
		}
		if price.Valid {
			o.Price = price.Float64
		}

		// Find the orderbook for this market and insert directly into the book.
		// We skip AddOrder() here because we don't want to re-run matching logic —
		// these orders already went through matching when they were first placed.
		book, ok := l.orderbooks[o.MarketID]
		if !ok {
			log.Printf("WARN: resting order %s belongs to unknown market %s — skipping", o.OrderID, o.MarketID)
			continue
		}
		book.AddRestingOrder(o)
		count++
	}

	log.Printf("STARTUP: loaded %d resting orders into memory", count)
}

// ─────────────────────────────────────────────────────────────────────────────
// ListenForOrders — runs forever, blocking the goroutine
// ─────────────────────────────────────────────────────────────────────────────

// ListenForOrders opens a dedicated Postgres connection, runs LISTEN new_order,
// and processes every incoming order notification in a loop.
// This function blocks — call it last in main().
func (l *Listener) ListenForOrders() {
	// pq.NewListener opens a dedicated connection for LISTEN/NOTIFY.
	// It reconnects automatically if the connection drops.
	listener := pq.NewListener(
		l.connStr,
		10*time.Second, // minimum reconnect wait
		time.Minute,    // maximum reconnect wait
		func(ev pq.ListenerEventType, err error) {
			if err != nil {
				log.Printf("LISTENER EVENT: %v", err)
			}
		},
	)
	defer listener.Close()

	// Subscribe to both channels.
	if err := listener.Listen("new_order"); err != nil {
		log.Fatalf("ERROR: could not LISTEN on new_order: %v", err)
	}
	if err := listener.Listen("cancel_order"); err != nil {
		log.Fatalf("ERROR: could not LISTEN on cancel_order: %v", err)
	}

	log.Println("LISTENER: ready — waiting for orders")

	for {
		// Block until a notification arrives (or the connection pings).
		notification := <-listener.Notify

		// A nil notification means the connection was re-established after a drop.
		if notification == nil {
			log.Println("LISTENER: reconnected to Postgres")
			continue
		}

		switch notification.Channel {
		case "new_order":
			l.handleNotification(notification.Extra)
		case "cancel_order":
			l.handleCancellation(notification.Extra)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// handleNotification — parses one notification and routes it to the engine
// ─────────────────────────────────────────────────────────────────────────────

// notifyPayload matches the JSON shape that pg_notify sends (row_to_json(NEW)).
// Column names in the DB are snake_case, so we map them here.
type notifyPayload struct {
	OrderID      string  `json:"order_id"`
	MarketID     string  `json:"market_id"`
	UserID       string  `json:"user_id"`
	OrderType    string  `json:"order_type"`
	Side         string  `json:"side"`
	ContractType string  `json:"contract_type"`
	Price        float64 `json:"price"`
	Quantity     int     `json:"quantity"`
	Status       string  `json:"status"`
	CreatedAt    string  `json:"created_at"`
}

// handleCancellation removes a cancelled order from whichever in-memory book holds it.
// The API has already updated the DB — the engine just needs to drop it from memory.
// The payload is the raw order_id UUID string (not JSON).
func (l *Listener) handleCancellation(orderID string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	for _, book := range l.orderbooks {
		if book.RemoveOrder(orderID) {
			log.Printf("CANCEL: removed order %s from memory", orderID)
			return
		}
	}
	// Not found is fine — it may have already been filled or never reached this engine instance.
	log.Printf("CANCEL: order %s not found in any book (already filled or unknown)", orderID)
}

func (l *Listener) handleNotification(payload string) {
	// Parse the JSON payload from the trigger.
	var p notifyPayload
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		log.Printf("ERROR: could not parse notification payload: %v\npayload: %s", err, payload)
		return
	}

	// Parse the timestamp.
	createdAt, err := time.Parse(time.RFC3339Nano, p.CreatedAt)
	if err != nil {
		// Fall back to now if the format is unexpected — non-fatal.
		createdAt = time.Now()
	}

	o := &orderbook.Order{
		OrderID:      p.OrderID,
		MarketID:     p.MarketID,
		UserID:       p.UserID,
		OrderType:    p.OrderType,
		Side:         p.Side,
		ContractType: p.ContractType,
		Price:        p.Price,
		Quantity:     p.Quantity,
		Status:       p.Status,
		CreatedAt:    createdAt,
	}

	// Find the orderbook for this market, creating one if it's new.
	// Lock the map for the lookup + possible write — two notifications for the
	// same new market must not both try to create it simultaneously.
	l.mu.Lock()
	book, ok := l.orderbooks[p.MarketID]
	if !ok {
		log.Printf("INFO: new market %s seen — creating orderbook", p.MarketID)
		book = orderbook.New(p.MarketID, l.db)
		l.orderbooks[p.MarketID] = book
	}
	l.mu.Unlock()

	log.Printf("ORDER: id=%s type=%s side=%s price=%.4f qty=%d",
		o.OrderID, o.OrderType, o.Side, o.Price, o.Quantity)

	// Hand off to the matching engine.
	book.AddOrder(o)
}
