// Shared base ESLint (flat) config for the monorepo.
//
// Consumed by each workspace's own `eslint.config.mjs`, which layers on the
// workspace-specific `parserOptions.project` (needed for the type-aware rules)
// and any environment globals. Formatting concerns are intentionally left to
// Prettier — `eslint-config-prettier` is applied last to switch off any rules
// that would fight it (see coding_guidelines.MD §21).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * Build the shared config array. Callers pass the directory that holds their
 * `tsconfig.json` so the type-aware rules can locate the TS project.
 *
 * @param {string} tsconfigRootDir absolute path to the workspace root
 * @returns {import("typescript-eslint").ConfigArray}
 */
export function baseConfig(tsconfigRootDir) {
  return tseslint.config(
    js.configs.recommended,
    // Register the TypeScript parser/plugin (so `.ts`/`.tsx` parse and the
    // `@typescript-eslint/*` rules are available) without pulling in the full
    // `recommended` preset. We deliberately opt in to only the specific rules
    // called out in coding_guidelines.MD §21, keeping this an incremental,
    // focused guardrail against the AI-defect classes the task targets
    // (unhandled promises, `any`, `==`, unused vars) rather than a wholesale
    // lint of every pre-existing style nit.
    {
      files: ["**/*.{ts,tsx,mts,cts}"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          // Type-aware parsing is required for `no-floating-promises`.
          projectService: true,
          tsconfigRootDir,
        },
      },
      plugins: {
        "@typescript-eslint": tseslint.plugin,
      },
      rules: {
        // `no-undef` is redundant/incorrect for TypeScript (the compiler
        // handles undefined identifiers), and it misfires on TS-only globals.
        "no-undef": "off",
        // Type-aware safety rules called out as the primary AI-defect
        // guardrails in coding_guidelines.MD §21/§25.
        "@typescript-eslint/no-floating-promises": "error",
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unused-vars": [
          "error",
          {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
          },
        ],
        "eqeqeq": ["error", "always"],
        "no-return-await": "error",
        // Disable the core `no-unused-vars` in favour of the TS-aware version
        // above (the core rule doesn't understand type-only usages).
        "no-unused-vars": "off",
      },
    },
    // Tests can be looser — they legitimately reach into internals and use
    // throwaway values.
    {
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
      rules: {
        "@typescript-eslint/no-explicit-any": "off",
        "no-console": "off",
      },
    },
    // Prettier last: disable all formatting-related rules.
    prettier,
  );
}
