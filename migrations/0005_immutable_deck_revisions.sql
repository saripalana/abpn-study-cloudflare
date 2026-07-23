PRAGMA foreign_keys = ON;

-- Immutable source-package revisions. Ordinary deck updates append a revision
-- instead of destroying the prior imported source package.
CREATE TABLE IF NOT EXISTS deck_package_revisions (
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  short_title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  content_class TEXT NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  question_count INTEGER NOT NULL CHECK (question_count > 0 AND question_count <= 5000),
  package_bytes INTEGER NOT NULL CHECK (package_bytes > 0 AND package_bytes <= 26214400),
  chunk_count INTEGER NOT NULL CHECK (chunk_count > 0 AND chunk_count <= 96),
  imported_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, deck_id, checksum),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deck_package_revision_chunks (
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 96),
  chunk_text TEXT NOT NULL,
  PRIMARY KEY (user_id, deck_id, checksum, chunk_index),
  FOREIGN KEY (user_id, deck_id, checksum)
    REFERENCES deck_package_revisions(user_id, deck_id, checksum)
    ON DELETE CASCADE
);

-- The head is a small pointer. Changing the active version never removes a
-- prior immutable revision.
CREATE TABLE IF NOT EXISTS deck_package_heads (
  user_id TEXT NOT NULL,
  deck_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, deck_id),
  FOREIGN KEY (user_id, deck_id, checksum)
    REFERENCES deck_package_revisions(user_id, deck_id, checksum)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_deck_revisions_user_deck_created
  ON deck_package_revisions(user_id, deck_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deck_heads_user_updated
  ON deck_package_heads(user_id, updated_at DESC);

-- Preserve every currently stored package as the first immutable revision.
INSERT OR IGNORE INTO deck_package_revisions (
  user_id, deck_id, checksum, version, title, short_title, description,
  source_type, content_class, source_label, question_count, package_bytes,
  chunk_count, imported_at, created_at
)
SELECT
  user_id, deck_id, checksum, version, title, short_title, description,
  source_type, content_class, source_label, question_count, package_bytes,
  chunk_count, created_at, created_at
FROM deck_packages;

INSERT OR IGNORE INTO deck_package_revision_chunks (
  user_id, deck_id, checksum, chunk_index, chunk_text
)
SELECT
  chunks.user_id,
  chunks.deck_id,
  packages.checksum,
  chunks.chunk_index,
  chunks.chunk_text
FROM deck_package_chunks AS chunks
JOIN deck_packages AS packages
  ON packages.user_id = chunks.user_id
 AND packages.deck_id = chunks.deck_id;

INSERT OR IGNORE INTO deck_package_heads (user_id, deck_id, checksum, updated_at)
SELECT user_id, deck_id, checksum, updated_at
FROM deck_packages;
