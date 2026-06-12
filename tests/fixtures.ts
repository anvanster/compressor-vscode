import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendLedger, settleLedger } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';

export function event(ts: string, overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    ts,
    agent: 'claude-code',
    tool: 'read',
    mode: 'optimized',
    charsIn: 1_000,
    charsOut: 400,
    estTokensIn: 250,
    estTokensOut: 100,
    transforms: ['truncate'],
    ...overrides,
  };
}

export function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Write real ledger JSONL through the library's own writer (appendLedger
 * resolves COMPRESSOR_LEDGER_DIR at call time), so fixtures always match the
 * format readLedger accepts.
 */
export async function writeLedgerFixture(
  dir: string,
  events: readonly LedgerEvent[],
): Promise<void> {
  const previous = process.env['COMPRESSOR_LEDGER_DIR'];
  process.env['COMPRESSOR_LEDGER_DIR'] = dir;
  try {
    for (const entry of events) {
      await appendLedger(entry);
    }
    await settleLedger();
  } finally {
    if (previous === undefined) {
      delete process.env['COMPRESSOR_LEDGER_DIR'];
    } else {
      process.env['COMPRESSOR_LEDGER_DIR'] = previous;
    }
  }
}
