-- ============================================================================
-- Migration 023: Add requires_task column to agents table
-- ============================================================================
-- Safe to run against a database that already has data (additive only).
-- Default is 1 (true) to preserve existing behavior for all pre-existing agents.
-- Agents that loop on their own prompt (e.g. information-collector-agent) should
-- be set to 0 (false).
-- ============================================================================

ALTER TABLE agents ADD requires_task BIT NOT NULL DEFAULT 1;
