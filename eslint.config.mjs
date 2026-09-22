// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // Global ignores -- files never linted
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "worker/**",
      "mcp-proxy/**",
      "infra/**",
      "knowledge-base/**",
      ".kiro/**",
      ".idea/**",
    ],
  },

  // -----------------------------------------------------------
  // Backend -- type-aware rules (requires parserOptions.project)
  // -----------------------------------------------------------
  {
    files: ["backend/src/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      // Use the non-type-checked recommended set as the base so we don't
      // inherit the full strict type-checked preset (which flags a lot of
      // pre-existing patterns like `any` in catch clauses, `require-await`,
      // unsafe member access, etc.).  We then opt-in to the specific
      // type-aware rules the project actually wants to enforce.
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        // Type-aware parsing is still required for no-floating-promises
        project: "./backend/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Critical async-safety rule (coding_guidelines s25):
      // Unawaited promises are the #1 source of fire-and-forget bugs in
      // autonomous-agent code.  Requires type-aware parsing.
      "@typescript-eslint/no-floating-promises": "error",

      // Type-safety: disallow explicit `any` in source code.
      "@typescript-eslint/no-explicit-any": "error",

      // Dead code detection
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Allow == null / != null checks (catches both null and undefined, a
      // well-established TS idiom); require === / !== everywhere else.
      eqeqeq: ["error", "always", { null: "ignore" }],

      // No console in production source -- use the structured logger instead
      "no-console": "error",

      // Disable the plain JS rule in favour of the TS-aware version above
      "no-unused-vars": "off",
    },
  },

  // Backend scripts -- same rules but use the scripts tsconfig for type-aware parsing
  {
    files: ["backend/scripts/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: "./backend/tsconfig.scripts.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      // Scripts output via console by design
      "no-console": "off",
      "no-unused-vars": "off",
    },
  },

  // Relax rules in backend test / spec files.
  // Tests legitimately use `any` for mocking, `Function` type for stubs,
  // and may leave some mock-setup vars unused.
  {
    files: [
      "backend/src/**/*.test.ts",
      "backend/src/tests/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      // The `Function` type is routinely used for vi.fn() / jest.fn() type
      // assertions in test helpers -- relax the restriction here.
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      // Unused mock variables in test setup are common
      "@typescript-eslint/no-unused-vars": "warn",
      // Tests may assert on console output via spies -- relax the ban
      "no-console": "warn",
    },
  },

  // migrate.ts doubles as both a DB module and a standalone script.
  // Allow console output for its startup diagnostics.
  {
    files: ["backend/src/db/migrate.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // kiro-runner.ts interfaces with @agentclientprotocol/sdk which ships no
  // TypeScript definitions -- `any` is unavoidable until the SDK is typed.
  // Demote no-explicit-any to a warning so it's visible but not blocking.
  {
    files: ["backend/src/agent/kiro-runner.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // -----------------------------------------------------------
  // Frontend -- type-aware rules
  // -----------------------------------------------------------
  {
    files: ["frontend/src/**/*.ts", "frontend/src/**/*.tsx"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: "./frontend/tsconfig.app.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Floating promises in React event handlers are intentional fire-and-forget
      // patterns (onClick, onChange, etc.) -- warn rather than error so they remain
      // visible but don't block the build. TODO: add void prefixes incrementally.
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      // console.log is common in frontend debugging -- warn but don't block.
      // TODO: remove debug console calls over time.
      "no-console": "warn",
      "no-unused-vars": "off",
    },
  },

  // Relax rules in frontend test files
  {
    files: [
      "frontend/src/**/*.test.ts",
      "frontend/src/**/*.test.tsx",
      "frontend/src/__tests__/**",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-console": "warn",
    },
  },

  // Prettier must be last -- disables all formatting rules that conflict with prettier
  prettierConfig,
);
