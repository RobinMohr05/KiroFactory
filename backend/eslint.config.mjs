// Backend ESLint (flat) config — layers the shared monorepo base
// (see ../eslint.config.base.mjs) on top of backend-specific ignores and
// Node globals. Type-aware rules resolve the TS project from this directory.
import globals from "globals";
import { baseConfig } from "../eslint.config.base.mjs";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...baseConfig(import.meta.dirname, [
    // Files that aren't in backend/tsconfig.json (which only includes src/**)
    // but should still be linted.
    "vitest.config.ts",
    "scripts/*.ts",
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
