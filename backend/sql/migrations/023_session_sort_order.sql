-- ============================================================================
-- Migration 023: Add sort_order column to sessions table
-- ============================================================================
-- Safe to run against a database that already has data (additive only).
-- This is a reference SQL file; the actual migration is executed by the
-- TypeScript migration runner in backend/src/db/migrate.ts (Upgrade 23).
-- ============================================================================

-- Add sort_order column for user-defined session ordering within pinned/unpinned groups.
-- Combined with the existing pinned column, sessions are ordered:
-- ORDER BY pinned DESC, sort_order ASC

ALTER TABLE sessions ADD sort_order INT NOT NULL DEFAULT 0;
