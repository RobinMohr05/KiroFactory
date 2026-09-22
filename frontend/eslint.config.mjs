// Frontend ESLint (flat) config — layers the shared monorepo base
// (see ../eslint.config.base.mjs) on top of browser globals and React
// hooks/fast-refresh rules. Type-aware rules resolve the TS project from
// this directory.
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { baseConfig } from "../eslint.config.base.mjs";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  ...baseConfig(import.meta.dirname),
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
];
