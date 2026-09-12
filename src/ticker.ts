import * as vscode from 'vscode';
import fs from 'node:fs';
import { savingsTotals, windowLabel } from '@astudioplus/compressor';
import type { SavingsTotals } from '@astudioplus/compressor';
import type { LedgerSource } from './ledger-source';
import { normalizeWindow } from './ledger-source';

// Status-bar savings ticker. Honesty rule: every displayed token number is
// marked '≈' or 'estimated' — chars are exact, token figures come from the
// cheap estimator and are never billable counts. No percentages anywhere.

const REFRESH_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 2_000;

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Compact token count for the status bar: 999 → '999', 12345 → '12.3k'. */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (abs >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return `${Math.round(n)}`;
}

export interface TickerView {
  text: string;
  tooltip: string;
}

const STALE_TOOLTIP =
  '\n\n⚠ Copilot steering is older than this build writes. Run "Compressor: Enable ' +
  'Copilot Steering" to update it; "Compressor: Status" shows which scope is behind.';

/**
 * Pure label assembly, separated from the StatusBarItem wiring for tests.
 * `stale` marks steering that this build would rewrite: it is surfaced here and
 * in the report rather than as a notification, so it never interrupts.
 */
export function formatTicker(
  totals: SavingsTotals,
  window: string,
  stale = false,
): TickerView {
  const warn = stale ? ' $(warning)' : '';
  const staleNote = stale ? STALE_TOOLTIP : '';
  if (totals.events === 0) {
    return {
      text: `$(archive) compressor: no savings yet${warn}`,
      tooltip:
        'Compressor: no compression events recorded yet. The hook records an event ' +
        'every time it shrinks tool output during a real agent session — install it ' +
        'with `compressor init`, use your agent normally, then check back.' + staleNote,
    };
  }
  return {
    text: `$(archive) ≈${formatTokens(totals.savedTokens)} tok reduced (${window})${warn}`,
    tooltip:
      'Compressor: gross estimated tool-output reduction, not net session savings (chars are exact; ' +
      'token figures are estimates). Click for the report.\n' +
      `≈${fmt(totals.savedTokens)} tokens · ${fmt(totals.savedChars)} chars (exact) · ` +
      `${fmt(totals.events)} events · ${windowLabel(window)}` + staleNote,
  };
}

function configuredWindow(): string {
  return normalizeWindow(
    vscode.workspace.getConfiguration('compressor').get('savingsWindow'),
  );
}

/**
 * Refresh strategy: fs.watch on the ledger dir (best-effort — the dir may not
 * exist until the first hook event, so attachment is retried on the interval),
 * a 60s interval fallback, and a refresh on window focus; all debounced 2s.
 */
export class SavingsTicker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: fs.FSWatcher | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly source: LedgerSource,
    /** true when steering on disk is older than this build writes */
    private readonly steeringStale: () => Promise<boolean> = async () => false,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'compressor.showSavings';
  }

  start(): void {
    void this.refresh();
    this.attachWatcher();
    this.interval = setInterval(() => {
      this.attachWatcher(); // the ledger dir may appear after activation
      void this.refresh();
    }, REFRESH_INTERVAL_MS);
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.scheduleRefresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('compressor.savingsWindow')) {
          void this.refresh();
        }
      }),
    );
    this.item.show();
  }

  private attachWatcher(): void {
    if (this.watcher !== undefined) {
      return;
    }
    try {
      const watcher = fs.watch(this.source.dir, () => this.scheduleRefresh());
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) {
          this.watcher = undefined; // re-attached on the next interval tick
        }
      });
      this.watcher = watcher;
    } catch {
      // best-effort: missing dir (no events yet) or unwatchable fs — the
      // 60s interval and focus refresh still keep the ticker current
      this.watcher = undefined;
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce !== undefined) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  async refresh(): Promise<void> {
    const window = configuredWindow();
    try {
      const events = await this.source.read(window);
      if (this.disposed) {
        return;
      }
      let stale = false;
      try {
        stale = await this.steeringStale();
      } catch {
        stale = false; // a steering probe must never blank the ticker
      }
      if (this.disposed) {
        return;
      }
      const view = formatTicker(savingsTotals(events), window, stale);
      this.item.text = view.text;
      this.item.tooltip = view.tooltip;
      this.item.backgroundColor = stale
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
    } catch {
      // a broken ledger must never break the editor; keep the last view
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.interval !== undefined) {
      clearInterval(this.interval);
    }
    if (this.debounce !== undefined) {
      clearTimeout(this.debounce);
    }
    this.watcher?.close();
    this.watcher = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.item.dispose();
  }
}
