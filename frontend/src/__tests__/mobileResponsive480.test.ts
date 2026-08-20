import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Mobile responsive styles (≤480px)', () => {
  const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');

  // Extract the 480px media query block content
  function get480Block(): string {
    const match = css.match(/@media\s*\(\s*max-width:\s*480px\s*\)\s*\{([\s\S]*?)^\}/m);
    expect(match).not.toBeNull();
    return match![1];
  }

  describe('Errors view at ≤480px', () => {
    it('should reduce .error-card padding for mobile', () => {
      const block = get480Block();
      // error-card should have reduced padding (e.g. 0.75rem)
      expect(block).toMatch(/\.error-card\s*\{[^}]*padding:\s*0\.75rem/);
    });

    it('should prevent .error-card horizontal overflow with overflow-wrap', () => {
      const block = get480Block();
      expect(block).toMatch(/\.error-card\s*\{[^}]*overflow-wrap:\s*break-word/);
    });

    it('should stack .error-card-header vertically', () => {
      const block = get480Block();
      expect(block).toMatch(/\.error-card-header\s*\{[^}]*flex-direction:\s*column/);
    });

    it('should wrap .error-card-meta items for narrow viewports', () => {
      const block = get480Block();
      expect(block).toMatch(/\.error-card-meta\s*\{[^}]*flex-wrap:\s*wrap/);
    });

    it('should wrap .error-card-actions for narrow viewports', () => {
      const block = get480Block();
      expect(block).toMatch(/\.error-card-actions\s*\{[^}]*flex-wrap:\s*wrap/);
    });
  });

  describe('Usage view at ≤480px', () => {
    it('should reduce .usage-heading font size for mobile', () => {
      const block = get480Block();
      expect(block).toMatch(/\.usage-heading\s*\{[^}]*font-size:\s*1\.1rem/);
    });

    it('should ensure .usage-chart-section does not overflow', () => {
      const block = get480Block();
      expect(block).toMatch(/\.usage-chart-section\s*\{[^}]*overflow:\s*hidden/);
    });

    it('should ensure .usage-table-wrapper scrolls horizontally', () => {
      const block = get480Block();
      expect(block).toMatch(/\.usage-table-wrapper\s*\{[^}]*overflow-x:\s*auto/);
    });

    it('should reduce .usage-section-title font size', () => {
      const block = get480Block();
      expect(block).toMatch(/\.usage-section-title\s*\{[^}]*font-size:\s*0\.8rem/);
    });

    it('should reduce chart height further at 480px', () => {
      const block = get480Block();
      expect(block).toMatch(/\.usage-chart\s*\{[^}]*height:\s*120px/);
    });
  });

  describe('Modals at ≤480px', () => {
    it('should make .modal near-full-width on mobile', () => {
      const block = get480Block();
      // width should be calc(100vw - 2rem) or similar
      expect(block).toMatch(/\.modal\s*\{[^}]*width:\s*calc\(100vw\s*-\s*2rem\)/);
    });

    it('should set .modal max-width to 100%', () => {
      const block = get480Block();
      expect(block).toMatch(/\.modal\s*\{[^}]*max-width:\s*100%/);
    });

    it('should ensure .modal is scrollable with overflow-y: auto', () => {
      const block = get480Block();
      expect(block).toMatch(/\.modal\s*\{[^}]*overflow-y:\s*auto/);
    });

    it('should reduce .modal padding on mobile', () => {
      const block = get480Block();
      expect(block).toMatch(/\.modal\s*\{[^}]*padding:\s*1rem/);
    });

    it('should ensure modal-wide also gets mobile treatment', () => {
      const block = get480Block();
      expect(block).toMatch(/\.modal-wide\s*\{[^}]*max-width:\s*100%/);
    });
  });
});
