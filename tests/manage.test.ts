import { mkdtempSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// runManage applies for real via applyWithBackup; redirect its backups to a
// throwaway dir so the suite never writes to the user's ~/.compressor/backups.
process.env.COMPRESSOR_BACKUP_DIR = mkdtempSync(
  path.join(os.tmpdir(), 'compressor-vscode-manage-backups-'),
);
import type { AdapterContext, AgentName } from '@astudioplus/compressor';
import {
  AGENT_EFFECT_NOTES,
  HOOK_UNAVAILABLE_NOTE,
  agentChoices,
  effectNote,
  modeChoices,
  planManage,
  runManage,
} from '../src/manage';
import type { ManageUi } from '../src/manage';
import { tempDir } from './fixtures';

const HOOK_CMD = 'compressor-hook --mode optimized';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function ctxIn(prefix: string): Promise<AdapterContext> {
  const [projectDir, homeDir] = await Promise.all([
    tempDir(`${prefix}project-`),
    tempDir(`${prefix}home-`),
  ]);
  return { projectDir, homeDir, global: false, hookCommand: HOOK_CMD };
}

describe('agentChoices', () => {
  it('offers every adapter when the hook command is available', () => {
    const choices = agentChoices('init', true);
    expect(choices.names).toEqual(['claude-code', 'copilot', 'cursor', 'agents-md', 'opencode']);
    expect(choices.note).toBeUndefined();
  });

  it('excludes hook-bearing agents from installs when compressor-hook is missing', () => {
    const choices = agentChoices('init', false);
    expect(choices.names).toEqual(['cursor', 'agents-md', 'opencode']);
    expect(choices.note).toBe(HOOK_UNAVAILABLE_NOTE);
  });

  it('keeps every agent for uninstall regardless of hook availability', () => {
    expect(agentChoices('uninstall', false).names).toContain('claude-code');
  });
});

describe('modeChoices', () => {
  it('offers full only for set-mode', () => {
    expect(modeChoices('init')).toEqual(['optimized', 'slim']);
    expect(modeChoices('setMode')).toEqual(['optimized', 'slim', 'full']);
  });
});

describe('planManage (pure planning — nothing written)', () => {
  it('plans a cursor install without touching disk', async () => {
    const ctx = await ctxIn('compressor-vscode-manage-cursor-');
    const plan = await planManage('init', ['cursor'], 'optimized', ctx);
    const mdc = path.join(ctx.projectDir, '.cursor', 'rules', 'compressor.mdc');
    expect(plan.changes.some((c) => c.path === mdc && c.after !== null)).toBe(true);
    expect(plan.rendered).toContain(`create ${mdc}`);
    expect(await exists(mdc)).toBe(false); // planner only
  });

  it('plans a claude-code install carrying the hook command', async () => {
    const ctx = await ctxIn('compressor-vscode-manage-cc-');
    const plan = await planManage('init', ['claude-code'], 'optimized', ctx);
    const style = path.join(ctx.projectDir, '.claude', 'output-styles', 'compressor-optimized.md');
    const local = path.join(ctx.projectDir, '.claude', 'settings.local.json');
    expect(plan.changes.some((c) => c.path === style)).toBe(true);
    const localChange = plan.changes.find((c) => c.path === local);
    expect(localChange?.after).toContain(HOOK_CMD);
  });

  it("mode 'full' plans an uninstall (true baseline)", async () => {
    const ctx = await ctxIn('compressor-vscode-manage-full-');
    const installed = await planManage('init', ['cursor'], 'optimized', ctx);
    const { applyChanges } = await import('@astudioplus/compressor');
    await applyChanges(installed.changes);

    const plan = await planManage('setMode', ['cursor'], 'full', ctx);
    const mdc = path.join(ctx.projectDir, '.cursor', 'rules', 'compressor.mdc');
    expect(plan.changes.some((c) => c.path === mdc && c.after === null)).toBe(true);
  });
});

interface ScriptedUi extends ManageUi {
  infos: string[];
  errors: string[];
  shown: string[];
}

function scriptedUi(script: {
  agents?: AgentName[];
  mode?: string;
  confirm?: boolean;
  folder?: string;
}): ScriptedUi {
  const ui: ScriptedUi = {
    infos: [],
    errors: [],
    shown: [],
    async pickFolder(folders) {
      return script.folder ?? folders[0];
    },
    async pickAgents() {
      return script.agents;
    },
    async pickMode() {
      return script.mode;
    },
    async confirm() {
      return script.confirm ?? false;
    },
    showChanges(rendered) {
      ui.shown.push(rendered);
    },
    info(message) {
      ui.infos.push(message);
    },
    error(message) {
      ui.errors.push(message);
    },
  };
  return ui;
}

describe('runManage flow', () => {
  it('init: renders changes, confirms, applies, and reports the effect note', async () => {
    const ctx = await ctxIn('compressor-vscode-flow-init-');
    const ui = scriptedUi({ agents: ['cursor'], mode: 'optimized', confirm: true });
    await runManage(
      'init',
      { workspaceFolders: [ctx.projectDir], homeDir: ctx.homeDir, hookCommandFor: () => HOOK_CMD },
      ui,
    );
    expect(ui.errors).toEqual([]);
    expect(ui.shown.join('\n')).toContain('compressor.mdc');
    const mdc = path.join(ctx.projectDir, '.cursor', 'rules', 'compressor.mdc');
    expect(await exists(mdc)).toBe(true);
    expect(ui.infos.join('\n')).toContain('mode optimized installed for cursor');
    expect(ui.infos.join('\n')).toContain(AGENT_EFFECT_NOTES.cursor);
  });

  it('declining the confirmation writes nothing', async () => {
    const ctx = await ctxIn('compressor-vscode-flow-decline-');
    const ui = scriptedUi({ agents: ['cursor'], mode: 'optimized', confirm: false });
    await runManage(
      'init',
      { workspaceFolders: [ctx.projectDir], homeDir: ctx.homeDir, hookCommandFor: () => HOOK_CMD },
      ui,
    );
    expect(await exists(path.join(ctx.projectDir, '.cursor'))).toBe(false);
    expect(ui.infos).toEqual([]);
  });

  it('uninstall removes what init installed', async () => {
    const ctx = await ctxIn('compressor-vscode-flow-uninstall-');
    const env = {
      workspaceFolders: [ctx.projectDir],
      homeDir: ctx.homeDir,
      hookCommandFor: () => HOOK_CMD,
    };
    await runManage('init', env, scriptedUi({ agents: ['cursor'], mode: 'slim', confirm: true }));
    const ui = scriptedUi({ agents: ['cursor'], confirm: true });
    await runManage('uninstall', env, ui);
    expect(await exists(path.join(ctx.projectDir, '.cursor', 'rules', 'compressor.mdc'))).toBe(
      false,
    );
    expect(ui.infos.join('\n')).toContain('artifacts removed for cursor');
  });

  it('errors cleanly without a workspace folder', async () => {
    const ui = scriptedUi({});
    await runManage('init', { workspaceFolders: [], homeDir: '/tmp' }, ui);
    expect(ui.errors.join('\n')).toContain('open a workspace folder');
  });

  it('reports nothing-to-change for an uninstall on a clean project', async () => {
    const ctx = await ctxIn('compressor-vscode-flow-clean-');
    const ui = scriptedUi({ agents: ['cursor'], confirm: true });
    await runManage(
      'uninstall',
      { workspaceFolders: [ctx.projectDir], homeDir: ctx.homeDir, hookCommandFor: () => HOOK_CMD },
      ui,
    );
    expect(ui.infos.join('\n')).toContain('nothing to change');
  });
});

describe('effectNote', () => {
  it('joins the per-agent honesty notes (restart semantics)', () => {
    const note = effectNote(['claude-code', 'copilot']);
    expect(note).toContain('next session');
    expect(note).toContain('restart any running copilot session');
  });
});
