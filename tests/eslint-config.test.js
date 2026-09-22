/**
 * Verifies the root ESLint flat config actually enforces the code-quality rules
 * that information/coding_guidelines.MD §21 (Linting & Formatting) and §25 (AI
 * Agent Code Guardrails) call out as the primary layer of the agent
 * self-correcting loop.
 *
 * This is a behavioural test, not a "does the file exist" check: it runs ESLint
 * (using the repo's real eslint.config.js) against small snippets that each
 * violate one guardrail rule, and asserts the corresponding rule fires as an
 * error. If someone weakens the config (drops a rule, downgrades it to "warn",
 * or removes type-aware parsing), one of these assertions breaks.
 *
 * Type-aware rules (e.g. @typescript-eslint/no-floating-promises) only work when
 * the parser is wired to the TypeScript program, so linting real files on disk
 * (not lintText with an anonymous path) is required for those to activate.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Lint a TS snippet by writing it into backend/eslint-fixtures/ (gitignored,
 * not tracked source) so the type-aware rules have a real TypeScript program.
 *
 * Using a gitignored directory (rather than backend/src/) avoids two problems:
 *  1. If the test run is killed before the `finally` block executes, a leaked
 *     fixture directory cannot be staged or committed (it's in .gitignore).
 *  2. Fixtures containing intentionally bad code cannot end up in the build
 *     output (dist/) because they are outside every tsconfig include.
 *
 * The directory is created on first use so the parent path always exists.
 */
async function lintBackendSnippet(code) {
  const fixturesBase = join(rootDir, "backend", "eslint-fixtures");
  mkdirSync(fixturesBase, { recursive: true });
  const dir = mkdtempSync(join(fixturesBase, "eslint-fixture-"));
  const file = join(dir, "fixture.ts");
  writeFileSync(file, code, "utf8");
  try {
    const eslint = new ESLint({ cwd: rootDir });
    const [result] = await eslint.lintFiles([file]);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ruleIds(result) {
  return (result?.messages ?? []).map((m) => m.ruleId);
}

describe("root ESLint flat config", () => {
  it("flags @typescript-eslint/no-explicit-any as an error", async () => {
    const result = await lintBackendSnippet(`export const x: any = 1;\n`);
    expect(ruleIds(result)).toContain("@typescript-eslint/no-explicit-any");
    const msg = result.messages.find((m) => m.ruleId === "@typescript-eslint/no-explicit-any");
    expect(msg.severity).toBe(2); // error, not warn
  });

  it("flags @typescript-eslint/no-unused-vars but allows an underscore prefix", async () => {
    const bad = await lintBackendSnippet(`export function f() { const unused = 1; return 2; }\n`);
    expect(ruleIds(bad)).toContain("@typescript-eslint/no-unused-vars");

    const ok = await lintBackendSnippet(`export function f() { const _unused = 1; return 2; }\n`);
    expect(ruleIds(ok)).not.toContain("@typescript-eslint/no-unused-vars");
  });

  it("flags @typescript-eslint/no-floating-promises (type-aware) as an error", async () => {
    const code = `
async function work(): Promise<void> {}
export function run(): void {
  work();
}
`;
    const result = await lintBackendSnippet(code);
    expect(ruleIds(result)).toContain("@typescript-eslint/no-floating-promises");
  });

  it("flags eqeqeq (requires === )", async () => {
    const result = await lintBackendSnippet(`export const b = (1 as number) == 2;\n`);
    expect(ruleIds(result)).toContain("eqeqeq");
  });

  it("flags no-return-await", async () => {
    const code = `
export async function g(): Promise<number> {
  return await Promise.resolve(1);
}
`;
    const result = await lintBackendSnippet(code);
    // @typescript-eslint replaces the core rule with its own; accept either id.
    const ids = ruleIds(result);
    expect(
      ids.includes("no-return-await") || ids.includes("@typescript-eslint/return-await"),
    ).toBe(true);
  });

  it("does not fight Prettier: no formatting-only rules are enabled", async () => {
    // eslint-config-prettier turns off stylistic rules. A snippet that is
    // "ugly" but logically fine (only formatting differs) should not trip any
    // core formatting rule such as quotes/semi/indent.
    const result = await lintBackendSnippet(`export const s = 'single'\n`);
    const formatting = ruleIds(result).filter((id) =>
      ["quotes", "semi", "indent", "comma-dangle", "@typescript-eslint/quotes", "@typescript-eslint/semi"].includes(id),
    );
    expect(formatting).toEqual([]);
  });

  it("produces no config-loading errors (the config parses and applies)", async () => {
    const result = await lintBackendSnippet(`export const ok: number = 1;\n`);
    // A fatal parse/config error surfaces as a message with fatal: true.
    const fatal = result.messages.filter((m) => m.fatal);
    expect(fatal).toEqual([]);
  });

  it("can type-aware lint backend/scripts/*.ts without a project-service parsing error", async () => {
    // The backend `lint` script targets both src and scripts. Every linted .ts
    // must belong to a TypeScript project (or be allowed as a default-project
    // file) or projectService emits a fatal "was not found by the project
    // service" parsing error. This guards that backend/scripts/ stays covered
    // (see PR #171 review comment 1).
    const eslint = new ESLint({ cwd: rootDir });
    const results = await eslint.lintFiles([join(rootDir, "backend", "scripts", "*.ts")]);
    expect(results.length).toBeGreaterThan(0);
    const parsingErrors = results.flatMap((r) =>
      r.messages.filter(
        (m) => m.fatal || /was not found by the project service/.test(m.message ?? ""),
      ),
    );
    expect(parsingErrors).toEqual([]);
  });

  it("keeps lint fixtures out of the tracked source tree (gitignored)", () => {
    // Fixtures are written under backend/eslint-fixtures/, which must be
    // gitignored so an interrupted run can never leave a committable/lintable
    // artifact in tracked source (see PR #171 review comment 2).
    const probe = join(rootDir, "backend", "eslint-fixtures", "eslint-fixture-probe", "fixture.ts");
    const out = execFileSync("git", ["check-ignore", probe], {
      cwd: rootDir,
      encoding: "utf8",
    }).trim();
    expect(out).toBe(probe);
  });
});
