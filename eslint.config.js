// @ts-check
/**
 * Shared ESLint flat config for the whole monorepo.
 *
 * Why this exists: KiroFactory is an autonomous AI-agent system — agents
 * generate, commit, and open PRs without human involvement until review
 * (see information/coding_guidelines.MD §25 "AI Agent Code Guardrails" and
 * §21 "Linting & Formatting"). ESLint is the primary *automated* guardrail
 * against agent-introduced bugs; `tsc` and vitest alone don't catch floating
 * promises, stray `any`, dead vars, or loose equality.
 *
 * Separation of concerns (§21): ESLint owns code *quality*; Prettier owns
 * *formatting*. `eslint-config-prettier` is applied last to switch off any
 * ESLint rules that would fight Prettier.
 *
 * Coverage:
 *  - Backend + frontend TypeScript get type-aware linting (via
 *    `projectService`, which resolves each file to its nearest tsconfig).
 *  - The worker/ and mcp-proxy/ plain-JS MCP servers get non-type-aware
 *    linting (they have no tsconfig) plus the same eqeqeq / no-unused-vars
 *    guardrails.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * The `_`-prefix ignore pattern for unused-vars, shared between the core JS
 * rule (plain-JS block) and the @typescript-eslint variant (TS block).
 */
const unusedVarsOptions = {
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
};

export default tseslint.config(
  {
    // Never lint build output, deps, or coverage artifacts.
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.min.js",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },

  // Base recommended JS rules everywhere.
  js.configs.recommended,

  // TypeScript (backend + frontend). We enable the (non-type-checked)
  // recommended set as a sane baseline, then layer on the specific type-aware
  // guardrails the project requires. We deliberately do NOT enable the full
  // `recommendedTypeChecked` preset: its `no-unsafe-*` family would flag
  // thousands of pre-existing call sites at once, which would make the CI
  // lint gate (see the follow-up task) impossible to turn on. The rules
  // enabled here are exactly the guardrails called out in
  // coding_guidelines.MD §21/§25: no-floating-promises, no-explicit-any,
  // no-unused-vars (with `_` exception) and eqeqeq.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        // Resolve each file to its nearest tsconfig automatically so the
        // type-aware rules below (e.g. no-floating-promises) work for both the
        // backend and frontend projects without hand-listing every tsconfig.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "@typescript-eslint/no-unused-vars": ["error", unusedVarsOptions],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },

  // Plain-JS MCP servers / proxies (no tsconfig -> non-type-aware).
  {
    files: ["worker/**/*.js", "mcp-proxy/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      eqeqeq: ["error", "always"],
      "no-unused-vars": ["error", unusedVarsOptions],
    },
  },

  // Turn off ESLint rules that conflict with Prettier — Prettier owns
  // formatting (§21). Must stay last so it wins.
  prettier,
);
