CREATE TABLE IF NOT EXISTS complete_recovery_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  integrity_digest TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  UNIQUE(user_id, utc_day),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS complete_recovery_chunks (
  bundle_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  PRIMARY KEY (bundle_id, chunk_index),
  FOREIGN KEY (bundle_id) REFERENCES complete_recovery_bundles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_complete_recovery_user_created
  ON complete_recovery_bundles(user_id, created_at DESC);
