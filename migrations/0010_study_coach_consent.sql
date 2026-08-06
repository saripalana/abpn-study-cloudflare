PRAGMA foreign_keys = ON;

-- Existing content-free approvals must never silently authorize the broader
-- Study Coach dataset. Only a fresh version-2 consent enables access.
ALTER TABLE assistant_weakness_permissions
  ADD COLUMN consent_version INTEGER NOT NULL DEFAULT 1 CHECK (consent_version IN (1, 2));
