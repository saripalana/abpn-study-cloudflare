PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  utc_day TEXT NOT NULL,
  utc_minute TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  write_actions INTEGER NOT NULL DEFAULT 0 CHECK (write_actions >= 0),
  rows_read INTEGER NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
  rows_written INTEGER NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  suspension_reason TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_usage (
  id,
  utc_day,
  utc_minute,
  request_count,
  write_actions,
  rows_read,
  rows_written,
  suspended,
  suspension_reason,
  updated_at
) VALUES (
  1,
  strftime('%Y-%m-%d', 'now'),
  strftime('%Y-%m-%dT%H:%M', 'now'),
  0,
  0,
  0,
  0,
  0,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
