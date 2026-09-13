import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalWorkspacePath, containsPath } from './workspace-file';
import { measureOperation } from '../operation-metrics';
import { fitOutput } from './output-policy';
import type { OutputHints } from './output-policy';
import { cheapEstimator } from '@astudioplus/compressor';
import { recordEvent } from '../ledger';
import type { LedgerEvent } from '@astudioplus/compressor';
import { stripVTControlCharacters } from 'node:util';

const MAX_BYTES = 2_000_000;
const MAX_LOGS = 5;
const TTL = 30 * 60_000;
const logs = new Map<string, { text: string; expires: number; timer: ReturnType<typeof setTimeout> }>();

export interface ExecuteInput {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
}

/** A command that never ran: nothing was captured and no log was retained. */
export interface ExecuteRejected {
  ran: false;
  message: string;
}

/** A command that ran or was stopped; its combined output is under logId. */
export interface ExecuteRan {
  ran: true;
  /** human-readable outcome: 'exit code 0', 'timed out', 'spawn failed: …' */
  status: string;
  /** process exit code; absent when the command was stopped or never exited */
  exitCode?: number;
  logId: string;
}

export type ExecuteOutcome = ExecuteRejected | ExecuteRan;

export interface ExecuteDeps {
  workspaceFolders: readonly string[];
  trusted: boolean;
  signal?: AbortSignal;
}

function pruneLogs(): void {
  for (const [key, value] of logs) {
    if (value.expires < Date.now()) { clearTimeout(value.timer); logs.delete(key); }
  }
}

export function clearCommandLogs(): void {
  for (const log of logs.values()) clearTimeout(log.timer);
  logs.clear();
}

export function summarizeLog(text: string): string {
  text = stripVTControlCharacters(text);
  const lines = text.split('\n');
  const hasTestSummary = lines.some((line) => /^\s*(?:Tests|Test Files|Test Suites)\s+(?:\d+|:)/.test(line));
  if (hasTestSummary) {
    const passing = /^\s*(?:[✓✔√]\s+|PASS\s+)/;
    const retained = lines.map((line, index) => ({ line, index }))
      .filter(({ line }) => !passing.test(line));
    const removed = lines.length - retained.length;
    if (removed > 0) {
      const compact = retained.map(({ line, index }) => `${index + 1}: ${line}`).join('\n') +
        `\n[compressor: ${removed} passing-test rows omitted; retrieve retained log for details]`;
      if (compact.length < text.length && compact.length <= 20_000) return compact;
    }
  }
  if (lines.length <= 80) return text.length <= 20_000 ? text : `${text.slice(0, 10_000)}\n[compressor: middle omitted; retrieve retained log]\n${text.slice(-8_000)}`;
  const selected = new Set<number>();
  for (let index = 0; index < Math.min(10, lines.length); index++) selected.add(index);
  for (let index = Math.max(0, lines.length - 25); index < lines.length; index++) selected.add(index);
  for (let index = 0; index < lines.length && selected.size < 160; index++) {
    if (/error|fail|exception|panic|fatal|warning|assert|expected|actual/i.test(lines[index] ?? '')) {
      for (let nearby = Math.max(0, index - 2); nearby <= Math.min(lines.length - 1, index + 4); nearby++) selected.add(nearby);
    }
  }
  const output = [...selected].sort((left, right) => left - right)
    .map((index) => `${index + 1}: ${lines[index]}`).join('\n');
  const result = output.length < text.length ? output : text;
  return result.length <= 20_000 ? result : `${result.slice(0, 10_000)}\n[compressor: summary shortened; retrieve retained log]\n${result.slice(-8_000)}`;
}

export function retrieveLog(id: string, offset = 1, limit = 100, characterOffset = 0): string {
  pruneLogs();
  const log = logs.get(id);
  if (!log) return 'Log unavailable: expired, evicted, or from a different extension window.';
  if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(characterOffset) || characterOffset < 0) {
    return 'offset must be a positive integer; limit must be between 1 and 500.';
  }
  const lines = log.text.split('\n');
  const body = lines.slice(offset - 1, offset - 1 + limit)
    .map((line, index) => `${offset + index}: ${line}`).join('\n');
  const page = body.slice(characterOffset, characterOffset + 20_000);
  return `${lines.length} retained lines; range ${offset}-${Math.min(lines.length, offset + limit - 1)}\n${page}${characterOffset + page.length < body.length ? `\nPartial range: repeat with the same offset/limit and characterOffset=${characterOffset + page.length}` : ''}`;
}

// `bash -lc '...'` / `sh -c '...'` wrappers hide the real command from any check.
// the -c may be bundled with other flags, as in `bash -lc '...'`
const SHELL_WRAPPER = /^\s*(?:\/usr\/bin\/env\s+)?(?:ba|z|da)?sh\s+(?:-[a-z]+\s+)*-[a-z]*c\s+(['"])([\s\S]*)\1\s*$/;

// A command that only prints a file, with nothing else happening to the output.
// A pipe, redirect or second command means the text is being processed rather
// than read, which is a legitimate use of a shell.
const PAGER = /^(?:cat|head|tail|nl|bat|more|less)\b(?:\s+-{1,2}[\w-]+(?:[= ]\d+)?)*\s+(\S+)$/;
const SED_RANGE = /^sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?\s+(\S+)$/;

/**
 * Split on `;`, a newline, `&&` and `||`, but only outside quotes: a separator
 * inside a quoted argument is data, so `echo "done; cat report.txt"` is one
 * command that prints a string, not two of which the second reads a file. A
 * bare `|` is never a separator here - a segment that still contains one is a
 * pipeline, which the caller skips.
 */
function segments(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '\\' && quote !== "'" && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
    } else if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || char === '\n') {
      parts.push(current);
      current = '';
    } else if ((char === '&' || char === '|') && text[index + 1] === char) {
      parts.push(current);
      current = '';
      index += 1;
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Command output is summarized for diagnostics: a 240-line file read this way
 * comes back as a few dozen sampled lines, which is the wrong shape for a file
 * and silently drops most of it. compressor_read returns the range asked for
 * and states its own coverage, so redirect the obvious cases rather than
 * letting the shell become an uncompressed, lossy read path.
 */
export function pureFileRead(command: string): string | undefined {
  return fileReadSegment(command)?.file;
}

/**
 * The file a part of the command merely prints, and the part that prints it.
 * `whole` distinguishes a command that does nothing else from a compound one
 * whose other parts are real work: refusing both is right (running the rest
 * would leave the read unserved), but only the first can be described as a
 * command that only prints a file.
 */
export function fileReadSegment(
  command: string,
): { file: string; segment: string; whole: boolean } | undefined {
  let text = command.trim();
  const wrapped = SHELL_WRAPPER.exec(text);
  if (wrapped?.[2] !== undefined) text = wrapped[2].trim();
  // A compound command is still a file read if any part of it is one. Observed
  // in the wild: `printf ...; cat package.json; printf ...; sed -n '1,200p'
  // README.md` - two whole files, read raw, between two harmless printfs.
  const parts = segments(text).map((segment) => segment.trim()).filter((segment) => segment !== '');
  for (const part of parts) {
    // piped, redirected or substituted: the text is being processed, which is
    // what a shell is for. `tail -f` is a follow, not a read.
    if (/[|><]|\$\(|`/.test(part) || /\s-{1,2}(?:f\b|-follow\b)/.test(part)) {
      continue;
    }
    // `tail` asks for the END of a file, and compressor_read counts
    // offset/limit from the top with no last-N form, so redirecting `tail -n
    // 50 server.log` would name a tool that cannot answer the question. Only
    // the `tail -n +N` form (start AT line N) is a top-counted read.
    if (/^tail\b/.test(part) && !/\s\+\d+\b/.test(part)) continue;
    const matched = (PAGER.exec(part) ?? SED_RANGE.exec(part))?.[1];
    if (matched === undefined) continue;
    const file = unquote(matched);
    // A quote left inside the filename means the parse is wrong or the shell
    // would expand it away; naming such a path would send the model after a
    // file that cannot exist.
    if (/['"]/.test(file)) continue;
    return { file, segment: part, whole: parts.length === 1 };
  }
  return undefined;
}

function unquote(file: string): string {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(file);
  return quoted?.[2] ?? file;
}

/**
 * The path to name in a redirect, or undefined when compressor_read cannot
 * serve it: it reads inside the open workspace folders and refuses anything
 * else, so rejecting `cat /etc/hosts` in its favour is a dead end that costs
 * the model two turns. A shell-expanded home or variable path (`~/.npmrc`,
 * `$HOME/...`) cannot be resolved here and is not a workspace path either.
 *
 * The two tools resolve relative paths differently — a shell command against
 * its own cwd, compressor_read against the first workspace folder — so the
 * command's own spelling is re-expressed the way compressor_read reads it.
 * Naming it verbatim would send `cat config.json` run in `packages/app` to a
 * compressor_read that looks in the workspace root and misses.
 */
export function compressorReadPath(
  file: string,
  cwd: string,
  folders: readonly string[],
): string | undefined {
  const first = folders[0];
  if (first === undefined || file.startsWith('~') || file.includes('$')) return undefined;
  const candidate = path.isAbsolute(file) ? path.normalize(file) : path.normalize(path.resolve(cwd, file));
  const within = (folder: string): boolean =>
    path.relative(folder, candidate) !== '' && containsPath(folder, candidate);
  if (!folders.some(within)) return undefined;
  return within(first) ? path.relative(first, candidate) : candidate;
}

export async function runExecuteTool(input: ExecuteInput, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const reject = (message: string): ExecuteRejected => ({ ran: false, message });
  if (!deps.trusted) return reject('Execution requires a trusted workspace.');
  if (!input.command?.trim()) return reject('A command is required.');
  const root = deps.workspaceFolders[0];
  if (!root) return reject('Open a workspace before running commands.');
  const matched = fileReadSegment(input.command);
  const readInstead = matched === undefined
    ? undefined
    : compressorReadPath(matched.file, path.resolve(root, input.cwd ?? '.'), deps.workspaceFolders);
  if (readInstead !== undefined && matched !== undefined) {
    // A compound command is refused whole - running the rest would still leave
    // the read unserved - so the message says which part is the problem and
    // that nothing ran, instead of describing the whole command as a read.
    const what = matched.whole
      ? 'That command only prints a file.'
      : `One part of that command only prints a file (\`${matched.segment}\`), so none of it ran.`;
    const next = matched.whole
      ? `Use compressor_read ${readInstead} (add offset/limit for a range)`
      : `Re-run the command without that part, and use compressor_read ${readInstead} for the file`;
    return reject(
      `${what} Command output is summarized for diagnostics, so reading ` +
      `${readInstead} this way returns a sample of it, not the file. ${next} - ` +
      'it returns what you asked for and states its own coverage.',
    );
  }
  if (deps.signal?.aborted) return reject('Command cancelled before execution.');
  const timeout = input.timeoutSeconds ?? 120;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) return reject('timeoutSeconds must be between 1 and 600.');
  const cwd = await canonicalWorkspacePath(path.resolve(root, input.cwd ?? '.'), deps.workspaceFolders);
  const outcome = await new Promise<{ text: string; status: string; exitCode?: number }>((resolve) => {
    const child = spawn(input.command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped: string | undefined;
    let settled = false;
    let killing = false;
    const stop = (reason: string): void => {
      stopped ??= reason;
      // The output-limit path calls stop() per chunk; kill the tree only once.
      if (killing || child.pid === undefined) return;
      killing = true;
      // stop() runs inside stream and timer callbacks, so it must never throw.
      const killShell = (): void => { try { child.kill('SIGKILL'); } catch {} };
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL'); // detached: whole process group
        } else {
          // shell: true starts cmd.exe; killing only that orphans the real
          // work, so ask Windows to terminate the tree beneath it.
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
            .on('error', killShell);
        }
      } catch { killShell(); }
    };
    const accept = (chunk: Buffer): void => {
      const remaining = MAX_BYTES - bytes;
      chunks.push(chunk.subarray(0, Math.max(0, remaining)));
      bytes += Math.min(chunk.length, Math.max(0, remaining));
      if (chunk.length > remaining) stop('output limit reached; log is partial');
    };
    child.stdout.on('data', accept);
    child.stderr.on('data', accept);
    const cancel = (): void => stop('cancelled');
    const timer = setTimeout(() => stop('timed out'), timeout * 1000);
    deps.signal?.addEventListener('abort', cancel, { once: true });
    if (deps.signal?.aborted) cancel();
    const finish = (status: string, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', cancel);
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        status: stopped ?? status,
        // a stopped command's exit code describes the kill, not the command
        exitCode: stopped === undefined ? exitCode : undefined,
      });
    };
    child.on('error', (error) => finish(`spawn failed: ${error.message}`));
    child.on('close', (code, signal) => finish(code === null ? `signal ${signal}` : `exit code ${code}`, code ?? undefined));
  });
  pruneLogs();
  while (logs.size >= MAX_LOGS) {
    const oldest = logs.keys().next().value!;
    clearTimeout(logs.get(oldest)!.timer);
    logs.delete(oldest);
  }
  const id = randomUUID();
  const timer = setTimeout(() => logs.delete(id), TTL);
  timer.unref();
  logs.set(id, { text: outcome.text, expires: Date.now() + TTL, timer });
  return { ran: true, status: outcome.status, exitCode: outcome.exitCode, logId: id };
}

/**
 * Turn a run into what the model sees. All prose lives here: nothing downstream
 * has to parse a status or a log id back out of an English sentence.
 */
export async function finalizeExecution(
  outcome: ExecuteOutcome,
  hints: OutputHints = {},
  record: (event: LedgerEvent) => Promise<void> = recordEvent,
): Promise<{ text: string; notice: string; isError: boolean; raw?: string }> {
  const log = outcome.ran ? logs.get(outcome.logId) : undefined;
  if (!outcome.ran || log === undefined) {
    const message = outcome.ran
      ? `Command ${outcome.status}, but its retained log is no longer available.`
      : outcome.message;
    return { text: message, notice: message, isError: true };
  }
  const logId = outcome.logId;
  const status = `Command ${outcome.status}. stdout/stderr combined.`;
  const summary = summarizeLog(log.text);
  const full = `${status}\nLog ${logId} retained for up to 30 minutes (last ${MAX_LOGS} commands). ` +
    'Use compressor_log with id, offset and limit for exact retained output.\n' +
    `${summary !== stripVTControlCharacters(log.text) ? 'Partial summary; omitted lines remain in the retained log.\n' : ''}${summary}`;
  const bounded = await fitOutput(full, hints, `${status}; retrieve compressor_log id=${logId}`);
  const delivered = bounded || `${status}\nLog ${logId}; budget too small for summary.`;
  const saved = log.text.length - delivered.length;
  const tokensIn = cheapEstimator(log.text);
  const tokensOut = cheapEstimator(delivered);
  const notice = saved > 0
    ? `${status} Output reduced by ${saved.toLocaleString('en-US')} chars (approximately ${tokensIn - tokensOut} tokens); ${log.text.length} captured -> ${delivered.length} returned, including metadata.`
    : `${status} No output reduction: ${log.text.length} captured -> ${delivered.length} returned including metadata. Short output may grow; no savings recorded.`;
  if (saved > 0 && tokensOut < tokensIn) {
    await record({
      ts: new Date().toISOString(), agent: 'vscode', tool: 'bash', mode: 'optimized',
      charsIn: log.text.length, charsOut: delivered.length,
      estTokensIn: tokensIn, estTokensOut: tokensOut,
      transforms: ['command-summary'],
    }).catch(() => {});
  }
  return { text: delivered, notice, isError: outcome.exitCode !== 0, raw: log.text };
}

/**
 * What the Commands channel shows after a run, and whether to reveal it. An
 * agent loop can run many commands in a row, so the panel is taken over only
 * when a command actually failed, and a run never interrupts with a toast.
 */
export function commandReport(
  command: string,
  result: { notice: string; isError: boolean; text: string; raw?: string },
): { body: string; reveal: boolean } {
  return {
    body: [
      `$ ${command}`,
      result.notice,
      'Latest captured output (may be partial after cancellation or limits):',
      stripVTControlCharacters(result.raw ?? result.text),
    ].join('\n'),
    reveal: result.isError,
  };
}

export function registerExecuteTools(onComplete: () => void = () => {}): vscode.Disposable {
  const channel = vscode.window.createOutputChannel('Compressor Commands');
  return vscode.Disposable.from(
    channel,
    vscode.lm.registerTool<ExecuteInput>('compressor_execute', {
      prepareInvocation({ input }) {
        return {
          invocationMessage: `Running ${input.command}`,
          confirmationMessages: { title: 'Run workspace command?', message: `Command: ${input.command}\nWorking directory: ${input.cwd ?? '(first workspace folder)'}\nCommands may modify files or access the network. Output is retained temporarily in memory.` },
        };
      },
      async invoke({ input, tokenizationOptions }, token) {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          const result = await measureOperation('execute', false, async () => {
            const outcome = await runExecuteTool(input, {
              workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
              trusted: vscode.workspace.isTrusted,
              signal: controller.signal,
            });
            return finalizeExecution(outcome, {
              tokenBudget: tokenizationOptions?.tokenBudget,
              countTokens: tokenizationOptions ? (value) => tokenizationOptions.countTokens(value, token) : undefined,
              cancelled: () => token.isCancellationRequested,
            });
          }, (result) => ({ text: result.text, isError: result.isError }));
          const report = commandReport(input.command, result);
          channel.clear();
          channel.appendLine(report.body);
          if (report.reveal) channel.show(true);
          onComplete();
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
        } catch (error) {
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Execution failed: ${String(error)}`)]);
        } finally { subscription.dispose(); }
      },
    }),
    vscode.lm.registerTool<{ id: string; offset?: number; limit?: number; characterOffset?: number }>('compressor_log', {
      async invoke({ input }) {
        const text = await measureOperation('log', false, async () => retrieveLog(input.id, input.offset, input.limit, input.characterOffset), (text) => ({ text }));
        channel.clear();
        channel.appendLine('Log retrieval adds output traffic; it is not a savings event.');
        channel.appendLine(stripVTControlCharacters(text));
        channel.show(true);
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
      },
    }),
    new vscode.Disposable(clearCommandLogs),
  );
}