import * as vscode from 'vscode';
import { renderSavingsHtml } from '@astudioplus/compressor';
import { windowLabel } from '@astudioplus/compressor';
import { valueSavings } from '@astudioplus/compressor';
import { savingsShare, savingsShareHtml, usageEmptyStateHtml, usageHtml } from '@astudioplus/compressor';
import type { LedgerEvent, ValuationRate } from '@astudioplus/compressor';
import { UNATTRIBUTED } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';
import { normalizeWindow, parseSince } from './ledger-source';
import { readTranscriptUsage, renderTranscriptSection } from './transcripts-section';
import type { TranscriptUsage } from './transcripts-section';
import { operationMetricsHtml } from './operation-metrics';
import { resolveValuationRate, workspaceStorageDir } from './copilot-rates';
import { readCopilotUsage } from './copilot-usage';
import type { CopilotUsage } from './copilot-usage';

/** Gate for the chat debug logs the usage section reads. */
export const DEBUG_LOG_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';

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
  /** priced view; omitted when no rate could be resolved from the catalog */
  rate?: ValuationRate;
  /** provider-reported usage from this workspace's chat debug logs */
  copilot?: CopilotUsage;
  /**
   * Project label of the current workspace. The reduction share compares an
   * estimate against a measurement, so both sides must cover the same work:
   * ledger events are machine-wide while the debug logs are per-workspace, and
   * comparing the two unfiltered would inflate the share.
   */
  projectLabel?: string;
}

/** The usage section: real Copilot numbers, and the comparison they enable. */
function copilotSectionHtml(
  events: readonly LedgerEvent[],
  window: string,
  extras: SavingsExtras,
): string {
  const { copilot } = extras;
  if (copilot === undefined) {
    return '';
  }
  if (copilot.summary.totals.requests === 0) {
    return `<h2>actual Copilot usage</h2>\n${usageEmptyStateHtml(copilot.probe, DEBUG_LOG_SETTING)}`;
  }
  const scoped =
    extras.projectLabel === undefined
      ? []
      : events.filter((event) => event.project === extras.projectLabel);
  const truncated = copilot.truncated
    ? '<p class="footer">Some logs were too large to read within this report\u2019s budget, so the ' +
      'usage totals cover only part of the window.</p>'
    : '';
  return (
    usageHtml(copilot.summary, windowLabel(normalizeWindow(window))) +
    truncated +
    savingsShareHtml(savingsShare(scoped, copilot.summary))
  );
}

/** Pure HTML assembly, separated from the panel wiring for tests. */
export function buildSavingsHtml(
  events: readonly LedgerEvent[],
  dir: string,
  window: string,
  usage?: TranscriptUsage,
  extras: SavingsExtras = {},
): string {
  const valuation = extras.rate === undefined ? undefined : valueSavings(events, extras.rate);
  const base = renderSavingsHtml(events, dir, windowLabel(normalizeWindow(window)), valuation)
    .replace('<h1>compressor savings', '<h1>Tool-output reduction')
    .replace(/<body[^>]*>/, (tag) => `${tag}${steeringNoticeHtml(extras.steeringNotice)}`)
    .replace('</body>', `${copilotSectionHtml(events, window, extras)}<p>Ledger totals are gross estimated tool-output reduction across agents, not net chat-session savings. Additional reads and model turns can offset reductions.</p>${projectLabelNoteHtml(events)}${operationMetricsHtml()}</body>`);
  const section = renderTranscriptSection(usage);
  return section === '' ? base : base.replace('</body>', `${section}\n</body>`);
}

export class SavingsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly source: LedgerSource,
    /** message when steering is installed but older than this build writes */
    private readonly steeringNotice: () => Promise<string | undefined> = async () => undefined,
    /** extension storage path, used to locate this window's Copilot catalog */
    private readonly extensionStoragePath?: string,
    /** label the ledger records for this workspace, for scoping the share */
    private readonly projectLabel: () => string | undefined = () => undefined,
  ) {}

  async show(): Promise<void> {
    const window = normalizeWindow(
      vscode.workspace.getConfiguration('compressor').get('savingsWindow'),
    );
    const [events, usage, rate, copilot] = await Promise.all([
      this.source.read(window),
      this.readUsage(window),
      this.readRate(),
      this.readCopilot(window),
    ]);
    const html = buildSavingsHtml(events, this.source.dir, window, usage, {
      steeringNotice: await this.steeringNotice(),
      rate,
      copilot,
      projectLabel: this.projectLabel(),
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

  /**
   * Credit rate for the priced view. Best-effort: no catalog on disk (Copilot
   * not signed in, a fresh window) means no money figures, never an error.
   */
  private async readRate(): Promise<ValuationRate | undefined> {
    try {
      return await resolveValuationRate(
        workspaceStorageDir(this.extensionStoragePath),
        vscode.workspace.getConfiguration('compressor').get('pricingModel'),
      );
    } catch {
      return undefined;
    }
  }

  /**
   * Provider-reported usage. Opt-in because it reads chat debug logs, which
   * Copilot writes with prompt and response text in them.
   */
  private async readCopilot(window: string): Promise<CopilotUsage | undefined> {
    if (vscode.workspace.getConfiguration('compressor').get('showCopilotUsage') !== true) {
      return undefined;
    }
    try {
      return await readCopilotUsage(
        workspaceStorageDir(this.extensionStoragePath),
        parseSince(window)?.getTime(),
      );
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}