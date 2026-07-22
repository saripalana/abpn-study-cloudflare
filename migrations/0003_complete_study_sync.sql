PRAGMA foreign_keys = ON;

ALTER TABLE practice_sets ADD COLUMN timed INTEGER NOT NULL DEFAULT 0 CHECK (timed IN (0, 1));
ALTER TABLE practice_sets ADD COLUMN current_index INTEGER NOT NULL DEFAULT 0 CHECK (current_index >= 0);
ALTER TABLE practice_sets ADD COLUMN remaining_seconds INTEGER NOT NULL DEFAULT 0 CHECK (remaining_seconds >= 0);
ALTER TABLE practice_sets ADD COLUMN submitted INTEGER NOT NULL DEFAULT 0 CHECK (submitted IN (0, 1));
