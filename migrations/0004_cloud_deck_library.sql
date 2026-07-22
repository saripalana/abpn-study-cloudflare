PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS deck_packages (
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  title TEXT NOT NULL,
  short_title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content_class TEXT NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL,
  question_count INTEGER NOT NULL CHECK (question_count > 0 AND question_count <= 5000),
  package_bytes INTEGER NOT NULL CHECK (package_bytes > 0 AND package_bytes <= 26214400),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0 AND chunk_count <= 128),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, deck_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deck_package_chunks (
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 128),
  chunk_text TEXT NOT NULL,
  PRIMARY KEY (user_id, deck_id, chunk_index),
  FOREIGN KEY (user_id, deck_id) REFERENCES deck_packages(user_id, deck_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deck_packages_user_updated
  ON deck_packages(user_id, updated_at DESC);
