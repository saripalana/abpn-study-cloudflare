PRAGMA foreign_keys = ON;

ALTER TABLE assistant_weakness_permissions
  ADD COLUMN delete_count INTEGER NOT NULL DEFAULT 0 CHECK (delete_count >= 0);
