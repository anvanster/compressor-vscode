import * as vscode from 'vscode';
import os from 'node:os';
import {
  adapters,
  applyChanges,
  getAdapter,
  renderChanges,
  resolveHookCommand,
} from '@astudioplus/compressor';
import type { AdapterContext, AgentName, FileChange } from '@astudioplus/compressor';

// Manage commands: init / set-mode / uninstall via the library's pure-planner
// adapters. Every change set is rendered for review and confirmed before
// applyChanges writes anything.

export type ManageKind = 'init' | 'setMode' | 'uninstall';
export type PickMode = 'optimized' | 'slim';

/**
 * Hook command for the claude-code PostToolUse / copilot postToolUse entries.
 * Only the relocatable (PATH-bin) form is derivable from inside the extension
 * bundle: the absolute form needs the compressor package root, which the
 * library resolves from its own file location — inside the bundle that is the
 * extension's directory, where no compressor package exists (verified: the
 * resolver throws). resolveHookCommand checks that `compressor-hook` actually
 * resolves on PATH, so a returned command is never a dead entry.
 */
export function deriveHookCommand(mode: PickMode): string | undefined {
  try {
    return resolveHookCommand(mode, '', 'relocatable');
  } catch {
    return undefined;
  }
}

/** Adapters whose install() writes ctx.hookCommand into config files. */
const HOOK_AGENTS: ReadonlySet<string> = new Set(['claude-code', 'copilot']);

export const HOOK_UNAVAILABLE_NOTE =
  'claude-code and copilot are not offered: their hook command needs ' +
  '`compressor-hook` on PATH (npm install -g @astudioplus/compressor) — ' +
  'or use the compressor CLI (`compressor init`) in a terminal.';

/**
 * Per-agent effect notes (the library keeps these in its CLI layer, not the
 * package root exports — inlined here, same strings as `compressor init`).
 */
export const AGENT_EFFECT_NOTES: Record<AgentName, string> = {
  'claude-code': 'Claude Code: takes effect on the next session (/clear or new session).',
  copilot: 'Copilot: hook config loads when the CLI starts — restart any running copilot session.',
  cursor: 'Cursor: rules apply to new chats.',
  'agents-md': 'AGENTS.md: read at agent startup.',
  opencode: 'OpenCode: plugins load at startup — restart any running opencode session.',
};

export function effectNote(agents: readonly AgentName[]): string {
  return agents.map((name) => AGENT_EFFECT_NOTES[name]).join(' ');
}

export interface AgentChoices {
  names: AgentName[];
  /** present when hook-bearing agents were excluded */
  note?: string;
}

/**
 * Which agents the quickpick offers. Installs that would write a hook command
 * exclude claude-code/copilot when no PATH-bin command exists (an empty
 * command would be installed verbatim — a dead hook entry). Uninstall keeps
 * them: removal matches the relocatable form without a context command.
 */
export function agentChoices(kind: ManageKind, hookAvailable: boolean): AgentChoices {
  const all = adapters.map((adapter) => adapter.name);
  if (kind === 'uninstall' || hookAvailable) {
    return { names: all };
  }
  return {
    names: all.filter((name) => !HOOK_AGENTS.has(name)),
    note: HOOK_UNAVAILABLE_NOTE,
  };
}

export function modeChoices(kind: ManageKind): string[] {
  if (kind === 'setMode') {
    return ['optimized', 'slim', 'full'];
  }
  return ['optimized', 'slim'];
}

export interface ManagePlan {
  changes: FileChange[];
  rendered: string;
}

/**
 * Plan the change set (adapters are pure planners — nothing is written here).
 * mode 'full' or kind 'uninstall' plans removal of compressor artifacts
 * ('full' = true baseline, mirroring the CLI's set-mode semantics).
 */
export async function planManage(
  kind: ManageKind,
  agentNames: readonly AgentName[],
  mode: PickMode | 'full' | undefined,
  ctx: AdapterContext,
): Promise<ManagePlan> {
  const changes: FileChange[] = [];
  for (const name of agentNames) {
    const adapter = getAdapter(name);
    if (adapter === undefined) {
      throw new Error(`no adapter for agent '${name}'`);
    }
    if (kind === 'uninstall' || mode === 'full' || mode === undefined) {
      changes.push(...(await adapter.uninstall(ctx)));
    } else {
      changes.push(...(await adapter.install(mode, ctx)));
    }
  }
  return { changes, rendered: renderChanges(changes) };
}

/** UI seam: the vscode layer implements this; tests script it. */
export interface ManageUi {
  pickFolder(folders: readonly string[]): Promise<string | undefined>;
  pickAgents(names: readonly AgentName[], note?: string): Promise<AgentName[] | undefined>;
  pickMode(modes: readonly string[]): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  showChanges(rendered: string): void;
  info(message: string): void;
  error(message: string): void;
}

export interface ManageEnv {
  workspaceFolders: readonly string[];
  homeDir: string;
  /** injectable for tests; production = deriveHookCommand */
  hookCommandFor?: (mode: PickMode) => string | undefined;
}

function isPickMode(value: string): value is PickMode {
  return value === 'optimized' || value === 'slim';
}

export async function runManage(kind: ManageKind, env: ManageEnv, ui: ManageUi): Promise<void> {
  try {
    const folders = env.workspaceFolders;
    if (folders.length === 0) {
      ui.error('Compressor: open a workspace folder first.');
      return;
    }
    const projectDir = folders.length === 1 ? folders[0] : await ui.pickFolder(folders);
    if (projectDir === undefined) {
      return; // cancelled
    }

    const hookCommandFor = env.hookCommandFor ?? deriveHookCommand;
    const hookAvailable = hookCommandFor('optimized') !== undefined;
    const choices = agentChoices(kind, hookAvailable);
    const agents = await ui.pickAgents(choices.names, choices.note);
    if (agents === undefined || agents.length === 0) {
      return; // cancelled
    }

    let mode: PickMode | 'full' | undefined;
    if (kind !== 'uninstall') {
      const picked = await ui.pickMode(modeChoices(kind));
      if (picked === undefined) {
        return; // cancelled
      }
      mode = picked === 'full' ? 'full' : isPickMode(picked) ? picked : undefined;
      if (mode === undefined) {
        ui.error(`Compressor: unknown mode '${picked}'`);
        return;
      }
    }

    const ctx: AdapterContext = {
      projectDir,
      homeDir: env.homeDir,
      global: false,
      hookCommand:
        mode !== undefined && mode !== 'full' ? (hookCommandFor(mode) ?? '') : '',
    };

    const plan = await planManage(kind, agents, mode, ctx);
    if (plan.changes.length === 0) {
      ui.info('Compressor: nothing to change.');
      return;
    }
    ui.showChanges(plan.rendered);
    const verb = kind === 'uninstall' || mode === 'full' ? 'Remove' : `Install mode ${mode}`;
    const ok = await ui.confirm(
      `Compressor: ${verb} for ${agents.join(', ')} — apply ${plan.changes.length} file change(s) in ${projectDir}? (See the Compressor output channel for the full diff.)`,
    );
    if (!ok) {
      return;
    }
    await applyChanges(plan.changes);

    if (kind === 'uninstall' || mode === 'full') {
      ui.info(`Compressor: artifacts removed for ${agents.join(', ')}. ${effectNote(agents)}`);
    } else {
      ui.info(`Compressor: mode ${mode} installed for ${agents.join(', ')}. ${effectNote(agents)}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ui.error(`Compressor: ${reason}`);
  }
}

function vscodeUi(channel: vscode.OutputChannel): ManageUi {
  return {
    async pickFolder(folders) {
      return vscode.window.showQuickPick([...folders], {
        placeHolder: 'Workspace folder to manage',
      });
    },
    async pickAgents(names, note) {
      const picked = await vscode.window.showQuickPick([...names], {
        canPickMany: true,
        placeHolder: note === undefined ? 'Agents to manage' : `Agents to manage — ${note}`,
      });
      return picked as AgentName[] | undefined;
    },
    async pickMode(modes) {
      return vscode.window.showQuickPick([...modes], { placeHolder: 'Mode' });
    },
    async confirm(message) {
      const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Apply');
      return answer === 'Apply';
    },
    showChanges(rendered) {
      channel.appendLine('');
      channel.appendLine(rendered);
      channel.show(true);
    },
    info(message) {
      void vscode.window.showInformationMessage(message);
    },
    error(message) {
      void vscode.window.showErrorMessage(message);
    },
  };
}

export function registerManageCommands(channel: vscode.OutputChannel): vscode.Disposable {
  const env = (): ManageEnv => ({
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    homeDir: os.homedir(),
  });
  const ui = vscodeUi(channel);
  return vscode.Disposable.from(
    vscode.commands.registerCommand('compressor.init', () => runManage('init', env(), ui)),
    vscode.commands.registerCommand('compressor.setMode', () => runManage('setMode', env(), ui)),
    vscode.commands.registerCommand('compressor.uninstall', () =>
      runManage('uninstall', env(), ui),
    ),
  );
}
