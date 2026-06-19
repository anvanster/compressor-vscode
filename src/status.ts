import * as vscode from 'vscode';
import os from 'node:os';
import { adapters } from '@astudioplus/compressor';
import type { AdapterContext } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';
import { STEERING_PRIMARY_RELATIVE_PATH, steeringInstalled } from './steering';

// "Compressor: Status" — per-adapter install status for the first workspace
// folder plus ledger recency, ending with the honesty line. Read-only: the
// adapters' status() methods inspect config files; nothing is written.

export const HONESTY_LINE =
  'VS Code hooks cannot replace tool output (doc-verified 2026-06-12) — ' +
  'hook-side compression in VS Code itself comes only from the #compressorRead ' +
  'tool; instructions come from .github/copilot-instructions.md / AGENTS.md.';

// hookCommand is used by status() only for ownership MATCHING (exact-command
// and PATH-bin forms); an empty string never matches anything by accident, so
// it is a benign placeholder here. Verified with the import.meta.url shim in
// place (0.2.0): the bundled library now resolves a real file URL, but its
// packageRoot() walks up from the BUNDLE's location, where no compressor
// package exists — describeHookCommand('absolute') throws (cleanly, caught by
// the adapter), so absolute-path hook installs still cannot be claimed from
// inside this bundle. MATCH_NOTE stays.
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
    const steering = await steeringInstalled(input.projectDir);
    lines.push(
      `copilot steering (compressor agent + /compressor): ${
        steering
          ? `installed (${STEERING_PRIMARY_RELATIVE_PATH}) — pick the "compressor" ` +
            'agent from the Chat agents dropdown; spot-check Configure Tools shows no built-in read'
          : 'not installed — run "Compressor: Enable Copilot Steering"'
      }`,
    );
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

export function registerStatusCommand(
  source: LedgerSource,
  channel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('compressor.status', async () => {
    const report = await buildStatusReport({
      projectDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      homeDir: os.homedir(),
      source,
    });
    channel.clear();
    channel.appendLine(report);
    channel.show(true);
  });
}
