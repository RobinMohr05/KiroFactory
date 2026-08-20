import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('#root layout styles', () => {
  const css = readFileSync(resolve(__dirname, '../style.css'), 'utf-8');

  it('should have display: flex on #root', () => {
    expect(css).toMatch(/#root\s*\{[^}]*display:\s*flex/);
  });

  it('should have flex-direction: column on #root', () => {
    expect(css).toMatch(/#root\s*\{[^}]*flex-direction:\s*column/);
  });

  it('should have height: 100% on #root', () => {
    expect(css).toMatch(/#root\s*\{[^}]*height:\s*100%/);
  });

  it('should have min-height: 0 on #root', () => {
    expect(css).toMatch(/#root\s*\{[^}]*min-height:\s*0/);
  });
});
