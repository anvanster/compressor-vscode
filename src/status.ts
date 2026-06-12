import * as vscode from 'vscode';
import os from 'node:os';
import { adapters } from '@astudioplus/compressor';
import type { AdapterContext } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';

// "Compressor: Status" — per-adapter install status for the first workspace
// folder plus ledger recency, ending with the honesty line. Read-only: the
// adapters' status() methods inspect config files; nothing is written.

export const HONESTY_LINE =
  'VS Code hooks cannot replace tool output (doc-verified 2026-06-12) — ' +
  'hook-side compression is not possible in VS Code; instructions come from ' +
  '.github/copilot-instructions.md / AGENTS.md.';

// hookCommand is used by status() only for ownership MATCHING (exact-command
// and PATH-bin forms); an empty string never matches anything by accident, so
// it is a benign placeholder here. The flip side: absolute-path hook installs
// cannot be claimed from inside this bundle (the library resolves its own
// package root, which does not exist here) — MATCH_NOTE says so.
export const MATCH_NOTE =
  'note: hook detection here matches the relocatable (PATH-bin) command form; ' +
  'absolute-path installs may show as not installed — `compressor status` in a ' +
  'terminal is authoritative.';

/** Coarse relative time: 42s ago, 7m ago, 3h ago, 12d ago. */
export function relativeTime(thenMs: number, nowMs: number = Date.now()): string {
  if (Number.isNaN(thenMs)) {
    return 'at unknown time';
  }
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export interface StatusInput {
  /** first workspace folder, or undefined when no folder is open */
  projectDir: string | undefined;
  homeDir: string;
  source: LedgerSource;
}

/** Pure-ish report assembly (reads config files via adapters), for tests. */
export async function buildStatusReport(input: StatusInput): Promise<string> {
  const lines: string[] = ['compressor status', ''];

  if (input.projectDir === undefined) {
    lines.push('no workspace folder open — adapter status unavailable');
  } else {
    lines.push(`workspace: ${input.projectDir}`, '');
    const ctx: AdapterContext = {
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      global: false,
      hookCommand: '',
    };
    for (const adapter of adapters) {
      try {
        const status = await adapter.status(ctx);
        lines.push(`${adapter.name}: ${status.detail}`);
      } catch (error) {
        lines.push(`${adapter.name}: status unavailable (${String(error)})`);
      }
    }
    lines.push('', MATCH_NOTE);
  }

  lines.push('');
  const events = await input.source.read('all');
  const last = events.at(-1); // readLedger sorts by timestamp
  if (last === undefined) {
    lines.push(`last compression event: none recorded yet (ledger: ${input.source.dir})`);
  } else {
    lines.push(
      `last compression event: ${relativeTime(Date.parse(last.ts))}, agent=${last.agent}`,
    );
  }

  lines.push('', HONESTY_LINE);
  return lines.join('\n');
}

export function registerStatusCommand(source: LedgerSource): vscode.Disposable {
  const channel = vscode.window.createOutputChannel('Compressor');
  const command = vscode.commands.registerCommand('compressor.status', async () => {
    const report = await buildStatusReport({
      projectDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      homeDir: os.homedir(),
      source,
    });
    channel.clear();
    channel.appendLine(report);
    channel.show(true);
  });
  return vscode.Disposable.from(channel, command);
}
