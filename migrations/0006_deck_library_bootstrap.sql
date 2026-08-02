PRAGMA foreign_keys = ON;

-- Records completion of bounded, idempotent starter-deck preparation without
-- changing deck content or exposing the internal System Validation fixture.
CREATE TABLE IF NOT EXISTS deck_library_state (
  user_id TEXT PRIMARY KEY,
  bootstrap_version TEXT NOT NULL DEFAULT '',
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
