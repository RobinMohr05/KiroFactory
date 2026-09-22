/**
 * Tests for the ESLint lint-gate infrastructure (coding_guidelines.MD §21 —
 * Linting & Formatting, rated HIGH).
 *
 * §21 requires ESLint (with @typescript-eslint) enforcement, a `lint` script,
 * and a CI lint gate that fails the build on lint errors. The repo previously
 * had none of these. These tests pin that the infrastructure now exists and,
 * critically, that ESLint actually runs and reports zero *errors* over the
 * backend sources (warnings are allowed for the rules being phased in — see
 * eslint.config.js). A lint gate that can't run, or that reports errors on the
 * existing tree, would break CI, so we assert the end-to-end `eslint` exit
 * status rather than just the config's presence.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// backend/src/tests -> repo root
const repoRoot = resolve(here, "..", "..", "..");
const backendDir = resolve(repoRoot, "backend");
const frontendDir = resolve(repoRoot, "frontend");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function scriptsOf(path: string): Record<string, string> {
  return (readJson(path).scripts ?? {}) as Record<string, string>;
}

describe("ESLint configuration (coding_guidelines §21)", () => {
  it("has a flat ESLint config at the repo root", () => {
    const flat = resolve(repoRoot, "eslint.config.js");
    const flatMjs = resolve(repoRoot, "eslint.config.mjs");
    expect(existsSync(flat) || existsSync(flatMjs)).toBe(true);
  });

  it("declares eslint + @typescript-eslint as root devDependencies", () => {
    const pkg = readJson(resolve(repoRoot, "package.json"));
    const dev = (pkg.devDependencies ?? {}) as Record<string, string>;
    expect(dev.eslint).toBeTruthy();
    expect(dev["typescript-eslint"]).toBeTruthy();
  });

  it("exposes a root `lint` script", () => {
    expect(scriptsOf(resolve(repoRoot, "package.json")).lint).toBeTruthy();
  });

  it("exposes a `lint` script in backend and frontend", () => {
    expect(scriptsOf(resolve(backendDir, "package.json")).lint).toBeTruthy();
    expect(scriptsOf(resolve(frontendDir, "package.json")).lint).toBeTruthy();
  });

  it("wires a lint step into the CI workflow", () => {
    const ci = readFileSync(resolve(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/run:\s*npm run lint/);
  });

  it("lints the backend source tree with zero errors", () => {
    // `eslint` exits non-zero only when there are errors (warnings do not fail
    // with the default --max-warnings). A throw here means real lint errors
    // were found.
    expect(() =>
      execFileSync("npx", ["eslint", "src"], {
        cwd: backendDir,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 180_000);
});
