/**
 * lint-staged configuration — Layer 1 pre-commit guardrails (coding_guidelines §25).
 *
 * Runs on staged files at pre-commit so the self-correcting agent loop gets instant
 * feedback and can fix problems BEFORE a PR is opened.
 *
 * - Prettier auto-formats all supported staged files (and re-stages them).
 * - TypeScript type-checks the affected workspace with `tsc --noEmit`. Because the
 *   backend and frontend are separate TS projects with their own tsconfig, the
 *   type-check is scoped to whichever workspace has staged .ts/.tsx changes. It runs
 *   the whole project (not just the staged files) since a single-file `tsc --noEmit`
 *   can't resolve cross-file types.
 *
 * ESLint is intentionally not wired here yet — it lands with the dedicated ESLint task
 * this one depends on; add `eslint --fix` to the matcher below once that config exists.
 */
module.exports = {
  // Format any supported file that's staged.
  "*.{ts,tsx,js,jsx,mjs,cjs,json,md,css,html,yml,yaml}": ["prettier --write"],

  // Type-check the backend project when backend TS files are staged.
  "backend/**/*.{ts,tsx}": () => "tsc --noEmit -p backend/tsconfig.json",

  // Type-check the frontend project (composite, references) when frontend TS files
  // are staged. `tsc -b` respects the project's own `noEmit`/references settings.
  "frontend/**/*.{ts,tsx}": () => "tsc -b frontend/tsconfig.json",
};
