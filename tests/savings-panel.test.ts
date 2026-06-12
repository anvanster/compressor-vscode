import { describe, expect, it } from 'vitest';
import { buildSavingsHtml } from '../src/savings-panel';
import { event } from './fixtures';

describe('buildSavingsHtml', () => {
  it('produces the self-contained report with charts and honest labels', () => {
    const html = buildSavingsHtml(
      [event('2026-06-10T12:00:00.000Z'), event('2026-06-11T09:00:00.000Z')],
      '/home/user/.compressor/ledger',
      '30d',
    );
    expect(html).toContain('<svg');
    expect(html).toContain('estimated');
    expect(html).toContain('last 30 days'); // totals must state their window
    expect(html).not.toContain('<script'); // static report, scripts stay disabled
  });

  it('renders the empty state without charts', () => {
    const html = buildSavingsHtml([], '/tmp/none', 'all');
    expect(html).toContain('no events in this window');
    expect(html).toContain('all time');
  });
});
