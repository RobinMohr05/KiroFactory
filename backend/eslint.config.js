// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript-aware rules for source files (covered by tsconfig.json)
  {
    files: ['src/**/*.ts'],
    extends: [
      // Recommended rules without the type-checked unsafe-* rules.
      // Those require all `any` usages to be eliminated first; they will be
      // re-enabled incrementally as the codebase is cleaned up.
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // projectService enables type-aware rules (no-floating-promises, etc.)
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ─── Type Safety ────────────────────────────────────────────────────────
      // Catch explicit `any` usage — agents commonly sprinkle these
      '@typescript-eslint/no-explicit-any': 'error',

      // ─── Async / Promise Safety ─────────────────────────────────────────────
      // Critical: a floating promise is a silent bug — fire-and-forget without intent
      '@typescript-eslint/no-floating-promises': 'error',

      // Prevent misuse of promises in contexts that expect void (e.g. event handlers).
      // `checksVoidReturn.arguments` is disabled because Express route handlers are
      // typed as `(req, res) => void` but conventionally written as async functions —
      // this is a known Express typing limitation, not a real bug.
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            arguments: false,
          },
        },
      ],

      // ─── Code Quality ────────────────────────────────────────────────────────
      // Catch unused variables — _ prefix exception for intentional ignoring
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Always use === over ==, except for `== null` which is a legitimate pattern
      // for checking both null and undefined simultaneously
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Prefer const over let where reassignment doesn't occur
      'prefer-const': 'error',

      // ─── Warnings (improve incrementally, don't block CI yet) ────────────────
      // Misleading boolean expressions (nullable strings/booleans in conditions)
      '@typescript-eslint/strict-boolean-expressions': 'warn',

      // Warn on console usage — prefer structured logging in production code
      'no-console': 'warn',
    },
  },

  // Scripts: lint with recommended rules only (no type-aware rules, since
  // scripts/ is not included in tsconfig.json and runs via tsx directly)
  {
    files: ['scripts/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-console': 'warn',
    },
  },

  // Test files: relax rules that are overly strict for test/mock code
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Vitest test callbacks (it, describe, beforeAll) are typed as returning
      // void but tests use async functions — disable the check for arguments
      '@typescript-eslint/no-misused-promises': [
        'warn',
        {
          checksVoidReturn: {
            arguments: false,
          },
        },
      ],
      '@typescript-eslint/no-floating-promises': 'warn',
      // Test files commonly have unused variables for setup/teardown
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Tests use Function type for mock matchers (e.g. expect(fn).toHaveBeenCalledWith)
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      // Tests often use let for variables that technically could be const
      'prefer-const': 'warn',
      // Test template literals sometimes use escape chars for readability
      'no-useless-escape': 'warn',
    },
  },

  // Ignore compiled output and node_modules
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
