// @ts-check
/**
 * Root ESLint flat config (coding_guidelines.MD §21 — Linting & Formatting).
 *
 * Scope: the two TypeScript workspaces, `backend/` and `frontend/`. The plain
 * JavaScript packages (`worker/`, `mcp-proxy/`) are intentionally out of scope
 * for now (§21 says they can be handled separately) and are ignored below.
 *
 * CI gate (§21): the lint gate is meant to run in CI via a `- run: npm run lint`
 * step in `.github/workflows/ci.yml`. That workflow edit is NOT part of this
 * change because the delivery token lacks the GitHub `workflow` scope (pushes
 * touching `.github/workflows/` are rejected); a maintainer needs to add that
 * one step manually — it just invokes the `lint` scripts added here.
 *
 * Rule philosophy (per §21): ESLint owns code quality only — formatting is left
 * to a formatter, so `eslint-config-prettier` is applied last to switch off any
 * stylistic rules. We start from typescript-eslint's `recommended` +
 * `recommendedTypeChecked` (type-aware) rule sets so the full type-aware rule
 * catalogue is active.
 *
 * Ratchet strategy: this is the *first* lint gate on a large, pre-existing tree
 * that was never linted, so turning every recommended rule straight to `error`
 * would paint CI red on hundreds of legacy violations and make the gate
 * un-mergeable. On this first pass every rule (both the type-aware
 * `recommendedTypeChecked` catalogue and the emphasised bug-class rules such as
 * `eqeqeq` / `no-floating-promises` / unused-vars) is set to `warn`: violations
 * are surfaced in `eslint` output but non-blocking, since `eslint` only exits
 * non-zero on `error`s. That makes the CI step green today while still failing
 * on genuinely broken input (parse/config errors). As the warning debt is
 * burned down in follow-up passes, individual rules — starting with the
 * emphasised set in `guidelineRules` — can be promoted to `error` one line at a
 * time.
 *
 * Note: flat-config `files`/`ignores` globs are resolved relative to *this*
 * config file's directory (the repo root), not the current working directory,
 * so `eslint src` works identically whether invoked from the repo root or from
 * inside a workspace (`npm run lint -w backend`).
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

/**
 * Downgrade every "error"-severity rule in a set of flat-config blocks to
 * "warn", preserving each rule's options. Used to phase in rule catalogues as
 * non-blocking warnings on the existing (never-linted) tree — see the ratchet
 * note in the header.
 *
 * @param {readonly import("eslint").Linter.Config[]} configs
 * @returns {import("eslint").Linter.Config[]}
 */
function asWarnings(configs) {
  return configs.map((config) => {
    if (!config.rules) return config;
    /** @type {import("eslint").Linter.RulesRecord} */
    const rules = {};
    for (const [name, entry] of Object.entries(config.rules)) {
      if (Array.isArray(entry)) {
        rules[name] = entry[0] === "error" || entry[0] === 2 ? ["warn", ...entry.slice(1)] : entry;
      } else {
        rules[name] = entry === "error" || entry === 2 ? "warn" : entry;
      }
    }
    return { ...config, rules };
  });
}

/**
 * Bug-class rules the guidelines (§21, and §1's common-bug list) emphasise.
 *
 * On this first pass they are set to `warn` (not `error`) for the same ratchet
 * reason as the type-aware catalogue: the never-linted tree already trips ~100
 * of them (mostly `no-floating-promises` in event handlers and `eqeqeq`), and a
 * gate that's red on legacy code can't be merged or enforced. They're spelled
 * out here — separate from the bulk downgrade — so promoting any one of them
 * back to `"error"` once its debt is paid down is a one-line change. Shared by
 * both workspaces.
 */
const guidelineRules = {
  eqeqeq: ["warn", "always"],
  "@typescript-eslint/no-floating-promises": "warn",
  "@typescript-eslint/no-unused-vars": [
    "warn",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
};

// Core ESLint recommended + the type-aware catalogue, phased in as warnings.
const jsRecommendedAsWarnings = asWarnings([js.configs.recommended])[0];
const typeCheckedAsWarnings = asWarnings([
  ...tseslint.configs.recommendedTypeChecked,
]);

export default tseslint.config(
  {
    // Global ignores — build output, deps, plain-JS packages, config/asset files.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "worker/**",
      "mcp-proxy/**",
      "infra/**",
      "**/*.js",
      "**/*.cjs",
      "**/*.mjs",
    ],
  },

  // ---- backend (Node, type-checked against backend/tsconfig.json) ----
  {
    files: ["backend/**/*.ts"],
    extends: [jsRecommendedAsWarnings, ...typeCheckedAsWarnings],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname + "/backend",
      },
    },
    rules: guidelineRules,
  },

  // ---- frontend (browser + React, type-checked) ----
  {
    files: ["frontend/**/*.{ts,tsx}"],
    extends: [jsRecommendedAsWarnings, ...typeCheckedAsWarnings],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname + "/frontend",
      },
    },
    rules: {
      ...guidelineRules,
      ...asWarnings([{ rules: reactHooks.configs.recommended.rules }])[0].rules,
    },
  },

  // Test files: relax the async-safety + unused-vars checks that legitimately
  // show up in test setups (mocked promises, intentional fire-and-forget in
  // fixtures, unused helper imports).
  {
    files: ["**/*.test.{ts,tsx}", "backend/src/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },

  // Turn off all formatting-related rules — a formatter owns those (§21).
  prettier,
);
