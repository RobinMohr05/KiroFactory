// @ts-check
/**
 * Shared Prettier config for the whole monorepo. Prettier owns *formatting*;
 * ESLint (eslint.config.js) owns *code quality* — see
 * information/coding_guidelines.MD §21. Values here match the style already
 * present in the codebase (double quotes, semicolons, ~100-col lines,
 * trailing commas).
 *
 * @type {import("prettier").Config}
 */
export default {
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  arrowParens: "always",
  endOfLine: "lf",
};
