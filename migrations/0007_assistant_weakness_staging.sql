PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assistant_weakness_permissions (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  granted_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  publish_count INTEGER NOT NULL DEFAULT 0 CHECK (publish_count >= 0),
  access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assistant_weakness_snapshots (
  user_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assistant_weakness_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('permission-granted', 'permission-revoked', 'snapshot-published', 'snapshot-accessed')),
  device_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assistant_weakness_audit_user_time
  ON assistant_weakness_audit(user_id, occurred_at);
