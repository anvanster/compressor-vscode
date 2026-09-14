import { expect, it } from 'vitest';
import { readCandidate, numberedText, selectOutput, fitOutput } from '../src/tools/output-policy';
import { formatSymbols } from '../src/tools/symbols';

it('preserves all source text including directives and template literal data', () => {
  const lines = ['// @ts-ignore', 'const value = `', '// literal data', '`;'];
  expect(readCandidate(lines, 'code.ts', 'slim', false)).toBe(numberedText(lines));
});

it('collapses numbered repeated log lines with original retrieval coordinates', () => {
  const lines = Array(100).fill('a repeated diagnostic with useful information');
  const result = readCandidate(lines, 'build.log', 'optimized', false);
  expect(result).toContain('offset=2 limit=99');
  expect(result.length).toBeLessThan(numberedText(lines).length);
});

it('uses the supplied tokenizer to reject token-expanding candidates', async () => {
  expect(await selectOutput('original text', 'short', { countTokens: async (text) => text === 'short' ? 20 : 10 })).toBe('original text');
});

it('includes nested symbols with exact ranges', () => {
  expect(formatSymbols([{ name: 'Service', detail: '', column: 0, declLine: 1, start: 1, end: 20, children: [{ name: 'run', detail: '(value: string)', column: 0, declLine: 3, start: 3, end: 8, children: [] }] }])).toContain('Service.run (value: string) [lines 3-8; offset=3 limit=6]');
});

it('fits complete output including recovery text to a model budget', async () => {
  const result = await fitOutput('a long line\n'.repeat(100), { tokenBudget: 100, countTokens: async (text) => text.length }, 'retrieve original');
  expect(result.length).toBeLessThanOrEqual(100);
  expect(result).toContain('retrieve original');
});