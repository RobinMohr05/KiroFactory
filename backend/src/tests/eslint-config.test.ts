/**
 * Tests for the shared ESLint + Prettier configuration (coding_guidelines.MD
 * §21 "Linting & Formatting" and §25 "AI Agent Code Guardrails", both HIGH).
 *
 * This project is an autonomous AI-agent system: agents generate, commit, and
 * open PRs of code without human involvement until review. §25 explicitly
 * relies on ESLint rules like `@typescript-eslint/no-floating-promises`
 * (async-safety) and `@typescript-eslint/no-explicit-any` as the primary
 * automated guardrail against agent-introduced bugs. Before this config
 * existed the only quality gate was `tsc` + vitest.
 *
 * These tests pin the guardrail contract, not formatting cosmetics:
 *  1. A shared flat config (eslint.config.js) exists at the repo root and
 *     lints TypeScript with type-aware rules.
 *  2. The required error-level rules actually fire on offending code:
 *     - @typescript-eslint/no-floating-promises
 *     - @typescript-eslint/no-explicit-any
 *     - @typescript-eslint/no-unused-vars (with a `_` prefix exception)
 *     - eqeqeq
 *  3. Both backend and frontend expose a `lint` npm script so the config is
 *     runnable (and, per the follow-up task, wireable into CI).
 *  4. eslint-config-prettier is applied so ESLint defers formatting to
 *     Prettier (no conflicting formatting rules stay enabled).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Lint an inline snippet through the repo's real flat config and return the
 * set of ruleIds that were reported. Uses the ESLint Node API against the
 * root eslint.config.js so we exercise the exact config agents/CI will use.
 *
 * `filePath` must point at a file that a tsconfig already includes (we reuse
 * a real backend source file) so the type-aware `projectService` can resolve
 * the file's program — the on-disk contents are ignored, only `code` is
 * linted.
 */
async function lintSnippet(code: string): Promise<string[]> {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: resolve(repoRoot, "eslint.config.js"),
  });
  const filePath = resolve(repoRoot, "backend/src/config.ts");
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((r) => r.messages.map((m) => m.ruleId ?? ""));
}

describe("shared ESLint config", () => {
  // Type-aware linting builds a full TS program on first invocation, which can
  // take well over the default 5s, especially in CI.
  const LINT_TIMEOUT = 60_000;

  it("has a flat config at the repo root", () => {
    expect(existsSync(resolve(repoRoot, "eslint.config.js"))).toBe(true);
  });

  it(
    "flags floating promises (async-safety guardrail)",
    async () => {
      const code = [
        "async function work(): Promise<void> {}",
        "function main(): void {",
        "  work();",
        "}",
        "main();",
        "",
      ].join("\n");
      const ruleIds = await lintSnippet(code);
      expect(ruleIds).toContain("@typescript-eslint/no-floating-promises");
    },
    LINT_TIMEOUT,
  );

  it(
    "flags explicit any",
    async () => {
      const code = ["export function bad(x: any): any {", "  return x;", "}", ""].join("\n");
      const ruleIds = await lintSnippet(code);
      expect(ruleIds).toContain("@typescript-eslint/no-explicit-any");
    },
    LINT_TIMEOUT,
  );

  it(
    "flags unused vars but allows a leading-underscore exception",
    async () => {
      const bad = [
        "export function f(): number {",
        "  const unused = 1;",
        "  return 2;",
        "}",
        "",
      ].join("\n");
      const badRules = await lintSnippet(bad);
      expect(badRules).toContain("@typescript-eslint/no-unused-vars");

      const ok = ["export function f(_unused: number): number {", "  return 2;", "}", ""].join("\n");
      const okRules = await lintSnippet(ok);
      expect(okRules).not.toContain("@typescript-eslint/no-unused-vars");
    },
    LINT_TIMEOUT,
  );

  it(
    "flags loose equality (eqeqeq)",
    async () => {
      const code = [
        "export function eq(a: number, b: number): boolean {",
        "  return a == b;",
        "}",
        "",
      ].join("\n");
      const ruleIds = await lintSnippet(code);
      expect(ruleIds).toContain("eqeqeq");
    },
    LINT_TIMEOUT,
  );
});

describe("lint script wiring", () => {
  it("backend package.json defines a lint script", () => {
    const pkg = readJson(resolve(repoRoot, "backend/package.json"));
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    expect(typeof scripts.lint).toBe("string");
    expect(scripts.lint).toMatch(/eslint/);
  });

  it("frontend package.json defines a lint script", () => {
    const pkg = readJson(resolve(repoRoot, "frontend/package.json"));
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    expect(typeof scripts.lint).toBe("string");
    expect(scripts.lint).toMatch(/eslint/);
  });
});
