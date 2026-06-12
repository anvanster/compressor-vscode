import { readLedger, resolveLedgerDir } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';

// Thin, injectable wrapper around the compressor ledger reader. The extension
// never reads file contents beyond the ledger JSONL, and this module is the
// only place that touches it.

export const DEFAULT_WINDOW = '30d';

/**
 * Normalize the configured lookback window. The setting is a string enum
 * ('7d' | '30d' | 'all'), but settings.json is user-editable text — anything
 * unexpected falls back to the 30d default rather than silently widening to
 * all-time (which would mislabel the headline).
 */
export function normalizeWindow(value: unknown): string {
  if (value === 'all') {
    return 'all';
  }
  if (typeof value === 'string' && /^\d+d$/.test(value)) {
    return value;
  }
  return DEFAULT_WINDOW;
}

/**
 * Window → cutoff instant: '7d'/'30d' → Date, 'all' → undefined.
 * Mirrors the parse logic of the compressor savings CLI, kept local on
 * purpose (the CLI's variant throws; the extension never should).
 */
export function parseSince(window: string, now: number = Date.now()): Date | undefined {
  if (window === 'all') {
    return undefined;
  }
  const days = /^(\d+)d$/.exec(window)?.[1];
  if (days === undefined) {
    return undefined;
  }
  return new Date(now - Number(days) * 86_400_000);
}

export interface LedgerSource {
  /** resolved ledger directory (COMPRESSOR_LEDGER_DIR or ~/.compressor/ledger) */
  readonly dir: string;
  /** events within the window ('7d' | '30d' | 'all'); missing dir → [] */
  read(window: string): Promise<LedgerEvent[]>;
}

export function createLedgerSource(dir: string = resolveLedgerDir()): LedgerSource {
  return {
    dir,
    read(window: string): Promise<LedgerEvent[]> {
      const since = parseSince(normalizeWindow(window));
      return readLedger(since === undefined ? { dir } : { dir, since });
    },
  };
}
