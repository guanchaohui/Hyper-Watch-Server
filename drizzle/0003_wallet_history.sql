CREATE TABLE IF NOT EXISTS market_records (
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (wallet, kind, event_id)
);
CREATE INDEX IF NOT EXISTS market_records_time ON market_records (wallet, kind, event_at DESC, event_id DESC);
CREATE TABLE IF NOT EXISTS market_coverage (
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  since INTEGER,
  through INTEGER,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  span INTEGER NOT NULL,
  PRIMARY KEY (wallet, kind)
);
CREATE TABLE IF NOT EXISTS wallet_equity_history (
  wallet TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  equity TEXT,
  pnl TEXT,
  PRIMARY KEY (wallet, sampled_at)
);
CREATE TABLE IF NOT EXISTS wallet_open_orders (
  wallet TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
