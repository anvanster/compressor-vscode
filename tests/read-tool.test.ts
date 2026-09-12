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
  it('reads the exact provider symbol range without compression', async () => {
    const outcome = await runReadTool({ path: 'src/service.ts', symbol: 'Service.run' }, deps({
      readFile: async () => 'class Service {\n  run() {\n    return 42;\n  }\n}',
      symbols: async () => [{ name: 'Service', detail: '', start: 1, end: 5, children: [{ name: 'run', detail: '', start: 2, end: 4, children: [] }] }],
    }));
    expect(outcome.isError).toBe(false);
    expect(outcome.compressed).toBe(false);
    expect(outcome.text).toContain('     2→  run() {\n     3→    return 42;\n     4→  }');
    // a symbol range states coverage but must not nudge a follow-up read
    expect(outcome.text).toContain('showing lines 2-4 of 5');
    expect(outcome.text).not.toContain('continue with offset=');
  });

  it('rejects ambiguous symbol names instead of choosing a method silently', async () => {
    const outcome = await runReadTool({ path: 'src/service.ts', symbol: 'run' }, deps({
      symbols: async () => ['First', 'Second'].map((name) => ({ name, detail: '', start: 1, end: 5, children: [{ name: 'run', detail: '', start: 2, end: 4, children: [] }] })),
    }));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('Ambiguous');
  });

  it('compresses repeated logs while preserving recovery coordinates', async () => {
    const ledgerDir = await tempDir('compressor-vscode-readtool-');
    await withLedgerDir(ledgerDir, async () => {
      const outcome = await runReadTool({ path: 'build.log' }, deps({ readFile: async () => Array(200).fill('repeated build progress information').join('\n') }));
      expect(outcome.isError).toBe(false);
      expect(outcome.compressed).toBe(true);
      expect(outcome.text).toContain('[compressor:');
      // first kept line is the first code line; its ORIGINAL number survives
      expect(outcome.text).toContain('offset=2 limit=199');
      expect(outcome.text.length).toBeLessThan(BIG_COMMENTED_TS.length);
      // honesty: comments were stripped, code stayed
      expect(outcome.text).toContain('repeated build progress information');
      expect(outcome.text).not.toContain('comment line 7 —');
    });

    const events = await readLedgerEvents(ledgerDir);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.agent).toBe('vscode');
    expect(event?.tool).toBe('read');
    expect(event?.mode).toBe('optimized');
    expect(event?.transforms).toContain('numbered-dedupe');
    expect(event?.charsOut).toBeLessThan(event?.charsIn ?? 0);
  });

  it('never returns the whole file when the budget cannot fit a recovery marker', async () => {
    const raw = Array.from({ length: 400 }, (_, i) => `line ${i} of plain notes`).join('\n');
    const outcome = await runReadTool({ path: 'notes.txt' }, deps({
      readFile: async () => raw,
      tokenBudget: 1,
      countTokens: async (text) => text.length,
    }));
    expect(outcome.isError).toBe(false);
    expect(outcome.text.length).toBeLessThan(raw.length / 10);
    expect(outcome.text).toContain('[compressor:');
    expect(outcome.text).toContain('offset/limit');
  });

  it('honours a host budget even when the saving is below the worthwhile floor', async () => {
    const raw = Array.from({ length: 120 }, (_, i) => `line ${i} with distinct trailing content`).join('\n');
    const uncapped = await runReadTool({ path: 'notes.txt' }, deps({ readFile: async () => raw }));
    // trim by less than MIN_SAVED_CHARS: the budget must still win
    const tokenBudget = uncapped.text.length - 50;
    const outcome = await runReadTool({ path: 'notes.txt' }, deps({
      readFile: async () => raw,
      tokenBudget,
      countTokens: async (text) => text.length,
    }));
    expect(outcome.text.length).toBeLessThanOrEqual(tokenBudget);
    expect(outcome.compressed).toBe(true);
  });

  it('leaves an exact range and full mode unbudgeted', async () => {
    const raw = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const budget = { tokenBudget: 1, countTokens: async (text: string) => text.length };
    const ranged = await runReadTool({ path: 'notes.txt', offset: 1, limit: 200 }, deps({ readFile: async () => raw, ...budget }));
    const full = await runReadTool({ path: 'notes.txt' }, deps({ readFile: async () => raw, mode: 'full', ...budget }));
    expect(ranged.compressed).toBe(false);
    expect(ranged.text).toContain('line 199');
    expect(full.compressed).toBe(false);
    expect(full.text).toContain('line 199');
  });

  it('a budget-trimmed read names where to resume, and resuming covers the rest', async () => {
    const raw = Array.from({ length: 300 }, (_, i) => `line ${i + 1} of a long plain-text file`).join('\n');
    const budget = { tokenBudget: 900, countTokens: async (text: string) => Math.ceil(text.length / 3.5) };
    const first = await runReadTool({ path: 'notes.txt' }, deps({ readFile: async () => raw, ...budget }));

    const marker = first.text.split('\n').find((line) => line.includes('[compressor:'));
    expect(marker).toBeDefined();
    // without a resume point the model cannot tell what it is missing, and
    // re-reads the file by other means — spending the saving immediately
    const offset = Number(/offset=(\d+)/.exec(marker!)?.[1]);
    expect(Number.isInteger(offset)).toBe(true);

    const numbers = (text: string): number[] =>
      text.split('\n').flatMap((line) => {
        const found = /^\s*(\d+)→/.exec(line);
        return found ? [Number(found[1])] : [];
      });
    const page1 = numbers(first.text);
    expect(page1.at(-1)).toBe(offset - 1); // resume starts exactly after the cut

    const second = await runReadTool({ path: 'notes.txt', offset, limit: 400 }, deps({ readFile: async () => raw }));
    const page2 = numbers(second.text);
    expect(page2[0]).toBe(offset);
    expect([...page1, ...page2]).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it('never lets the resume marker push the output back over budget', async () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
    const tokenBudget = 400;
    const countTokens = async (text: string): Promise<number> => Math.ceil(text.length / 3.5);
    const outcome = await runReadTool({ path: 'notes.txt' }, deps({ readFile: async () => raw, tokenBudget, countTokens }));
    expect(await countTokens(outcome.text)).toBeLessThanOrEqual(tokenBudget);
    expect(outcome.text).toContain('continue with offset=');
  });

  it('tolerates stray whitespace around the path', async () => {
    const outcome = await runReadTool({ path: '  notes.txt  ' }, deps({ readFile: async () => 'hello\n' }));
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('hello');
  });

  it('suggests the corrected path when the workspace folder name was prefixed', async () => {
    // the frequent model miss: "project/src/a.ts" instead of "src/a.ts"
    const outcome = await runReadTool({ path: 'project/src/a.ts' }, deps({
      readFile: async (absPath) => {
        if (absPath === path.join(WS, 'src', 'a.ts')) return 'real contents';
        throw new Error(`ENOENT: no such file or directory, realpath '${absPath}'`);
      },
    }));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('did you mean src/a.ts?');
    // the raw resolved path is noise the model cannot act on
    expect(outcome.text).not.toContain('realpath');
  });

  it('reports a genuinely missing file without inventing a suggestion', async () => {
    const outcome = await runReadTool({ path: 'src/nope.ts' }, deps({
      readFile: async (absPath) => { throw new Error(`ENOENT: no such file or directory, realpath '${absPath}'`); },
    }));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('not found in the workspace');
    expect(outcome.text).not.toContain('did you mean');
  });

  it('keeps a non-ENOENT reason intact', async () => {
    const outcome = await runReadTool({ path: 'assets/icon.png' }, deps({
      readFile: async () => { throw new Error('Binary files are not supported'); },
    }));
    expect(outcome.text).toContain('Binary files are not supported');
  });

  it('returns an exact uncompressed range for offset/limit', async () => {
    const outcome = await runReadTool({ path: 'src/big.ts', offset: 3, limit: 2 }, deps());
    expect(outcome.isError).toBe(false);
    expect(outcome.compressed).toBe(false);
    const lines = BIG_COMMENTED_TS.split('\n');
    // the range itself is byte-exact; a coverage note follows it
    expect(outcome.text).toContain(numberLines([lines[2] ?? '', lines[3] ?? ''], 3));
    expect(outcome.text).toContain(`showing lines 3-4 of ${lines.length}`);
    expect(outcome.text).not.toContain('continue with offset=');
  });

  it('returns a complete structure rather than a truncated prefix when over budget', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `    doWork(${i});`).join('\n');
    const raw = ['class Service {', body, '}'].join('\n');
    const outcome = await runReadTool({ path: 'src/service.ts' }, deps({
      readFile: async () => raw,
      symbols: async () => [{
        name: 'Service', detail: '', start: 1, end: 62,
        children: [{ name: 'run', detail: '(): void', start: 2, end: 61, children: [] }],
      }],
      tokenBudget: 120,
      countTokens: async (text: string) => Math.ceil(text.length / 3.5),
    }));
    // nothing is silently missing: every symbol is listed, so there is none to
    // invent, and no reason to re-read the file by other means
    expect(outcome.text).toContain('COMPLETE list of its declarations');
    expect(outcome.text).toContain('Service.run');
    expect(outcome.text).toContain('offset=2 limit=60');
    expect(outcome.text).not.toContain('partial output');
    expect(outcome.compressed).toBe(true);
  });

  it('falls back to a truncated prefix only when no symbols describe the file', async () => {
    const raw = Array.from({ length: 400 }, (_, i) => `plain log line ${i + 1}`).join('\n');
    const outcome = await runReadTool({ path: 'run.log' }, deps({
      readFile: async () => raw,
      symbols: async () => [],
      tokenBudget: 200,
      countTokens: async (text: string) => Math.ceil(text.length / 3.5),
    }));
    expect(outcome.text).toContain('continue with offset=');
  });

  it('dedents JSON losslessly, keeping values and line numbers exact', async () => {
    const raw = '{\n    "a": 1,\n    "nested": {\n        "b": "  keep  inner  spaces  "\n    }\n}';
    const outcome = await runReadTool({ path: 'data.json' }, deps({ readFile: async () => raw }));
    const content = outcome.text.split('\n').map((line) => line.replace(/^\s*\d+→/, '')).join('\n');
    expect(JSON.parse(content)).toEqual(JSON.parse(raw));
    // a value's own spaces are data and must survive
    expect(content).toContain('"  keep  inner  spaces  "');
    expect(outcome.text).toContain('     4→');
    expect(outcome.text).not.toContain('[compressor:');
  });

  it('never dedents a language where indentation or line starts can be data', async () => {
    const py = 'def f():\n    return 1\n';
    const ts = 'const help = `\n    indented string content\n`;\n';
    for (const [file, raw] of [['a.py', py], ['a.ts', ts]] as const) {
      const outcome = await runReadTool({ path: file }, deps({ readFile: async () => raw }));
      const content = outcome.text.split('\n').map((line) => line.replace(/^\s*\d+→/, '')).join('\n');
      expect(content).toContain('    ');
    }
  });

  it('tells a prefix read that the file continues, and where', async () => {
    const raw = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n');
    const outcome = await runReadTool({ path: 'notes.txt', offset: 1, limit: 60 },
      deps({ readFile: async () => raw }));
    // without this the model describes declarations it never saw
    // leads the result: a model that stops reading partway still sees it
    expect(outcome.text.split('\n')[0]).toBe('[compressor: showing lines 1-60 of 250; continue with offset=61]');
    expect(outcome.text).toContain('60→line 60');
    expect(outcome.text).not.toContain('61→');
  });

  it('says nothing when the range covers the whole file', async () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    const outcome = await runReadTool({ path: 'notes.txt', offset: 1, limit: 500 },
      deps({ readFile: async () => raw }));
    expect(outcome.text).not.toContain('[compressor:');
  });

  it('states coverage for a tail range without offering a pointless continue', async () => {
    const raw = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const outcome = await runReadTool({ path: 'notes.txt', offset: 90, limit: 50 },
      deps({ readFile: async () => raw }));
    expect(outcome.text).toContain('showing lines 90-100 of 100');
    expect(outcome.text).not.toContain('continue with offset=');
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
    expect(outcome.text).toContain('src/gone.ts');
    expect(outcome.text).toContain('not found in the workspace');
    expect(outcome.text.split('\n')).toHaveLength(1); // short, not a stack
  });
});
