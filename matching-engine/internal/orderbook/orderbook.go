package orderbook

import (
	"database/sql"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	_ "github.com/lib/pq"
)

// ─────────────────────────────────────────────────────────────────────────────
// DATA TYPES
// ─────────────────────────────────────────────────────────────────────────────

// Order mirrors a row in the `orders` table.
// Price is always stored as the YES price (the API converts NO prices before inserting).
type Order struct {
	OrderID      string
	MarketID     string
	UserID       string
	OrderType    string  // "limit" or "market"
	Side         string  // "buy" or "sell"
	ContractType string  // "yes" or "no"
	Price        float64 // always the YES price (e.g. 0.55). For NO orders: stored as 1 - user_input.
	Quantity     int
	Status       string
	CreatedAt    time.Time
}

// OrderBook holds all resting limit orders for one market.
// There is one OrderBook per active market in the engine.
//
// All four order types live in either Bids or Asks based on which side of the
// YES contract they represent:
//
//	Bids (want YES outcome): buy_yes, sell_no (exiting NO = rooting for YES)
//	Asks (provide YES):      sell_yes, buy_no  (taking NO side or exiting YES)
//
// Price is always the YES price, so a single sorted list works for all types.
type OrderBook struct {
	mu       sync.Mutex // guards Bids and Asks against concurrent access
	MarketID string
	Bids     []*Order // sorted by YES price DESC, CreatedAt ASC on ties
	Asks     []*Order // sorted by YES price ASC,  CreatedAt ASC on ties
	DB       *sql.DB
}

// New creates an empty OrderBook for a given market.
func New(marketID string, db *sql.DB) *OrderBook {
	return &OrderBook{
		MarketID: marketID,
		DB:       db,
	}
}

// isBid returns true if this order belongs on the Bid side of the book.
// Bids represent the "YES side": either opening a YES position or closing a NO position.
func isBid(o *Order) bool {
	return (o.Side == "buy" && o.ContractType == "yes") ||
		(o.Side == "sell" && o.ContractType == "no")
}

// AddRestingOrder inserts an already-resting order directly into the book
// without running any matching logic. Used on startup to reload state from the DB.
func (ob *OrderBook) AddRestingOrder(o *Order) {
	if isBid(o) {
		ob.Bids = append(ob.Bids, o)
		ob.sortBids()
	} else {
		ob.Asks = append(ob.Asks, o)
		ob.sortAsks()
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// SORTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) sortBids() {
	sort.Slice(ob.Bids, func(i, j int) bool {
		if ob.Bids[i].Price != ob.Bids[j].Price {
			return ob.Bids[i].Price > ob.Bids[j].Price
		}
		return ob.Bids[i].CreatedAt.Before(ob.Bids[j].CreatedAt)
	})
}

func (ob *OrderBook) sortAsks() {
	sort.Slice(ob.Asks, func(i, j int) bool {
		if ob.Asks[i].Price != ob.Asks[j].Price {
			return ob.Asks[i].Price < ob.Asks[j].Price
		}
		return ob.Asks[i].CreatedAt.Before(ob.Asks[j].CreatedAt)
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) AddOrder(o *Order) {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	if o.OrderType == "market" {
		ob.tryFillMarketOrder(o)
	} else {
		ob.addLimitOrder(o)
	}
}

// RemoveOrder removes an order from the in-memory book by ID.
// Used when the API has already cancelled the order in the DB — the engine
// just needs to drop it from its local state. Returns true if found.
func (ob *OrderBook) RemoveOrder(orderID string) bool {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	order := ob.findInBook(orderID)
	if order == nil {
		return false
	}
	ob.removeFromBook(order)
	return true
}

func (ob *OrderBook) CancelOrder(orderID string, requestingUserID string) error {
	ob.mu.Lock()
	defer ob.mu.Unlock()

	order := ob.findInBook(orderID)
	if order == nil {
		return fmt.Errorf("order %s not found in book", orderID)
	}
	if order.UserID != requestingUserID {
		return fmt.Errorf("user %s does not own order %s", requestingUserID, orderID)
	}

	ob.removeFromBook(order)

	_, err := ob.DB.Exec(
		`UPDATE orders SET status = 'cancelled', cancel_reason = 'user_requested' WHERE order_id = $1`,
		orderID,
	)
	if err != nil {
		return fmt.Errorf("could not cancel order %s in DB: %w", orderID, err)
	}

	// Refund reserved cash for buy orders — cash was deducted at placement.
	// Sell orders had no cash reserved, so nothing to refund.
	if order.Side == "buy" {
		var refund float64
		if order.ContractType == "yes" {
			refund = order.Price * float64(order.Quantity) // YES price × qty
		} else {
			refund = (1 - order.Price) * float64(order.Quantity) // NO price × qty
		}
		_, err = ob.DB.Exec(
			`UPDATE profile SET cash_balance = cash_balance + $1 WHERE user_id = $2`,
			refund, order.UserID,
		)
		if err != nil {
			return fmt.Errorf("could not refund cash for order %s: %w", orderID, err)
		}
	}

	log.Printf("CANCEL: order=%s user=%s", orderID, requestingUserID)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// LIMIT ORDER LOGIC
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) addLimitOrder(o *Order) {
	candidates := ob.findCandidates(o)
	if candidates != nil {
		ob.matchMultiple(o, candidates)
		return
	}

	// No match — rest in the correct side of the book.
	if isBid(o) {
		ob.Bids = append(ob.Bids, o)
		ob.sortBids()
	} else {
		ob.Asks = append(ob.Asks, o)
		ob.sortAsks()
	}

	_, err := ob.DB.Exec(
		`UPDATE orders SET status = 'resting' WHERE order_id = $1`,
		o.OrderID,
	)
	if err != nil {
		log.Printf("ERROR: could not set order %s to resting: %v", o.OrderID, err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// MARKET ORDER LOGIC
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) tryFillMarketOrder(o *Order) {
	candidates := ob.findCandidates(o)
	if candidates != nil {
		ob.matchMultiple(o, candidates)
		return
	}

	reason := "no_liquidity"
	// If there are orders on the other side but not enough quantity, be specific.
	if (isBid(o) && len(ob.Asks) > 0) || (!isBid(o) && len(ob.Bids) > 0) {
		reason = "insufficient_liquidity"
	}
	ob.cancelOrder(o.OrderID, reason)
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION: findCandidates
//
// Looks at the best price level on the opposite side of the book.
// Greedily accumulates resting orders (oldest first) until their combined
// quantity exactly equals the incoming order's quantity.
//
// Only orders at the single best price are considered — all legs of a fill
// execute at the same price.
//
// Sell+sell matches are prevented: a sell order closing one type of position
// cannot match with a sell order closing the other type, because that would
// require releasing escrow with no new buyer funding the payout.
//
// Returns the chosen orders if an exact fill is found, nil otherwise.
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) findCandidates(incoming *Order) []*Order {
	isMarket := incoming.OrderType == "market"
	incomingIsBid := isBid(incoming)

	var pool []*Order

	if incomingIsBid {
		// Incoming is on the bid side — look at asks.
		if len(ob.Asks) == 0 {
			return nil
		}
		bestPrice := ob.Asks[0].Price
		if !isMarket && bestPrice > incoming.Price {
			return nil // price doesn't cross
		}
		for _, o := range ob.Asks {
			if o.Price != bestPrice {
				break // asks are sorted ascending; stop at first price change
			}
			// Two sell orders cannot match — skip sell_yes if incoming is sell_no and vice versa.
			if incoming.Side == "sell" && o.Side == "sell" {
				continue
			}
			pool = append(pool, o)
		}
	} else {
		// Incoming is on the ask side — look at bids.
		if len(ob.Bids) == 0 {
			return nil
		}
		bestPrice := ob.Bids[0].Price
		if !isMarket && bestPrice < incoming.Price {
			return nil // price doesn't cross
		}
		for _, o := range ob.Bids {
			if o.Price != bestPrice {
				break // bids are sorted descending; stop at first price change
			}
			if incoming.Side == "sell" && o.Side == "sell" {
				continue
			}
			pool = append(pool, o)
		}
	}

	// Greedy accumulation: walk in time order, stop if we hit exact qty or overshoot.
	accumulated := 0
	var chosen []*Order
	for _, o := range pool {
		accumulated += o.Quantity
		chosen = append(chosen, o)
		if accumulated == incoming.Quantity {
			return chosen
		}
		if accumulated > incoming.Quantity {
			return nil // overshot — no exact fill at this price
		}
	}
	return nil // not enough quantity
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION: matchMultiple
//
// Executes a confirmed fill. All DB writes are inside a single transaction.
//
// Cash rules:
//   - buy_yes / buy_no: cash was reserved at order placement — no change at match.
//   - sell_yes:         receives YES_price × qty at match.
//   - sell_no:          receives (1 − YES_price) × qty at match.
//
// Position rules (positions table upserted per user per market):
//   - buy_yes:  yes_qty += qty
//   - buy_no:   no_qty  += qty
//   - sell_yes: yes_qty -= qty  (API validated ownership before placement)
//   - sell_no:  no_qty  -= qty
//
// One trade row is inserted per resting order involved.
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) matchMultiple(aggressor *Order, resting []*Order) {
	tradePrice := resting[0].Price // all resting orders are at the same YES price

	tx, err := ob.DB.Begin()
	if err != nil {
		log.Printf("ERROR: could not begin match transaction: %v", err)
		return
	}

	// Determine the bid-side and ask-side order for trade record labelling.
	// In the trades table, buy_order_id = the bid-side order, sell_order_id = the ask-side order.
	aggressorIsBid := isBid(aggressor)

	for _, r := range resting {
		var buyOrderID, sellOrderID, buyerUserID, sellerUserID string
		if aggressorIsBid {
			buyOrderID, buyerUserID = aggressor.OrderID, aggressor.UserID
			sellOrderID, sellerUserID = r.OrderID, r.UserID
		} else {
			sellOrderID, sellerUserID = aggressor.OrderID, aggressor.UserID
			buyOrderID, buyerUserID = r.OrderID, r.UserID
		}

		// Insert one trade row for this leg.
		_, err = tx.Exec(`
			INSERT INTO trades
				(market_id, buy_order_id, sell_order_id, buyer_user_id, seller_user_id, price, quantity)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, ob.MarketID, buyOrderID, sellOrderID, buyerUserID, sellerUserID, tradePrice, r.Quantity)
		if err != nil {
			log.Printf("ERROR: inserting trade leg: %v", err)
			tx.Rollback()
			return
		}

		// Mark this resting order as filled.
		_, err = tx.Exec(
			`UPDATE orders SET status = 'filled', filled_qty = quantity WHERE order_id = $1`,
			r.OrderID,
		)
		if err != nil {
			log.Printf("ERROR: filling resting order %s: %v", r.OrderID, err)
			tx.Rollback()
			return
		}

		// Apply cash and position changes for this resting order.
		if err = ob.applyCashAndPosition(tx, r, tradePrice, r.Quantity); err != nil {
			log.Printf("ERROR: applying cash/position for resting order %s: %v", r.OrderID, err)
			tx.Rollback()
			return
		}
	}

	// Mark the aggressor as filled.
	_, err = tx.Exec(
		`UPDATE orders SET status = 'filled', filled_qty = quantity WHERE order_id = $1`,
		aggressor.OrderID,
	)
	if err != nil {
		log.Printf("ERROR: filling aggressor order %s: %v", aggressor.OrderID, err)
		tx.Rollback()
		return
	}

	// Apply cash and position changes for the aggressor (one person, full quantity).
	if err = ob.applyCashAndPosition(tx, aggressor, tradePrice, aggressor.Quantity); err != nil {
		log.Printf("ERROR: applying cash/position for aggressor %s: %v", aggressor.OrderID, err)
		tx.Rollback()
		return
	}

	if err = tx.Commit(); err != nil {
		log.Printf("ERROR: match transaction commit failed: %v", err)
		tx.Rollback()
		return
	}

	log.Printf("TRADE: market=%s price=%.4f qty=%d legs=%d",
		ob.MarketID, tradePrice, aggressor.Quantity, len(resting))

	for _, r := range resting {
		ob.removeFromBook(r)
	}
}

// applyCashAndPosition applies one participant's cash credit and position update
// inside an open transaction. Called once per participant per match.
//
// Cash changes:
//   - buy_yes / buy_no: cash was already deducted at order placement → no change here.
//   - sell_yes:         credited YES_price × qty (the buyer's reserved cash flows to them).
//   - sell_no:          credited (1 − YES_price) × qty.
//
// Position changes (upsert — creates row if first trade for this user+market):
//   - buy_yes:  yes_qty += qty
//   - buy_no:   no_qty  += qty
//   - sell_yes: yes_qty -= qty
//   - sell_no:  no_qty  -= qty
func (ob *OrderBook) applyCashAndPosition(tx *sql.Tx, o *Order, yesPrice float64, qty int) error {
	action := o.Side + "_" + o.ContractType // e.g. "buy_yes", "sell_no"

	// Cash changes:
	//   Limit buy — cash was reserved (deducted) at order placement. No change here.
	//   Market buy — price was unknown at placement so nothing was reserved. Deduct now.
	//   Sell — receives cash at match (from the buyer's reservation or market deduction).
	var cashDelta float64
	switch action {
	case "buy_yes":
		if o.OrderType == "market" {
			cashDelta = -(yesPrice * float64(qty)) // deduct at match for market orders
		}
	case "buy_no":
		if o.OrderType == "market" {
			cashDelta = -((1 - yesPrice) * float64(qty))
		}
	case "sell_yes":
		cashDelta = yesPrice * float64(qty)
	case "sell_no":
		cashDelta = (1 - yesPrice) * float64(qty)
	}
	if cashDelta != 0 {
		_, err := tx.Exec(
			`UPDATE profile SET cash_balance = cash_balance + $1 WHERE user_id = $2`,
			cashDelta, o.UserID,
		)
		if err != nil {
			return fmt.Errorf("cash update failed: %w", err)
		}
	}

	// Position delta.
	var yesDelta, noDelta int
	switch action {
	case "buy_yes":
		yesDelta = qty
	case "buy_no":
		noDelta = qty
	case "sell_yes":
		yesDelta = -qty
	case "sell_no":
		noDelta = -qty
	}

	// Upsert position row: creates it on first match, increments/decrements on subsequent ones.
	_, err := tx.Exec(`
		INSERT INTO positions (user_id, market_id, yes_qty, no_qty)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, market_id) DO UPDATE SET
			yes_qty = positions.yes_qty + EXCLUDED.yes_qty,
			no_qty  = positions.no_qty  + EXCLUDED.no_qty
	`, o.UserID, o.MarketID, yesDelta, noDelta)
	if err != nil {
		return fmt.Errorf("position upsert failed: %w", err)
	}

	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

func (ob *OrderBook) cancelOrder(orderID string, reason string) {
	_, err := ob.DB.Exec(
		`UPDATE orders SET status = 'cancelled', cancel_reason = $1 WHERE order_id = $2`,
		reason, orderID,
	)
	if err != nil {
		log.Printf("ERROR: could not cancel order %s: %v", orderID, err)
	}
	log.Printf("CANCEL: order=%s reason=%s", orderID, reason)
}

func (ob *OrderBook) removeFromBook(o *Order) {
	if isBid(o) {
		ob.Bids = removeOrder(ob.Bids, o.OrderID)
	} else {
		ob.Asks = removeOrder(ob.Asks, o.OrderID)
	}
}

func removeOrder(orders []*Order, orderID string) []*Order {
	result := make([]*Order, 0, len(orders))
	for _, o := range orders {
		if o.OrderID != orderID {
			result = append(result, o)
		}
	}
	return result
}

func (ob *OrderBook) findInBook(orderID string) *Order {
	for _, o := range ob.Bids {
		if o.OrderID == orderID {
			return o
		}
	}
	for _, o := range ob.Asks {
		if o.OrderID == orderID {
			return o
		}
	}
	return nil
}
