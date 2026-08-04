-- ============================================================================
-- Migration 022: Agent kind + stage states, expand board columns to 7 states
-- ============================================================================
-- Safe to run against a database that already has data (additive only).
-- This is a reference SQL file; the actual migration is executed by the
-- TypeScript migration runner in backend/src/db/migrate.ts (Upgrade 22).
-- ============================================================================

-- Part A: Add kind and stage state columns to agents table
-- "editor" agents produce file changes (today's default behavior).
-- "inspector" agents must not produce file changes (orchestrator discards diffs).
-- Stage columns let each agent kind define its pipeline stage without hardcoding
-- (e.g. reviewer: claim_state='developed', working_state='in-code-review',
--  resolve_state='reviewed').

ALTER TABLE agents ADD
    kind VARCHAR(20) NOT NULL DEFAULT 'editor';

ALTER TABLE agents ADD CONSTRAINT CK_agents_kind CHECK (kind IN ('editor','inspector'));

ALTER TABLE agents ADD
    claim_state   VARCHAR(50) NOT NULL DEFAULT 'todo',
    working_state VARCHAR(50) NOT NULL DEFAULT 'in-progress',
    resolve_state VARCHAR(50) NOT NULL DEFAULT 'developed';

-- Part B: Expand tabs.columns_json from 3-column to 7-column pipeline.
-- Decision: UPDATE existing rows that still have the old 3-column default.
-- Tabs that have been manually customized are left alone to preserve
-- intentional per-tab customization.

UPDATE tabs
SET columns_json = '["todo","in-progress","developed","in-code-review","reviewed","in-qa","done"]'
WHERE columns_json = '["todo","in-progress","developed"]';

-- Part C: Update the DEFAULT constraint on tabs.columns_json to the new value.
-- (The actual TypeScript migration dynamically looks up the constraint name
--  from sys.default_constraints and drops/recreates it.)
-- Conceptually:
--   ALTER TABLE tabs DROP CONSTRAINT [DF__tabs__columns__<hash>];
--   ALTER TABLE tabs ADD DEFAULT '["todo","in-progress","developed","in-code-review","reviewed","in-qa","done"]' FOR columns_json;
