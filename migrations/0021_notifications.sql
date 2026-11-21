CREATE TABLE notification_destinations (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, sealed TEXT NOT NULL,
  UNIQUE(product_id,name)
);
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, definition TEXT NOT NULL, template TEXT NOT NULL,
  destination TEXT REFERENCES notification_destinations(id) ON DELETE RESTRICT,
  cursor_ms INTEGER NOT NULL, cursor_key TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(product_id,name)
);
CREATE TABLE notification_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL, rule_name TEXT NOT NULL, origin TEXT NOT NULL, at_ms INTEGER NOT NULL,
  event_id TEXT, profile_id TEXT, source_id TEXT, event_ms INTEGER,
  message TEXT NOT NULL, destination TEXT, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL DEFAULT 0,
  UNIQUE(rule_id,origin)
);
CREATE INDEX notifications_by_project ON notification_history(product_id,seq);
CREATE INDEX notifications_due ON notification_history(status,next_ms);
