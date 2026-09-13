process.env['COMPRESSOR_NO_LEDGER'] = '';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UNATTRIBUTED, projectLabel, readLedger, settleLedger } from '@astudioplus/compressor';
import { recordEvent, resetProjectResolver, setProjectResolver } from '../src/ledger';
import { buildSavingsHtml, escapeHtml, projectLabelNoteHtml, steeringNoticeHtml } from '../src/savings-panel';
import { formatTicker } from '../src/ticker';
import { event, tempDir } from './fixtures';

afterEach(resetProjectResolver);

/** recordEvent writes through the library, which honours COMPRESSOR_LEDGER_DIR. */
async function withLedgerDir(dir: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env['COMPRESSOR_LEDGER_DIR'];
  const suppressed = process.env['COMPRESSOR_NO_LEDGER'];
  process.env['COMPRESSOR_LEDGER_DIR'] = dir;
  delete process.env['COMPRESSOR_NO_LEDGER'];
  try {
    await run();
    await settleLedger();
  } finally {
    if (previous === undefined) delete process.env['COMPRESSOR_LEDGER_DIR'];
    else process.env['COMPRESSOR_LEDGER_DIR'] = previous;
    if (suppressed !== undefined) process.env['COMPRESSOR_NO_LEDGER'] = suppressed;
  }
}

describe('project attribution', () => {
  it('attaches the label the resolver supplies, and the library reads it back', async () => {
    const dir = await tempDir('compressor-vscode-proj-');
    const label = projectLabel('/w/widget', 'hashed', '0'.repeat(64));
    await withLedgerDir(dir, async () => {
      setProjectResolver(() => label);
      await recordEvent(event('2026-09-10T10:00:00Z', { agent: 'vscode' }));
    });
    const events = await readLedger({ dir });
    expect(events).toHaveLength(1);
    expect(events[0]?.project).toBe(label);
  });

  it('records no label without a workspace, and survives a broken resolver', async () => {
    const dir = await tempDir('compressor-vscode-proj-');
    await withLedgerDir(dir, async () => {
      setProjectResolver(() => undefined);
      await recordEvent(event('2026-09-10T10:00:00Z'));
      setProjectResolver(() => { throw new Error('resolver blew up'); });
      await recordEvent(event('2026-09-10T11:00:00Z'));
    });
    const events = await readLedger({ dir });
    expect(events).toHaveLength(2);
    expect(events.every((entry) => entry.project === undefined)).toBe(true);
  });

  it('writes the label as a plain field, not smuggled into another one', async () => {
    const dir = await tempDir('compressor-vscode-proj-');
    await withLedgerDir(dir, async () => {
      setProjectResolver(() => '#abc123def456');
      await recordEvent(event('2026-09-10T10:00:00Z'));
    });
    const file = (await readdir(dir)).find((name) => name.endsWith('.jsonl'))!;
    const line = JSON.parse((await readFile(path.join(dir, file), 'utf8')).trim());
    expect(line.project).toBe('#abc123def456');
  });

  it('SHARED CONTRACT: the resolved library labels this workspace as expected', () => {
    // guards a future library bump silently changing the algorithm, which would
    // re-label every project already in the ledger
    expect(projectLabel('/home/u/projects/widget', 'hashed', '0'.repeat(64))).toBe('#08fb9afab53d');
    expect(UNATTRIBUTED).toBe('unattributed');
  });
});

describe('report', () => {
  const labelled = [
    { ...event('2026-09-10T10:00:00Z', { agent: 'vscode' as const }), project: '#aaa' },
    event('2026-09-10T11:00:00Z', { agent: 'vscode' as const }),
  ];

  it('lets the library render the by-project chart, and adds the settings note', () => {
    const html = buildSavingsHtml(labelled, '/tmp/ledger', '30d');
    expect(html).toContain('<h2>by project</h2>');
    expect(html).toContain('#aaa');
    expect(html).toContain('compressor.projectLabel');
    // the extension must not render a second copy of the same data
    expect(html).not.toContain('<h2>By project</h2>');
  });

  it('omits both chart and note when nothing is labelled', () => {
    const html = buildSavingsHtml([event('2026-09-10T10:00:00Z')], '/tmp/ledger', '30d');
    expect(html).not.toContain('by project');
    expect(projectLabelNoteHtml([event('2026-09-10T10:00:00Z')])).toBe('');
  });

  it('escapes untrusted display text', () => {
    expect(escapeHtml('<img src=x onerror=1>')).toBe('&lt;img src=x onerror=1&gt;');
    const html = buildSavingsHtml(
      [{ ...event('2026-09-10T10:00:00Z'), project: '<script>' }], '/tmp/ledger', '30d');
    expect(html).not.toContain('<script>');
  });
});

describe('stale steering surfaces (no notification)', () => {
  it('marks the ticker and explains the fix in its tooltip', () => {
    const totals = { savedTokens: 12_345, savedChars: 50_000, events: 12 };
    const clean = formatTicker(totals, '30d');
    const stale = formatTicker(totals, '30d', true);
    expect(clean.text).not.toContain('$(warning)');
    expect(stale.text).toContain('$(warning)');
    expect(stale.text).toContain('12.3k');
    expect(stale.tooltip).toContain('Enable Copilot Steering');
    expect(formatTicker({ savedTokens: 0, savedChars: 0, events: 0 }, '30d', true).text).toContain('$(warning)');
  });

  it('renders a report banner only when steering is behind', () => {
    expect(steeringNoticeHtml(undefined)).toBe('');
    const banner = steeringNoticeHtml('Copilot steering in this workspace is older than this build writes (v1).');
    expect(banner).toContain('⚠');
    expect(banner).toContain('older than this build writes');
  });
});
