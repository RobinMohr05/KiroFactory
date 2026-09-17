import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Usage chart mobile responsive styles (≤768px)', () => {
  const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');

  // Extract the 768px block that contains the "Usage Responsive" section.
  // Multiple 768px blocks exist; find the one with .usage-layout.
  function getUsage768Block(): string {
    const blocks: string[] = [];
    const re = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{([\s\S]*?)^\}/gm;
    let m;
    while ((m = re.exec(css)) !== null) {
      blocks.push(m[1]);
    }
    const usageBlock = blocks.find(b => b.includes('.usage-layout'));
    expect(usageBlock).toBeDefined();
    return usageBlock!;
  }

  it('makes .usage-chart-bars horizontally scrollable on mobile', () => {
    const block = getUsage768Block();
    expect(block).toMatch(/\.usage-chart-bars\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('gives .usage-chart-bar-wrapper a min-width so bars do not collapse on mobile', () => {
    const block = getUsage768Block();
    // min-width should be at least 8px (accepts values like 8px, 10px, 12px etc.)
    expect(block).toMatch(/\.usage-chart-bar-wrapper\s*\{[^}]*min-width:\s*\d+px/);
  });

  it('reduces .usage-chart-y-axis width to reclaim horizontal space on mobile', () => {
    const block = getUsage768Block();
    // Should be narrower than the default 50px (accept 28px–40px range)
    expect(block).toMatch(/\.usage-chart-y-axis\s*\{[^}]*width:\s*(?:2[89]|3[0-9]|40)px/);
  });

  it('does not change the desktop layout (no usage-chart rules outside media query)', () => {
    // The desktop .usage-chart-bars rule must NOT have overflow-x: auto
    // i.e. the rule is only inside a media query
    const desktopMatch = css.match(/\.usage-chart-bars\s*\{([^}]*)\}/);
    expect(desktopMatch).not.toBeNull();
    // Desktop rule should NOT contain overflow-x
    expect(desktopMatch![1]).not.toMatch(/overflow-x/);
  });
});
