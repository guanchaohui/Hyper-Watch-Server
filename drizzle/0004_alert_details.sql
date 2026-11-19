CREATE TABLE IF NOT EXISTS alert_details (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  details TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id),
  FOREIGN KEY (user_id, event_id) REFERENCES alerts (user_id, event_id) ON DELETE CASCADE
);
