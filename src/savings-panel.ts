import * as vscode from 'vscode';
import { renderSavingsHtml } from '@astudioplus/compressor';
import { windowLabel } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';
import { normalizeWindow } from './ledger-source';

// Savings report webview. renderSavingsHtml is self-contained on purpose
// (inline CSS, static SVG, no JS, no requests), so the webview runs with
// scripts disabled and the HTML is used directly.

/** Pure HTML assembly, separated from the panel wiring for tests. */
export function buildSavingsHtml(
  events: readonly LedgerEvent[],
  dir: string,
  window: string,
): string {
  return renderSavingsHtml(events, dir, windowLabel(normalizeWindow(window)));
}

export class SavingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly source: LedgerSource) {}

  async show(): Promise<void> {
    const window = normalizeWindow(
      vscode.workspace.getConfiguration('compressor').get('savingsWindow'),
    );
    const events = await this.source.read(window);
    const html = buildSavingsHtml(events, this.source.dir, window);
    if (this.panel === undefined) {
      this.panel = vscode.window.createWebviewPanel(
        'compressorSavings',
        'Compressor Savings',
        vscode.ViewColumn.One,
        { enableScripts: false }, // static report; never executes anything
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    } else {
      this.panel.reveal();
    }
    this.panel.webview.html = html;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
