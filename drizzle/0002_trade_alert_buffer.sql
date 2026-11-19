CREATE TABLE IF NOT EXISTS trade_alert_buffer (
  user_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  fill_id TEXT NOT NULL,
  coin TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  trade_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, wallet, fill_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trade_alert_due ON trade_alert_buffer (finalized, due_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trade_alert_batch ON trade_alert_buffer (user_id, wallet, batch_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS trade_alert_latest ON trade_alert_buffer (user_id, wallet, coin, finalized, trade_at DESC);
