/**
 * Locks in the wiring the task requires around the ESLint config itself:
 * a `lint` script in every workspace + the root, and exact-pinned tool
 * versions (coding_guidelines.MD §8 — no `^`/`~` ranges on the lint toolchain).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function pkg(rel) {
  return JSON.parse(readFileSync(join(rootDir, rel), "utf8"));
}

describe("ESLint wiring in package.json files", () => {
  it("root has a lint script", () => {
    expect(pkg("package.json").scripts.lint).toBeTruthy();
  });

  it("backend has a lint script", () => {
    expect(pkg("backend/package.json").scripts.lint).toBeTruthy();
  });

  it("frontend has a lint script", () => {
    expect(pkg("frontend/package.json").scripts.lint).toBeTruthy();
  });

  it("pins the lint toolchain to exact versions (no ^ or ~)", () => {
    const dev = pkg("package.json").devDependencies;
    for (const name of ["eslint", "typescript-eslint", "eslint-config-prettier", "@eslint/js"]) {
      expect(dev[name], `${name} must be a dependency`).toBeTruthy();
      expect(dev[name], `${name} must be pinned exactly`).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});
