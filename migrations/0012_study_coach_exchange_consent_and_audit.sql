PRAGMA foreign_keys = ON;

ALTER TABLE assistant_weakness_permissions
  ADD COLUMN exchange_consent_version INTEGER NOT NULL DEFAULT 0 CHECK (exchange_consent_version IN (0, 1));

ALTER TABLE assistant_weakness_permissions
  ADD COLUMN exchange_granted_at TEXT;

ALTER TABLE assistant_weakness_permissions
  ADD COLUMN exchange_publish_count INTEGER NOT NULL DEFAULT 0 CHECK (exchange_publish_count >= 0);

ALTER TABLE assistant_weakness_permissions
  ADD COLUMN exchange_access_count INTEGER NOT NULL DEFAULT 0 CHECK (exchange_access_count >= 0);

ALTER TABLE assistant_weakness_permissions
  ADD COLUMN last_exchange_accessed_at TEXT;

CREATE TABLE IF NOT EXISTS assistant_study_coach_exchange_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  device_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assistant_study_coach_exchange_audit_user_time
  ON assistant_study_coach_exchange_audit(user_id, occurred_at);
