import { afterEach, expect, it } from 'vitest';
import { clearCommandLogs, retrieveLog, runExecuteTool, summarizeLog, finalizeExecution } from '../src/tools/execute';
import type { LedgerEvent } from '@astudioplus/compressor';

afterEach(clearCommandLogs);

it('omits passing test names containing diagnostic words while keeping totals', () => {
  const rows = Array.from({ length: 107 }, (_, index) => `  ✓ tests/example.test.ts > handles error failure assertion ${index} 1ms`);
  const text = [' RUN v4.1.8', ...rows, ' Test Files 19 passed (19)', ' Tests 107 passed (107)', ' Duration 1.56s'].join('\n');
  const result = summarizeLog(text);
  expect(result).not.toContain('handles error');
  expect(result).toContain('Tests 107 passed');
  expect(result).toContain('Test Files 19 passed');
  expect(result).toContain('107 passing-test rows omitted');
  expect(result.length).toBeLessThan(text.length / 5);
});

it('preserves a failure block surrounded by passing tests', () => {
  const rows = Array.from({ length: 90 }, (_, index) => `  ✓ passing test ${index} 1ms`);
  rows.splice(40, 0, ' FAIL tests/parser.test.ts > rejects invalid input', 'AssertionError: expected true to be false', 'Expected: false', 'Received: true', ' at parser.test.ts:42:7');
  const result = summarizeLog([...rows, ' Tests 1 failed | 90 passed (91)'].join('\n'));
  expect(result).toContain('FAIL tests/parser.test.ts');
  expect(result).toContain('Expected: false');
  expect(result).toContain('Received: true');
  expect(result).toContain('parser.test.ts:42:7');
  expect(result).toContain('Tests 1 failed');
});

it('does not interpret checklist rows as passing tests without a runner summary', () => {
  const text = '✓ error handling requirement\n✓ failure recovery requirement\nDocumentation only';
  expect(summarizeLog(text)).toBe(text);
});

it('records actual reduction for a noisy command including returned metadata', async () => {
  const text = await runExecuteTool({ command: 'node -e "for(let index=0;index<500;index++) console.log(\'PASS repeated test progress\')"' }, { workspaceFolders: [process.cwd()], trusted: true });
  const events: LedgerEvent[] = [];
  const result = await finalizeExecution(text, {}, async (event) => { events.push(event); });
  expect(events).toHaveLength(1);
  expect(events[0]?.charsOut).toBe(result.text.length);
  expect(events[0]?.charsIn).toBe(result.raw?.length);
  expect(result.notice).toContain('Output reduced');
  expect(events[0]?.tool).toBe('bash');
});

it('explains zero savings for short output and does not ledger it', async () => {
  const text = await runExecuteTool({ command: 'node -e "console.log(123)"' }, { workspaceFolders: [process.cwd()], trusted: true });
  const events: LedgerEvent[] = [];
  const result = await finalizeExecution(text, {}, async (event) => { events.push(event); });
  expect(result.notice).toContain('No output reduction');
  expect(events).toEqual([]);
});

it('removes ANSI escapes from command summaries', () => {
  expect(summarizeLog('\u001b[32mPASS\u001b[0m')).toBe('PASS');
});

it('does not claim omitted lines when only ANSI formatting was removed', async () => {
  const result = await runExecuteTool({ command: 'node -e "console.log(String.fromCharCode(27)+\'[32mhello\'+String.fromCharCode(27)+\'[0m\')"' }, { workspaceFolders: [process.cwd()], trusted: true });
  expect(result).toContain('hello');
  expect(result).not.toContain('Partial summary');
});

it('requires workspace trust', async () => {
  expect(await runExecuteTool({ command: 'echo blocked' }, { workspaceFolders: [process.cwd()], trusted: false })).toContain('trusted');
});

it('retains exit status and exact output for recovery', async () => {
  const result = await runExecuteTool({ command: 'node -e "console.log(123); process.exit(2)"' }, { workspaceFolders: [process.cwd()], trusted: true });
  expect(result).toContain('exit code 2');
  const id = /Log ([\w-]+) retained/.exec(result)?.[1];
  expect(id).toBeDefined();
  expect(retrieveLog(id!)).toContain('1: 123');
});

it('keeps failure context in a long log summary', () => {
  const lines = Array.from({ length: 500 }, (_, index) => `PASS test ${index}`);
  lines[200] = 'FAIL important test';
  lines[201] = 'Expected: 42';
  const text = lines.join('\n');
  const output = summarizeLog(text);
  expect(output).toContain('Expected: 42');
  expect(output.length).toBeLessThan(text.length);
});

it('does not start a cancelled command', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await runExecuteTool({ command: 'echo blocked' }, { workspaceFolders: [process.cwd()], trusted: true, signal: controller.signal })).toContain('cancelled');
});

it('bounds a single-line log summary', () => {
  expect(summarizeLog('x'.repeat(100_000)).length).toBeLessThan(20_000);
});

it('stops a timed-out command', async () => {
  const result = await runExecuteTool({ command: 'node -e "setInterval(() => {}, 1000)"', timeoutSeconds: 1 }, { workspaceFolders: [process.cwd()], trusted: true });
  expect(result).toContain('timed out');
});