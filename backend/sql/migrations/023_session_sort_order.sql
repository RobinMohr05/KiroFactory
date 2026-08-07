-- Migration 023: Add sort_order column to sessions table
-- Allows user-defined ordering of sessions in the session list.
-- Sessions are ordered by pinned DESC, sort_order ASC.

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'sessions' AND COLUMN_NAME = 'sort_order'
)
BEGIN
  ALTER TABLE sessions ADD sort_order INT NOT NULL DEFAULT 0;

  -- Initialize sort_order based on created_at within each pinned group
  WITH ordered AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY pinned ORDER BY created_at ASC) - 1 AS rn
    FROM sessions
  )
  UPDATE sessions SET sort_order = ordered.rn
  FROM sessions INNER JOIN ordered ON sessions.id = ordered.id;
END
