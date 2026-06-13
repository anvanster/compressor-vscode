import * as vscode from 'vscode';
import { renderSavingsHtml } from '@astudioplus/compressor';
import { windowLabel } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';
import { normalizeWindow, parseSince } from './ledger-source';
import { readTranscriptUsage, renderTranscriptSection } from './transcripts-section';
import type { TranscriptUsage } from './transcripts-section';

// Savings report webview. renderSavingsHtml is self-contained on purpose
// (inline CSS, static SVG, no JS, no requests), so the webview runs with
// scripts disabled and the HTML is used directly. The "actual usage" section
// (Claude Code transcripts) is spliced in before </body> when present.

/** Pure HTML assembly, separated from the panel wiring for tests. */
export function buildSavingsHtml(
  events: readonly LedgerEvent[],
  dir: string,
  window: string,
  usage?: TranscriptUsage,
): string {
  const base = renderSavingsHtml(events, dir, windowLabel(normalizeWindow(window)));
  const section = renderTranscriptSection(usage);
  return section === '' ? base : base.replace('</body>', `${section}\n</body>`);
}

export class SavingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly source: LedgerSource) {}

  async show(): Promise<void> {
    const window = normalizeWindow(
      vscode.workspace.getConfiguration('compressor').get('savingsWindow'),
    );
    const events = await this.source.read(window);
    const usage = await this.readUsage(window);
    const html = buildSavingsHtml(events, this.source.dir, window, usage);
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

  /**
   * Actual-usage section for the first workspace folder. Best-effort: any
   * failure (no folder, unreadable transcripts) just omits the section.
   */
  private async readUsage(window: string): Promise<TranscriptUsage | undefined> {
    const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (projectDir === undefined) {
      return undefined;
    }
    try {
      return await readTranscriptUsage(projectDir, parseSince(window), windowLabel(window));
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}
