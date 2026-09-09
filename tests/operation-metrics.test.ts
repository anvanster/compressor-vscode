import { afterEach, expect, it } from 'vitest';
import { measureOperation, operationMetricsHtml, resetOperationMetrics } from '../src/operation-metrics';

afterEach(resetOperationMetrics);

it('counts operations without persisting source text', async () => {
  await measureOperation('read', true, async () => ({ text: 'private source' }), (result) => result);
  const html = operationMetricsHtml();
  expect(html).toContain('<td>read</td><td>1</td><td>14</td><td>1</td>');
  expect(html).not.toContain('private source');
  expect(html).toContain('not net session');
});