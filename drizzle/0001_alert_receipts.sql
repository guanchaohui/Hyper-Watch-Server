CREATE TABLE IF NOT EXISTS alert_reads (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (user_id, event_id) REFERENCES alerts (user_id, event_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS alerts_by_user_time ON alerts (user_id, created_at DESC, event_id DESC);
