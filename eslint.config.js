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

  // Backend: Node.js runtime globals. The backend `lint` script targets both
  // `src` and `scripts`, so the parser is pointed at tsconfig.eslint.json
  // (which includes src, scripts, and the gitignored eslint-fixtures dir)
  // rather than the emit-only tsconfig.json — otherwise every scripts/*.ts file
  // would trip a "not found by the project service" parsing error.
  //
  // An include-based project (not projectService's allowDefaultProject) is used
  // on purpose: allowDefaultProject throws "Too many files (>8) have matched the
  // default project" once scripts + ephemeral test fixtures exceed 8 files; an
  // include list has no such cap.
  {
    files: ["backend/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: ["./backend/tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: guardrailRules,
  },

  // Frontend: browser runtime globals (React/Vite app). Uses the project
  // service, which auto-discovers the right tsconfig (app vs. node/e2e).
  {
    files: ["frontend/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
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
