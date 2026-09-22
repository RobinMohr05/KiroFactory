// Root ESLint flat config for the vibecode-heaven monorepo.
//
// Rationale (see information/coding_guidelines.MD §21 "Linting & Formatting"
// and §25 "AI Agent Code Guardrails"): this repo is an autonomous AI-agent
// system that writes and commits its own code, so ESLint is the primary layer
// of the agent self-correcting loop. A failed lint is what teaches the agent to
// fix an issue before opening a PR. The rules enabled below are the ones the
// guidelines rate HIGH and call out explicitly as guardrails.
//
// Separation of concerns (§21): ESLint owns code *quality*; Prettier owns
// *formatting*. eslint-config-prettier is applied last to switch off every
// stylistic rule so the two tools never fight.
//
// Type-aware linting is enabled via typescript-eslint's projectService, which
// wires the TypeScript program in for rules like no-floating-promises that
// cannot work from syntax alone.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

/**
 * The guardrail rule set from coding_guidelines.MD §21/§25, shared by every
 * type-checked TypeScript block. Kept in one place so backend and frontend can
 * only differ in their environment globals, not in what quality bar they meet.
 */
const guardrailRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    },
  ],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/return-await": ["error", "in-try-catch"],
  eqeqeq: ["error", "always"],
};

export default tseslint.config(
  // Never lint build output, deps, or generated assets.
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.min.js",
      "frontend/public/**",
    ],
  },

  // Baseline recommended JS rules for everything ESLint sees.
  js.configs.recommended,

  // Type-aware recommended rules for all TypeScript sources.
  ...tseslint.configs.recommendedTypeChecked,

  // Enable the type-aware parser + project service for TS files only.
  // allowDefaultProject lets files that are not included in any tsconfig
  // (e.g. backend/scripts/, or the ephemeral backend/eslint-fixtures/ dirs
  // created by the ESLint behaviour tests) still be type-checked using the
  // nearest tsconfig as a fallback, so `npm run lint -w backend` does not emit
  // "was not found by the project service" parse errors for those files.
  //
  // Note: allowDefaultProject globs must not contain '**' (too wide) —
  // single-level wildcards only. The fixture dirs are one level deep
  // (backend/eslint-fixtures/<tmpdir>/fixture.ts), so `*/*` is sufficient.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "backend/scripts/*.ts",
            "backend/eslint-fixtures/*/*.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Backend: Node.js runtime globals.
  {
    files: ["backend/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: guardrailRules,
  },

  // Frontend: browser runtime globals (React/Vite app).
  {
    files: ["frontend/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: guardrailRules,
  },

  // Test files may use `any` freely for fixtures/mocks and console for debug
  // output; the guidelines (§21) explicitly scope no-console off in tests.
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**", "**/tests/**", "backend/src/tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // Plain JavaScript (e.g. config files, worker scripts if linted) can't be
  // type-checked; disable the type-aware program requirement for them.
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // MUST be last: turn off all formatting rules so Prettier owns formatting.
  eslintConfigPrettier,
);
