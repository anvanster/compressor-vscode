import * as vscode from 'vscode';
import type { Mode } from '@astudioplus/compressor';
import { normalizeMode } from './tools/read';

// Status-bar mode indicator with click-to-toggle. Shows the current
// compressor.mode (the read tool's compression mode) and opens a quickpick to
// change it. Sits just left of the savings ticker (priority 99 vs 100). The
// indicator controls the SETTING that governs #compressorRead — distinct from
// the "Set Mode" manage command, which writes instruction packs into agent
// config files.

export interface ModeView {
  text: string;
  tooltip: string;
}

const MODE_BLURB: Record<Mode, string> = {
  full: 'off (passthrough)',
  optimized: 'strip comments + dedupe repeated lines',
  slim: 'optimized + log filtering',
};

/** Pure label assembly, unit-tested. */
export function formatModeItem(mode: Mode): ModeView {
  return {
    text: `$(fold) compressor: ${mode}`,
    tooltip:
      `Compressor read-tool mode: ${mode} — ${MODE_BLURB[mode]}.\n` +
      'Click to change. Controls how #compressorRead compresses files; ' +
      'omissions always carry a recoverable [compressor:] marker.',
  };
}

export interface ModeOption {
  label: Mode;
  description: string;
}

/** Quickpick rows; the active mode is marked. Pure, unit-tested. */
export function modeOptions(current: Mode): ModeOption[] {
  return (['optimized', 'slim', 'full'] as const).map((mode) => ({
    label: mode,
    description: `${MODE_BLURB[mode]}${mode === current ? ' · current' : ''}`,
  }));
}

function currentMode(): Mode {
  return normalizeMode(vscode.workspace.getConfiguration('compressor').get('mode'));
}

export class ModeStatusItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.item.command = 'compressor.selectMode';
  }

  start(): void {
    this.refresh();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('compressor.mode')) {
          this.refresh();
        }
      }),
    );
    this.item.show();
  }

  refresh(): void {
    const view = formatModeItem(currentMode());
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.item.dispose();
  }
}

export function registerSelectModeCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('compressor.selectMode', async () => {
    const current = currentMode();
    const picked = await vscode.window.showQuickPick(modeOptions(current), {
      placeHolder: 'Compressor read-tool compression mode',
    });
    if (picked === undefined) {
      return; // cancelled
    }
    const target =
      (vscode.workspace.workspaceFolders?.length ?? 0) > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('compressor').update('mode', picked.label, target);
    void vscode.window.showInformationMessage(
      `Compressor: read-tool mode set to ${picked.label}.`,
    );
  });
}
