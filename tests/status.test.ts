import { describe, expect, it } from 'vitest';
import { createLedgerSource } from '../src/ledger-source';
import { HONESTY_LINE, buildStatusReport, relativeTime } from '../src/status';
import { event, tempDir, writeLedgerFixture } from './fixtures';

describe('relativeTime', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0, 0);

  it('renders coarse buckets', () => {
    expect(relativeTime(now - 42_000, now)).toBe('42s ago');
    expect(relativeTime(now - 7 * 60_000, now)).toBe('7m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 12 * 86_400_000, now)).toBe('12d ago');
  });

  it('tolerates an unparseable timestamp', () => {
    expect(relativeTime(Number.NaN, now)).toBe('at unknown time');
  });
});

describe('buildStatusReport', () => {
  it('lists every adapter, ledger recency, and the honesty line', async () => {
    const [ledgerDir, projectDir, homeDir] = await Promise.all([
      tempDir('compressor-vscode-status-ledger-'),
      tempDir('compressor-vscode-status-project-'),
      tempDir('compressor-vscode-status-home-'),
    ]);
    const recent = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await writeLedgerFixture(ledgerDir, [event(recent, { agent: 'claude-code' })]);

    const report = await buildStatusReport({
      projectDir,
      homeDir,
      source: createLedgerSource(ledgerDir),
    });

    expect(report).toContain(`workspace: ${projectDir}`);
    for (const name of ['claude-code', 'copilot', 'cursor', 'agents-md', 'opencode']) {
      expect(report).toContain(`${name}:`);
    }
    expect(report).toContain('last compression event: 3h ago, agent=claude-code');
    expect(report).toContain(HONESTY_LINE);
    expect(report).not.toContain('%'); // no percentage claims anywhere
  });

  it('degrades gracefully with no workspace folder and an empty ledger', async () => {
    const ledgerDir = await tempDir('compressor-vscode-status-empty-');
    const report = await buildStatusReport({
      projectDir: undefined,
      homeDir: await tempDir('compressor-vscode-status-home2-'),
      source: createLedgerSource(ledgerDir),
    });

    expect(report).toContain('no workspace folder open');
    expect(report).toContain('last compression event: none recorded yet');
    expect(report).toContain(HONESTY_LINE);
  });
});
