import * as vscode from 'vscode';
import { renderSavingsHtml } from '@astudioplus/compressor';
import { windowLabel } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';
import { UNATTRIBUTED } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';
import { normalizeWindow, parseSince } from './ledger-source';
import { readTranscriptUsage, renderTranscriptSection } from './transcripts-section';
import type { TranscriptUsage } from './transcripts-section';
import { operationMetricsHtml } from './operation-metrics';

// Savings report webview. renderSavingsHtml is self-contained on purpose
// (inline CSS, static SVG, no JS, no requests), so the webview runs with
// scripts disabled and the HTML is used directly. The "actual usage" section
// (Claude Code transcripts) is spliced in before </body> when present.

/** Untrusted display text: a clear-text label is a folder name. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}

/**
 * The library renders the 'by project' chart itself; this only explains what
 * the labels mean and how to change them, which is VS Code specific. Omitted
 * when nothing in the window is labelled, so it never appears without a chart.
 */
export function projectLabelNoteHtml(events: readonly LedgerEvent[]): string {
  if (!events.some((event) => event.project !== undefined)) {
    return '';
  }
  return '<p>Project labels beginning <code>#</code> are keyed hashes; the key stays on this ' +
    'machine and is never written to the ledger, so a shared report cannot be traced back to ' +
    'project names. Set <code>compressor.projectLabel</code> to <code>name</code> for clear-text ' +
    `folder names. <code>${UNATTRIBUTED}</code> covers other agents and events recorded before ` +
    'labels existed.</p>';
}

/** Banner for steering that this build would rewrite. */
export function steeringNoticeHtml(notice: string | undefined): string {
  return notice === undefined
    ? ''
    : '<p style="border-left:3px solid var(--vscode-editorWarning-foreground,#b58900);' +
      'padding:0.4rem 0.8rem;margin:0 0 1rem;background:var(--vscode-inputValidation-warningBackground,transparent)">' +
      `⚠ ${escapeHtml(notice)}</p>`;
}

export interface SavingsExtras {
  /** shown as a banner at the top of the report when steering is out of date */
  steeringNotice?: string;
}

/** Pure HTML assembly, separated from the panel wiring for tests. */
export function buildSavingsHtml(
  events: readonly LedgerEvent[],
  dir: string,
  window: string,
  usage?: TranscriptUsage,
  extras: SavingsExtras = {},
): string {
  const base = renderSavingsHtml(events, dir, windowLabel(normalizeWindow(window)))
    .replace('<h1>compressor savings', '<h1>Tool-output reduction')
    .replace(/<body[^>]*>/, (tag) => `${tag}${steeringNoticeHtml(extras.steeringNotice)}`)
    .replace('</body>', `<p>Ledger totals are gross estimated tool-output reduction across agents, not net chat-session savings. Additional reads and model turns can offset reductions.</p>${projectLabelNoteHtml(events)}${operationMetricsHtml()}</body>`);
  const section = renderTranscriptSection(usage);
  return section === '' ? base : base.replace('</body>', `${section}\n</body>`);
}

export class SavingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly source: LedgerSource,
    /** message when steering is installed but older than this build writes */
    private readonly steeringNotice: () => Promise<string | undefined> = async () => undefined,
  ) {}

  async show(): Promise<void> {
    const window = normalizeWindow(
      vscode.workspace.getConfiguration('compressor').get('savingsWindow'),
    );
    const [events, usage] = await Promise.all([
      this.source.read(window),
      this.readUsage(window),
    ]);
    const html = buildSavingsHtml(events, this.source.dir, window, usage, {
      steeringNotice: await this.steeringNotice(),
    });
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
    // Opt-in (off by default): the actual-usage section covers Claude Code
    // transcripts only, which is out of place under Copilot-centric savings.
    if (vscode.workspace.getConfiguration('compressor').get('showActualUsage') !== true) {
      return undefined;
    }
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
