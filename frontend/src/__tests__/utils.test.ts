import { describe, it, expect } from 'vitest';
import { truncateUrl, formatErrorTime, PRIORITY_COLORS, ORIGIN_ICONS, TYPE_CLASSES } from '../utils/api';

describe('truncateUrl', () => {
  it('extracts GitHub path from URL', () => {
    expect(truncateUrl('https://github.com/RobinMohr05/KiroFactory')).toBe('RobinMohr05/KiroFactory');
  });

  it('strips .git suffix', () => {
    expect(truncateUrl('https://github.com/org/repo.git')).toBe('org/repo');
  });

  it('truncates long non-GitHub URLs', () => {
    const longUrl = 'not-a-url-' + 'a'.repeat(60);
    expect(truncateUrl(longUrl).length).toBeLessThanOrEqual(51); // 50 + ellipsis
  });

  it('returns short URLs as-is for non-parseable strings', () => {
    expect(truncateUrl('short')).toBe('short');
  });
});

describe('formatErrorTime', () => {
  it('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatErrorTime(now)).toBe('just now');
  });

  it('returns minutes ago for timestamps within an hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatErrorTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours ago for timestamps within a day', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    expect(formatErrorTime(twoHoursAgo)).toBe('2h ago');
  });

  it('handles invalid date strings gracefully', () => {
    // For NaN dates, the function still returns a string (either 'Invalid Date' from toLocaleDateString
    // or the input string from the catch block)
    const result = formatErrorTime('not-a-date');
    expect(typeof result).toBe('string');
  });
});

describe('constants', () => {
  it('has priority colors for 1-4', () => {
    expect(PRIORITY_COLORS[1]).toBe('#D22630');
    expect(PRIORITY_COLORS[2]).toBe('#FF8700');
    expect(PRIORITY_COLORS[3]).toBe('#007A87');
    expect(PRIORITY_COLORS[4]).toBe('#9CA3AF');
  });

  it('has origin icons', () => {
    expect(ORIGIN_ICONS['user']).toBe('\u{1F464}');
    expect(ORIGIN_ICONS['ai']).toBe('\u{1F916}');
    expect(ORIGIN_ICONS['user-assisted']).toBe('\u{1F91D}');
  });

  it('has type classes', () => {
    expect(TYPE_CLASSES['improvement']).toBe('badge-improvement');
    expect(TYPE_CLASSES['bug']).toBe('badge-bug');
    expect(TYPE_CLASSES['feature']).toBe('badge-feature');
  });
});
