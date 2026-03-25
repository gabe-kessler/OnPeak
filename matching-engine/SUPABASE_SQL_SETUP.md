# Supabase SQL Setup for the Matching Engine

Run all of this in the Supabase SQL Editor in order.
You already have the `profile` table — everything below is new.

---

## 1. markets table
Defines each tradeable contract. The engine loads this on startup.

```sql
CREATE TABLE markets (
  market_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,
  node            TEXT NOT NULL,         -- e.g. 'NYC', 'CAPITL'
  resolution_date DATE NOT NULL,         -- the day the market settles
  threshold       NUMERIC NOT NULL,      -- e.g. 50.00 (the price it must beat)
  direction       TEXT NOT NULL,         -- 'higher' or 'lower'
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open', 'closed', 'settled'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 2. orders table
Every order ever placed — limit and market. The engine reads and writes this constantly.

```sql
CREATE TABLE orders (
  order_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id       UUID NOT NULL REFERENCES markets(market_id),
  user_id         UUID NOT NULL REFERENCES profile(user_id),
  order_type      TEXT NOT NULL,         -- 'limit' or 'market'
  side            TEXT NOT NULL,         -- 'buy' or 'sell'
  price           NUMERIC,               -- NULL for market orders, required for limit
  quantity        INTEGER NOT NULL,
  filled_qty      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
                                         -- 'pending' → 'resting' | 'partial' |
                                         --              'filled' | 'cancelled'
  cancel_reason   TEXT,                  -- only set when status = 'cancelled'
                                         -- e.g. 'no_liquidity', 'user_requested'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 3. trades table
Every matched trade. Written by the Go engine after a successful match.

```sql
CREATE TABLE trades (
  trade_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id       UUID NOT NULL REFERENCES markets(market_id),
  buy_order_id    UUID NOT NULL REFERENCES orders(order_id),
  sell_order_id   UUID NOT NULL REFERENCES orders(order_id),
  buyer_user_id   UUID NOT NULL REFERENCES profile(user_id),
  seller_user_id  UUID NOT NULL REFERENCES profile(user_id),
  price           NUMERIC NOT NULL,      -- always the resting order's price
  quantity        INTEGER NOT NULL,
  matched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 4. NOTIFY trigger on orders
This is how Supabase tells the Go engine the instant a new order is inserted.
The engine runs LISTEN 'new_order' and receives the order as a JSON payload.

```sql
CREATE OR REPLACE FUNCTION notify_new_order()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('new_order', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_order_insert
AFTER INSERT ON orders
FOR EACH ROW EXECUTE FUNCTION notify_new_order();
```

---

## 5. Indexes for performance
The engine queries these columns constantly — indexes make them fast.

```sql
-- Engine scans for pending orders on startup recovery
CREATE INDEX idx_orders_status     ON orders(status);

-- Engine loads all orders for a given market
CREATE INDEX idx_orders_market     ON orders(market_id);

-- Frontend queries a user's own orders
CREATE INDEX idx_orders_user       ON orders(user_id);

-- Frontend and settlement queries trades by market
CREATE INDEX idx_trades_market     ON trades(market_id);
```

---

## 6. contract_type column on orders
Tracks whether an order is for a YES or NO contract.
Run this ALTER — it is safe on existing rows (they default to 'yes').

```sql
ALTER TABLE orders
  ADD COLUMN contract_type TEXT NOT NULL DEFAULT 'yes';
  -- 'yes' → buying/selling YES contracts
  -- 'no'  → buying/selling NO contracts
```

---

## 7. positions table
Tracks each user's current holdings per market.
Updated by the engine after every match. Read at settlement to determine payouts.

```sql
CREATE TABLE positions (
  user_id    UUID NOT NULL REFERENCES profile(user_id),
  market_id  UUID NOT NULL REFERENCES markets(market_id),
  yes_qty    INTEGER NOT NULL DEFAULT 0,  -- YES contracts held (must be >= 0)
  no_qty     INTEGER NOT NULL DEFAULT 0,  -- NO contracts held (must be >= 0)
  PRIMARY KEY (user_id, market_id),
  CONSTRAINT no_negative_positions CHECK (yes_qty >= 0 AND no_qty >= 0)
);

-- Frontend queries a user's positions across all markets
CREATE INDEX idx_positions_user ON positions(user_id);
```

---

## 8. settlement_value column on markets
Stores the final RT average LBMP for a settled market.
Run this ALTER — it is safe on existing rows (defaults to NULL until settled).

```sql
ALTER TABLE markets
  ADD COLUMN settlement_value NUMERIC;
  -- NULL while market is open; set to RT average at settlement
```

---

## 9. What you do NOT need to create manually
These are handled automatically by Supabase or the engine:

- `profile.cash_balance` already exists — the engine just UPDATEs it
- Supabase Realtime works on any table automatically — no extra setup needed
- `gen_random_uuid()` is available in Supabase Postgres by default
