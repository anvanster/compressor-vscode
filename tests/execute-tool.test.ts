import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { clearCommandLogs, commandReport, compressorReadPath, pureFileRead, retrieveLog, runExecuteTool, summarizeLog, finalizeExecution } from '../src/tools/execute';
import type { ExecuteOutcome, ExecuteRan } from '../src/tools/execute';
import type { LedgerEvent } from '@astudioplus/compressor';
import { tempDir } from './fixtures';

afterEach(clearCommandLogs);

const DEPS = { workspaceFolders: [process.cwd()], trusted: true };

/** Narrow to a command that actually ran, failing loudly when it did not. */
function ran(outcome: ExecuteOutcome): ExecuteRan {
  if (!outcome.ran) throw new Error(`command did not run: ${outcome.message}`);
  return outcome;
}

function rejection(outcome: ExecuteOutcome): string {
  if (outcome.ran) throw new Error('command unexpectedly ran');
  return outcome.message;
}

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
  const outcome = await runExecuteTool({ command: 'node -e "for(let index=0;index<500;index++) console.log(\'PASS repeated test progress\')"' }, DEPS);
  const events: LedgerEvent[] = [];
  const result = await finalizeExecution(outcome, {}, async (event) => { events.push(event); });
  expect(events).toHaveLength(1);
  expect(events[0]?.charsOut).toBe(result.text.length);
  expect(events[0]?.charsIn).toBe(result.raw?.length);
  expect(result.notice).toContain('Output reduced');
  expect(events[0]?.tool).toBe('bash');
});

it('explains zero savings for short output and does not ledger it', async () => {
  const outcome = await runExecuteTool({ command: 'node -e "console.log(123)"' }, DEPS);
  const events: LedgerEvent[] = [];
  const result = await finalizeExecution(outcome, {}, async (event) => { events.push(event); });
  expect(result.notice).toContain('No output reduction');
  expect(result.isError).toBe(false);
  expect(events).toEqual([]);
});

it('removes ANSI escapes from command summaries', () => {
  expect(summarizeLog('\u001b[32mPASS\u001b[0m')).toBe('PASS');
});

it('does not claim omitted lines when only ANSI formatting was removed', async () => {
  const outcome = await runExecuteTool({ command: 'node -e "console.log(String.fromCharCode(27)+\'[32mhello\'+String.fromCharCode(27)+\'[0m\')"' }, DEPS);
  const result = await finalizeExecution(ran(outcome));
  expect(result.text).toContain('hello');
  expect(result.text).not.toContain('Partial summary');
});

it('requires workspace trust', async () => {
  const outcome = await runExecuteTool({ command: 'echo blocked' }, { ...DEPS, trusted: false });
  expect(rejection(outcome)).toContain('trusted');
  // a rejected command is an error and carries no log to summarize
  expect((await finalizeExecution(outcome)).isError).toBe(true);
});

it('reports the exit code as data, not as prose to be parsed', async () => {
  const outcome = ran(await runExecuteTool({ command: 'node -e "console.log(123); process.exit(2)"' }, DEPS));
  expect(outcome.status).toBe('exit code 2');
  expect(outcome.exitCode).toBe(2);
  expect(retrieveLog(outcome.logId)).toContain('1: 123');
  expect((await finalizeExecution(outcome)).isError).toBe(true);
});

it('takes over the Commands panel only when a command failed', async () => {
  const ok = await finalizeExecution(ran(await runExecuteTool({ command: 'node -e "console.log(1)"' }, DEPS)));
  const failed = await finalizeExecution(ran(await runExecuteTool({ command: 'node -e "process.exit(3)"' }, DEPS)));
  expect(commandReport('npm test', ok).reveal).toBe(false);
  expect(commandReport('npm test', failed).reveal).toBe(true);
  expect(commandReport('npm test', ok).body).toContain('$ npm test');
  expect(commandReport('npm test', ok).body).toContain(ok.notice);
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
  const outcome = await runExecuteTool({ command: 'echo blocked' }, { ...DEPS, signal: controller.signal });
  expect(rejection(outcome)).toContain('cancelled');
});

it('bounds a single-line log summary', () => {
  expect(summarizeLog('x'.repeat(100_000)).length).toBeLessThan(20_000);
});

it('stops a timed-out command', async () => {
  const outcome = ran(await runExecuteTool({ command: 'node -e "setInterval(() => {}, 1000)"', timeoutSeconds: 1 }, DEPS));
  expect(outcome.status).toBe('timed out');
  // a kill signal is not the command's own exit code
  expect(outcome.exitCode).toBeUndefined();
});

// The POSIX path kills the detached process group. Windows instead shells out
// to taskkill /T, which cannot be exercised here.
it.skipIf(process.platform === 'win32')('kills the whole process tree, not just the shell', async () => {
  const dir = await tempDir('compressor-vscode-tree-');
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = path.join(dir, 'grandchild.js');
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  // `&` runs node as a separate process under the shell: killing only the
  // shell would orphan it and leave it running after the timeout.
  const outcome = ran(await runExecuteTool(
    { command: `node ${JSON.stringify(script)} & wait`, timeoutSeconds: 1 },
    DEPS,
  ));
  expect(outcome.status).toBe('timed out');
  const pid = Number(await readFile(pidFile, 'utf8'));
  expect(Number.isInteger(pid)).toBe(true);
  let gone = false;
  for (let attempt = 0; attempt < 40 && !gone; attempt += 1) {
    try { process.kill(pid, 0); } catch { gone = true; }
    if (!gone) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(gone, `grandchild ${pid} survived the timeout`).toBe(true);
});

it('redirects a command that only prints a file, including inside a shell wrapper', async () => {
  // observed in the wild: the model used the shell as an uncompressed read path,
  // and the log summarizer handed back 45 of the 240 lines it asked for
  const cases = [
    "cat package.json",
    "head -50 src/tools/read.ts",
    "sed -n '1,240p' package.json",
    `bash -lc 'sed -n "1,240p" package.json'`,
    "/usr/bin/env bash -c 'cat README.md'",
    // observed: two whole files read raw, hidden between harmless printfs
    `bash -lc 'printf "== a ==\\n"; cat package.json; printf "== b ==\\n"; sed -n "1,200p" README.md'`,
    'echo start && cat package.json',
  ];
  for (const command of cases) {
    expect(pureFileRead(command), command).toBeDefined();
    expect(rejection(await runExecuteTool({ command }, DEPS))).toContain('compressor_read');
  }
});

it('leaves real shell work alone', async () => {
  // the output is being processed, not merely read: that is what a shell is for
  for (const command of [
    'cat a.txt | grep needle',
    'head -5 log.txt > first.txt',
    'ls -la src',
    'npm test',
    'tail -f server.log && echo done', // a follow, not a read
    'echo "$(cat version.txt)"',
  ]) {
    expect(pureFileRead(command), command).toBeUndefined();
  }
});

it('does not redirect reads compressor_read cannot serve', async () => {
  // last-N reads: compressor_read counts offset/limit from the top of the file
  for (const command of ['tail -n 50 server.log', 'tail -50 server.log', 'tail server.log']) {
    expect(pureFileRead(command), command).toBeUndefined();
  }
  // outside the workspace: compressor_read refuses it, so redirecting there is
  // a dead end rather than a cheaper read
  for (const command of ['cat /etc/hosts', 'cat ~/.npmrc', 'cat $HOME/.npmrc']) {
    const outcome = await runExecuteTool({ command, timeoutSeconds: 10 }, DEPS);
    expect(outcome.ran, command).toBe(true);
  }
});

it('names the redirect the way compressor_read resolves it, not the way the shell did', async () => {
  // compressor_read resolves a relative path against the first workspace
  // folder; the command resolved it against its own cwd
  const outcome = await runExecuteTool({ command: 'cat read.ts', cwd: 'src/tools' }, DEPS);
  const message = rejection(outcome);
  expect(message).toContain(path.join('src', 'tools', 'read.ts'));
  expect(message).not.toMatch(/compressor_read read\.ts\b/);

  const root = process.cwd();
  expect(compressorReadPath('config.json', path.join(root, 'packages/app'), [root]))
    .toBe(path.join('packages', 'app', 'config.json'));
  // an absolute path under a non-first folder cannot be named relative to the
  // first one, so it is named absolutely
  expect(compressorReadPath(path.join('/other/root', 'a.txt'), root, [root, '/other/root']))
    .toBe(path.normalize('/other/root/a.txt'));
  expect(compressorReadPath('/etc/hosts', root, [root])).toBeUndefined();
});

it('does not split a command on a separator inside quotes', async () => {
  // the `;` is inside the string being echoed, so nothing here reads a file
  for (const command of [
    'echo "done; cat report.txt"',
    "echo 'a && cat package.json'",
    'echo "one" && echo "two; head -5 README.md"',
  ]) {
    expect(pureFileRead(command), command).toBeUndefined();
  }
  // an unbalanced quote leaves a filename no tool could open, so it is not named
  expect(pureFileRead('cat "report.txt')).toBeUndefined();
});

it('names the offending part of a compound command, not the whole command', async () => {
  const message = rejection(await runExecuteTool({ command: 'echo start && cat package.json' }, DEPS));
  expect(message).toContain('One part of that command only prints a file');
  expect(message).toContain('cat package.json');
  expect(message).toContain('none of it ran');
  expect(message).toContain('compressor_read package.json');

  const whole = rejection(await runExecuteTool({ command: 'cat package.json' }, DEPS));
  expect(whole).toContain('That command only prints a file');
});

it('names the file it wants read through the proper tool', () => {
  expect(pureFileRead("sed -n '1,240p' package.json")).toBe('package.json');
  expect(pureFileRead('cat src/tools/read.ts')).toBe('src/tools/read.ts');
  expect(pureFileRead('npm test')).toBeUndefined();
});
