import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression test for the dark-mode caret defect on the shared `.tab-select`
 * dropdown (PR #125 review). The global `[data-theme="dark"] select` rule uses
 * the `background` *shorthand*, which resets `background-image` (the custom SVG
 * caret) to `none` and has higher specificity (0-1-1) than `.tab-select`
 * (0-1-0). The base `.tab-select` also sets `appearance: none`, so in dark mode
 * the control ended up with no visible dropdown arrow.
 *
 * The fix must re-declare the caret for `.tab-select` in dark mode with
 * matching-or-higher specificity so the arrow survives.
 */
describe('.tab-select dark-mode caret', () => {
  const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');

  it('re-declares the caret background-image under a dark-theme .tab-select rule', () => {
    // A rule scoped to dark mode that targets .tab-select and restores the
    // SVG caret via background-image.
    const darkRule = css.match(
      /\[data-theme="dark"\]\s*\.tab-select\s*\{([^}]*)\}/,
    );
    expect(darkRule).not.toBeNull();
    const body = darkRule![1];
    expect(body).toMatch(/background-image:\s*url\(/);
  });
});
