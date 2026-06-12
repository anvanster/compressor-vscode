import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW,
  createLedgerSource,
  normalizeWindow,
  parseSince,
} from '../src/ledger-source';
import { event, tempDir, writeLedgerFixture } from './fixtures';

describe('normalizeWindow', () => {
  it('accepts the enum values', () => {
    expect(normalizeWindow('7d')).toBe('7d');
    expect(normalizeWindow('30d')).toBe('30d');
    expect(normalizeWindow('all')).toBe('all');
  });

  it('falls back to the 30d default for anything unexpected', () => {
    expect(normalizeWindow('yesterday')).toBe(DEFAULT_WINDOW);
    expect(normalizeWindow('')).toBe(DEFAULT_WINDOW);
    expect(normalizeWindow(undefined)).toBe(DEFAULT_WINDOW);
    expect(normalizeWindow(7)).toBe(DEFAULT_WINDOW);
  });
});

describe('parseSince', () => {
  const now = Date.UTC(2026, 5, 12);

  it("maps 'all' to undefined (no cutoff)", () => {
    expect(parseSince('all', now)).toBeUndefined();
  });

  it('maps Nd to a cutoff N days back', () => {
    expect(parseSince('7d', now)?.getTime()).toBe(now - 7 * 86_400_000);
    expect(parseSince('30d', now)?.getTime()).toBe(now - 30 * 86_400_000);
  });
});

describe('createLedgerSource', () => {
  it('reads events through the window and treats a missing dir as empty', async () => {
    const dir = await tempDir('compressor-vscode-ledger-');
    const recent = new Date(Date.now() - 86_400_000).toISOString(); // yesterday
    await writeLedgerFixture(dir, [event('2020-01-01T00:00:00.000Z'), event(recent)]);

    const source = createLedgerSource(dir);
    expect(source.dir).toBe(dir);
    expect(await source.read('all')).toHaveLength(2);
    expect((await source.read('7d')).map((e) => e.ts)).toEqual([recent]);

    const missing = createLedgerSource(`${dir}-does-not-exist`);
    expect(await missing.read('all')).toEqual([]);
  });
});
