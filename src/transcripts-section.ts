import {
  addUsage,
  aggregateUsage,
  findTranscripts,
  readSessionUsage,
} from '@astudioplus/compressor';
import type { SessionUsage, UsageTotals } from '@astudioplus/compressor';

// "Actual usage" section for the savings webview, parsed from this project's
// Claude Code session transcripts (~/.claude/projects). This is the CLI
// `compressor stats` view rendered into the panel. Honesty rules: these are
// AUTHORITATIVE token counts (from message.usage), NOT savings and NOT billable
// dollars; they cover Claude Code only (other agents leave no transcript here).

export interface TranscriptUsage {
  sessions: number;
  turns: number;
  totals: UsageTotals;
  byModel: Record<string, UsageTotals>;
  projectDir: string;
  /** human window label, e.g. 'last 30 days' */
  windowLabel: string;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });

/** Fold parsed sessions into the panel's usage shape. Pure; unit-tested. */
export function summarizeSessions(
  sessions: readonly SessionUsage[],
  projectDir: string,
  windowLabel: string,
): TranscriptUsage {
  const byModel: Record<string, UsageTotals> = {};
  for (const session of sessions) {
    for (const [model, usage] of Object.entries(session.byModel)) {
      byModel[model] = addUsage(byModel[model] ?? emptyTotals(), usage);
    }
  }
  return {
    sessions: sessions.length,
    turns: sessions.reduce((acc, s) => acc + s.turns, 0),
    totals: aggregateUsage([...sessions]),
    byModel,
    projectDir,
    windowLabel,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Render the usage section as an HTML fragment to splice into the savings
 * document before </body>. Colors/font are inherited from the host document
 * (theme-variable driven); only table layout is added, scoped to `.transcripts`.
 * Returns '' when there is nothing to show, so the panel stays clean.
 */
export function renderTranscriptSection(usage: TranscriptUsage | undefined): string {
  if (usage === undefined || usage.sessions === 0) {
    return '';
  }
  const t = usage.totals;
  const rows: Array<[string, number]> = [
    ['input', t.input],
    ['output', t.output],
    ['cache creation', t.cacheCreation],
    ['cache read', t.cacheRead],
  ];
  const table = rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="num">${fmt(value)}</td></tr>`)
    .join('');
  const models = Object.entries(usage.byModel)
    .sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output))
    .map(
      ([model, u]) =>
        `<div>${escapeHtml(model)}: input ${fmt(u.input)} · output ${fmt(u.output)} · ` +
        `cache ${fmt(u.cacheCreation + u.cacheRead)}</div>`,
    )
    .join('');
  return `<style>
.transcripts { margin-top: 2rem; }
.transcripts table { border-collapse: collapse; font-size: 0.9rem; margin-top: 0.4rem; }
.transcripts td { padding: 0.1rem 1.4rem 0.1rem 0; }
.transcripts td.num { text-align: right; font-variant-numeric: tabular-nums; }
.transcripts .models { margin-top: 0.7rem; font-size: 0.85rem; }
</style>
<section class="transcripts">
<h2>actual usage (Claude Code transcripts)</h2>
<p class="totals">${fmt(usage.sessions)} sessions · ${fmt(usage.turns)} turns · ${escapeHtml(usage.windowLabel)}</p>
<table>${table}</table>
${models === '' ? '' : `<div class="models">by model:${models}</div>`}
<p class="footer">authoritative token counts from this project's Claude Code session transcripts (~/.claude) — actual usage, <strong>not savings</strong> and not billable dollars. Covers Claude Code only; Copilot/Cursor/OpenCode leave no transcript here.</p>
</section>`;
}

/** fs reader, separated from the pure renderer. Missing transcripts → undefined. */
export async function readTranscriptUsage(
  projectDir: string,
  since: Date | undefined,
  windowLabel: string,
): Promise<TranscriptUsage | undefined> {
  const files = await findTranscripts(since === undefined ? { projectDir } : { projectDir, since });
  if (files.length === 0) {
    return undefined;
  }
  const sessions: SessionUsage[] = [];
  for (const file of files) {
    sessions.push(await readSessionUsage(file));
  }
  return summarizeSessions(sessions, projectDir, windowLabel);
}
