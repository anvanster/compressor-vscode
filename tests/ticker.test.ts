import { describe, expect, it } from 'vitest';
import { formatTicker, formatTokens } from '../src/ticker';

describe('formatTokens', () => {
  it('keeps small counts plain and compacts thousands/millions', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('formatTicker', () => {
  it('renders totals as an approximate token figure with the window', () => {
    const view = formatTicker({ savedTokens: 12_345, savedChars: 50_000, events: 12 }, '30d');
    expect(view.text).toBe('$(archive) ≈12.3k tok saved (30d)');
    expect(view.tooltip).toContain('estimate'); // honesty: tokens are estimates
    expect(view.tooltip).toContain('chars are exact');
    expect(view.tooltip).toContain('last 30 days');
  });

  it('never shows an unqualified token number', () => {
    const view = formatTicker({ savedTokens: 777, savedChars: 3_000, events: 2 }, '7d');
    expect(view.text).toContain('≈');
    expect(view.text).not.toContain('%');
    expect(view.tooltip).not.toContain('%');
  });

  it('explains an empty ledger instead of showing zeros', () => {
    const view = formatTicker({ savedTokens: 0, savedChars: 0, events: 0 }, '30d');
    expect(view.text).toBe('$(archive) compressor: no savings yet');
    expect(view.tooltip).toContain('real agent session');
  });
});
