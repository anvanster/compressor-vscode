import { afterEach, expect, it } from 'vitest';
import { measureOperation, operationMetricsHtml, resetOperationMetrics } from '../src/operation-metrics';

afterEach(resetOperationMetrics);

/** Cell text only, so the assertions survive a styling change. */
function cells(html: string): string[] {
  return [...html.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((match) => match[1]!);
}

it('counts operations without persisting source text', async () => {
  await measureOperation('read', true, async () => ({ text: 'private source' }), (result) => result);
  const html = operationMetricsHtml();
  // one row: tool, calls, output chars, targeted reads, errors, duration
  expect(cells(html)).toEqual(expect.arrayContaining(['read', '1', '14', '1', '0']));
  expect(html).not.toContain('private source');
  expect(html).toContain('not net session');
});

it('renders nothing until a tool has run in this window', () => {
  // an all-zero table under a heading says less than no table at all
  expect(operationMetricsHtml()).toBe('');
});

it('gives the table cells spacing, so headers do not run together', async () => {
  await measureOperation('read', false, async () => ({ text: 'x' }), (result) => result);
  const html = operationMetricsHtml();
  expect(html).toMatch(/<th[^>]+style="[^"]*padding/);
  expect(html).toMatch(/<td[^>]+style="[^"]*padding/);
});

it('groups large figures so they stay readable', async () => {
  await measureOperation('search', false, async () => ({ text: 'y'.repeat(12_345) }), (result) => result);
  expect(cells(operationMetricsHtml())).toContain('12,345');
});