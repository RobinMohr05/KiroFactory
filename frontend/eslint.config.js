// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript-aware rules for React source files (covered by tsconfig.app.json)
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      // Recommended rules without the type-checked unsafe-* rules.
      // Those require all `any` usages to be eliminated first; they will be
      // re-enabled incrementally as the codebase is cleaned up.
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ─── Type Safety ────────────────────────────────────────────────────────
      // Catch explicit `any` usage — agents commonly sprinkle these
      '@typescript-eslint/no-explicit-any': 'error',

      // ─── Async / Promise Safety ─────────────────────────────────────────────
      // Critical: a floating promise is a silent bug — fire-and-forget without intent.
      // NOTE: Many React components use fire-and-forget in useEffect hooks — this
      // is a common and valid pattern in React (useEffect must return void, not a
      // promise). These should be fixed incrementally with `void` operators.
      // Currently set to 'warn' to allow the existing patterns to be cleaned up
      // over time without blocking CI.
      '@typescript-eslint/no-floating-promises': 'warn',

      // Prevent misuse of promises in contexts that expect void.
      // `checksVoidReturn.arguments` and `checksVoidReturn.attributes` are
      // disabled because React event handlers (onClick, onChange, etc.) are typed
      // as `() => void` but are conventionally written as async functions —
      // this is a known React typing limitation, not a real bug.
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            arguments: false,
            attributes: false,
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

      // Warn on console usage in UI code
      'no-console': 'warn',
    },
  },

  // Vite config and Playwright config (node environment, different tsconfig)
  // These are excluded from the main src config since they use tsconfig.node.json
  {
    files: ['vite.config.ts', 'playwright.config.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.node.json',
        tsconfigRootDir: import.meta.dirname,
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
    },
  },

  // E2E test files
  {
    files: ['e2e/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },

  // Test files: relax rules that are overly strict for test/mock code
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/*.spec.{ts,tsx}'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-misused-promises': [
        'warn',
        {
          checksVoidReturn: {
            arguments: false,
            attributes: false,
          },
        },
      ],
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Ignore compiled output and node_modules
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
