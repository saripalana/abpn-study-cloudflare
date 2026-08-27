CREATE TABLE IF NOT EXISTS assistant_study_coach_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('package', 'output')),
  created_at TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
  primary_timestamp TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  UNIQUE(user_id, artifact_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assistant_study_coach_artifacts_user_type
  ON assistant_study_coach_artifacts(user_id, artifact_type);

CREATE TABLE IF NOT EXISTS assistant_study_coach_artifact_chunks (
  artifact_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_text TEXT NOT NULL,
  PRIMARY KEY (artifact_id, chunk_index),
  FOREIGN KEY (artifact_id) REFERENCES assistant_study_coach_artifacts(id) ON DELETE CASCADE
);
