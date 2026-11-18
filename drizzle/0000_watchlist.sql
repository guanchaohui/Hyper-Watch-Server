CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY NOT NULL,
  settings TEXT NOT NULL,
  revision INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS push_devices (
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  subscription TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS alert_status (
  user_id TEXT NOT NULL,
  target TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  breached TEXT NOT NULL,
  PRIMARY KEY (user_id, target)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS alerts (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transmissions (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id, endpoint)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_leases (
  name TEXT PRIMARY KEY NOT NULL,
  holder TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
