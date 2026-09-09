import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalWorkspacePath } from './workspace-file';
import { measureOperation } from '../operation-metrics';
import { fitOutput } from './output-policy';
import type { OutputHints } from './output-policy';
import { appendLedger, cheapEstimator } from '@astudioplus/compressor';
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

export async function runExecuteTool(input: ExecuteInput, deps: ExecuteDeps): Promise<string> {
  if (!deps.trusted) return 'Execution requires a trusted workspace.';
  if (!input.command?.trim()) return 'A command is required.';
  const root = deps.workspaceFolders[0];
  if (!root) return 'Open a workspace before running commands.';
  if (deps.signal?.aborted) return 'Command cancelled before execution.';
  const timeout = input.timeoutSeconds ?? 120;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600) return 'timeoutSeconds must be between 1 and 600.';
  const cwd = await canonicalWorkspacePath(path.resolve(root, input.cwd ?? '.'), deps.workspaceFolders);
  const outcome = await new Promise<{ text: string; status: string }>((resolve) => {
    const child = spawn(input.command, { cwd, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped: string | undefined;
    let settled = false;
    const stop = (reason: string): void => {
      stopped ??= reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
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
    const finish = (status: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', cancel);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), status: stopped ?? status });
    };
    child.on('error', (error) => finish(`spawn failed: ${error.message}`));
    child.on('close', (code, signal) => finish(code === null ? `signal ${signal}` : `exit code ${code}`));
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
  const summary = summarizeLog(outcome.text);
  return `Command ${outcome.status}. stdout/stderr combined.\nLog ${id} retained for up to 30 minutes (last ${MAX_LOGS} commands). Use compressor_log with id, offset and limit for exact retained output.\n${summary !== stripVTControlCharacters(outcome.text) ? 'Partial summary; omitted lines remain in the retained log.\n' : ''}${summary}`;
}

export async function finalizeExecution(
  text: string,
  hints: OutputHints = {},
  record: (event: LedgerEvent) => Promise<void> = appendLedger,
): Promise<{ text: string; notice: string; raw?: string }> {
  const logId = /Log ([\w-]+) retained/.exec(text)?.[1];
  const log = logId === undefined ? undefined : logs.get(logId);
  if (log === undefined) return { text, notice: text };
  const status = text.split('\n')[0] ?? '';
  const bounded = await fitOutput(text, hints, `${status}; retrieve compressor_log id=${logId}`);
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
  return { text: delivered, notice, raw: log.text };
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
            const text = await runExecuteTool(input, {
            workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
            trusted: vscode.workspace.isTrusted,
            signal: controller.signal,
            });
            return finalizeExecution(text, {
            tokenBudget: tokenizationOptions?.tokenBudget,
            countTokens: tokenizationOptions ? (value) => tokenizationOptions.countTokens(value, token) : undefined,
            cancelled: () => token.isCancellationRequested,
            });
          }, (result) => ({ text: result.text, isError: !result.notice.startsWith('Command exit code 0.') }));
          channel.clear();
          channel.appendLine(`$ ${input.command}`);
          channel.appendLine(result.notice);
          channel.appendLine('Latest captured output (may be partial after cancellation or limits):');
          channel.appendLine(stripVTControlCharacters(result.raw ?? result.text));
          channel.show(true);
          void vscode.window.showInformationMessage(`Compressor: ${result.notice}`);
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