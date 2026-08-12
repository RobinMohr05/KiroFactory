-- Migration 023: Add requires_task flag to agents table
-- Agents with requires_task = 0 run on their own prompt without claiming tasks.
-- Default 1 (true) preserves current behavior for all existing agents.

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('agents') AND name = 'requires_task'
)
BEGIN
  ALTER TABLE agents ADD requires_task BIT NOT NULL DEFAULT 1;
END
