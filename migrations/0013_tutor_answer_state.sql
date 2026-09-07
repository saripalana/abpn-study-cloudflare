-- Preserve tutor draft/submitted state and per-test retry accounting through sync.
-- Additive only: existing selections, scores, history, and timestamps are unchanged.
ALTER TABLE practice_set_answers ADD COLUMN tutor_state_json TEXT;
