import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { settleLedger } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';
import {
  normalizeMode,
  numberLines,
  resolveWorkspacePath,
  runReadTool,
} from '../src/tools/read';
import type { ReadToolDeps } from '../src/tools/read';
import { tempDir } from './fixtures';

// A TS file big enough that the optimized policy's comment-strip tier runs
// (every other line is a comment): ~19k chars ≈ 5.4k estimated tokens, above
// touch (600) and commentStrip (2000), below truncateBudget (5000) after
// stripping.
const BIG_COMMENTED_TS = Array.from(
  { length: 200 },
  (_, i) =>
    `// comment line ${i} — explains the next statement in unnecessary detail\n` +
    `export const value${i} = ${i};`,
).join('\n');

const WS = path.resolve('/ws/project');

function deps(overrides: Partial<ReadToolDeps> = {}): ReadToolDeps {
  return {
    workspaceFolders: [WS],
    mode: 'optimized',
    readFile: async () => BIG_COMMENTED_TS,
    ...overrides,
  };
}

async function readLedgerEvents(dir: string): Promise<LedgerEvent[]> {
  await settleLedger();
  const events: LedgerEvent[] = [];
  for (const file of await readdir(dir)) {
    const text = await readFile(path.join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        events.push(JSON.parse(line) as LedgerEvent);
      }
    }
  }
  return events;
}

async function withLedgerDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env['COMPRESSOR_LEDGER_DIR'];
  process.env['COMPRESSOR_LEDGER_DIR'] = dir;
  try {
    return await run();
  } finally {
    await settleLedger();
    if (previous === undefined) {
      delete process.env['COMPRESSOR_LEDGER_DIR'];
    } else {
      process.env['COMPRESSOR_LEDGER_DIR'] = previous;
    }
  }
}

describe('normalizeMode', () => {
  it('accepts the three modes and defaults everything else to optimized', () => {
    expect(normalizeMode('full')).toBe('full');
    expect(normalizeMode('slim')).toBe('slim');
    expect(normalizeMode('optimized')).toBe('optimized');
    expect(normalizeMode('turbo')).toBe('optimized');
    expect(normalizeMode(undefined)).toBe('optimized');
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves relative paths against the first folder', () => {
    const resolved = resolveWorkspacePath('src/a.ts', [WS]);
    expect(resolved).toEqual({ absPath: path.join(WS, 'src', 'a.ts') });
  });

  it('accepts absolute paths inside a folder and rejects ones outside', () => {
    expect(resolveWorkspacePath(path.join(WS, 'a.ts'), [WS])).toEqual({
      absPath: path.join(WS, 'a.ts'),
    });
    const outside = resolveWorkspacePath('/etc/passwd', [WS]);
    expect(outside).toHaveProperty('error');
  });

  it('rejects relative traversal escaping the workspace', () => {
    expect(resolveWorkspacePath('../outside.ts', [WS])).toHaveProperty('error');
  });

  it('errors without any workspace folder', () => {
    expect(resolveWorkspacePath('a.ts', [])).toHaveProperty('error');
  });
});

describe('runReadTool', () => {
  it('compresses a big commented file, preserving line numbers and the marker', async () => {
    const ledgerDir = await tempDir('compressor-vscode-readtool-');
    await withLedgerDir(ledgerDir, async () => {
      const outcome = await runReadTool({ path: 'src/big.ts' }, deps());
      expect(outcome.isError).toBe(false);
      expect(outcome.compressed).toBe(true);
      expect(outcome.text).toContain('[compressor:');
      // first kept line is the first code line; its ORIGINAL number survives
      expect(outcome.text).toMatch(/^ {5}2→export const value0 = 0;$/m);
      expect(outcome.text.length).toBeLessThan(BIG_COMMENTED_TS.length);
      // honesty: comments were stripped, code stayed
      expect(outcome.text).toContain('export const value199 = 199;');
      expect(outcome.text).not.toContain('comment line 7 —');
    });

    const events = await readLedgerEvents(ledgerDir);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.agent).toBe('vscode');
    expect(event?.tool).toBe('read');
    expect(event?.mode).toBe('optimized');
    expect(event?.transforms).toContain('comment-strip');
    expect(event?.charsOut).toBeLessThan(event?.charsIn ?? 0);
  });

  it('returns an exact uncompressed range for offset/limit', async () => {
    const outcome = await runReadTool({ path: 'src/big.ts', offset: 3, limit: 2 }, deps());
    expect(outcome.isError).toBe(false);
    expect(outcome.compressed).toBe(false);
    const lines = BIG_COMMENTED_TS.split('\n');
    expect(outcome.text).toBe(numberLines([lines[2] ?? '', lines[3] ?? ''], 3));
    expect(outcome.text).not.toContain('[compressor:');
  });

  it('leaves a small file untouched (numbered, no event)', async () => {
    const ledgerDir = await tempDir('compressor-vscode-readtool-small-');
    await withLedgerDir(ledgerDir, async () => {
      const outcome = await runReadTool(
        { path: 'src/small.ts' },
        deps({ readFile: async () => 'const a = 1;\nconst b = 2;\n' }),
      );
      expect(outcome.compressed).toBe(false);
      expect(outcome.text).toBe('     1→const a = 1;\n     2→const b = 2;');
    });
    expect(await readLedgerEvents(ledgerDir)).toHaveLength(0);
  });

  it('rejects paths outside every workspace folder', async () => {
    const outcome = await runReadTool({ path: '/etc/passwd' }, deps());
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('outside the open workspace');
  });

  it('mode full is a passthrough and records nothing', async () => {
    const ledgerDir = await tempDir('compressor-vscode-readtool-full-');
    await withLedgerDir(ledgerDir, async () => {
      const outcome = await runReadTool({ path: 'src/big.ts' }, deps({ mode: 'full' }));
      expect(outcome.compressed).toBe(false);
      expect(outcome.text).not.toContain('[compressor:');
      expect(outcome.text).toContain('comment line 7 —');
    });
    expect(await readLedgerEvents(ledgerDir)).toHaveLength(0);
  });

  it('reports unreadable files as a short error string, never a throw', async () => {
    const outcome = await runReadTool(
      { path: 'src/gone.ts' },
      deps({
        readFile: async () => {
          throw new Error('ENOENT: no such file');
        },
      }),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('cannot read src/gone.ts');
  });
});
