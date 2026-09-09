process.env.COMPRESSOR_NO_LEDGER = '1'; // never touch the real ledger from tests

import { describe, expect, it } from 'vitest';
import { OMISSION_MARKER } from '@astudioplus/compressor';
import { buildMatcher, formatMatches, runSearchTool } from '../src/tools/search';
import type { SearchToolDeps, SearchToolInput } from '../src/tools/search';

const WS = '/ws/project';

function deps(files: Record<string, string>, over: Partial<SearchToolDeps> = {}): SearchToolDeps {
  return {
    workspaceFolders: [WS],
    mode: 'optimized',
    findFiles: async () => Object.keys(files),
    readFile: async (p) => {
      const content = files[p];
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    },
    ...over,
  };
}

describe('buildMatcher', () => {
  it('literal, case-insensitive, and regex', () => {
    expect(buildMatcher({ query: 'TODO' } as SearchToolInput)('a TODO here')).toBe(true);
    expect(buildMatcher({ query: 'todo' } as SearchToolInput)('a TODO here')).toBe(false);
    expect(buildMatcher({ query: 'todo', ignoreCase: true } as SearchToolInput)('a TODO here')).toBe(true);
    expect(buildMatcher({ query: 'foo\\d+', isRegex: true } as SearchToolInput)('foo42')).toBe(true);
  });
});

describe('formatMatches', () => {
  it('groups by file with workspace-relative paths and numbered lines', () => {
    const out = formatMatches(
      [
        { absFile: `${WS}/a.ts`, lineNo: 3, text: 'const x = 1;' },
        { absFile: `${WS}/a.ts`, lineNo: 9, text: 'const y = 2;' },
        { absFile: `${WS}/b.ts`, lineNo: 1, text: 'hit' },
      ],
      WS,
    );
    expect(out).toContain('a.ts\n     3→const x = 1;\n     9→const y = 2;');
    expect(out).toContain('b.ts\n     1→hit');
  });
});

describe('runSearchTool', () => {
  it.each([false, true])('merges context windows with original coordinates (regex=%s)', async (isRegex) => {
    const out = await runSearchTool({ query: 'hit', isRegex, contextLines: 1 }, deps({
      [`${WS}/a.ts`]: 'before\nhit-one\nbetween\nhit-two\nafter',
    }));
    expect(out.matches).toBe(2);
    expect(out.text).toContain('1|before\n     2→hit-one\n     3|between\n     4→hit-two\n     5|after');
    expect(out.text.match(/between/g)).toHaveLength(1);
  });

  it('bounds context at file edges and separates disjoint windows', async () => {
    const out = await runSearchTool({ query: 'hit', contextLines: 1 }, deps({
      [`${WS}/a.ts`]: 'hit-first\nnext\nomitted\nprevious\nhit-last',
    }));
    expect(out.text).toContain('1→hit-first\n     2|next\n--\n     4|previous\n     5→hit-last');
    expect(out.text).not.toContain('omitted');
  });

  it('counts only selected matches when context includes another matching line', async () => {
    const files = { [`${WS}/a.ts`]: 'before\nhit-one\nhit-two\nafter' };
    const first = await runSearchTool({ query: 'hit', contextLines: 1, maxResults: 1 }, deps(files));
    expect(first.matches).toBe(1);
    expect(first.text).toContain('skip=1');
    expect(first.text).toContain('3|hit-two');
    const second = await runSearchTool({ query: 'hit', contextLines: 1, maxResults: 1, skip: 1 }, deps(files));
    expect(second.text).toContain('3→hit-two');
  });

  it.each(['files', 'count'] as const)('leaves %s output unchanged with context requested', async (output) => {
    const files = { [`${WS}/a.ts`]: 'before\nhit\nafter' };
    const baseline = await runSearchTool({ query: 'hit', output }, deps(files));
    const context = await runSearchTool({ query: 'hit', output, contextLines: 5 }, deps(files));
    expect(context.text).toBe(baseline.text);
  });

  it.each([-1, 6, 1.5, NaN])('rejects invalid context size %s', async (contextLines) => {
    const out = await runSearchTool({ query: 'hit', contextLines }, deps({}));
    expect(out.isError).toBe(true);
    expect(out.text).toContain('contextLines');
  });

  it.each([0, 1])('continues budgeted whole-match pages without losing or repeating matches (context=%s)', async (contextLines) => {
    const files = {
      [`${WS}/a.ts`]: Array.from({ length: 6 }, (_, index) => `hit-a-${index}`).join('\n'),
      [`${WS}/b.ts`]: Array.from({ length: 6 }, (_, index) => `hit-b-${index}`).join('\n'),
    };
    const delivered: string[] = [];
    let skip = 0;
    for (let page = 0; page < 12; page++) {
      const out = await runSearchTool({ query: 'hit', skip, maxResults: 10, contextLines }, deps(files, {
        tokenBudget: 220, countTokens: async (text) => text.length,
      }));
      expect(out.text.length).toBeLessThanOrEqual(220);
      delivered.push(...[...out.text.matchAll(/→(hit-[ab]-\d+)/g)].map((match) => match[1]!));
      const continuation = /continue with skip=(\d+)/.exec(out.text);
      if (!continuation) break;
      const next = Number(continuation[1]);
      expect(next).toBeGreaterThan(skip);
      expect(next).toBe(delivered.length);
      skip = next;
    }
    expect(delivered).toEqual([...files[`${WS}/a.ts`]!.split('\n'), ...files[`${WS}/b.ts`]!.split('\n')]);
  });

  it('budgets the complete response even below the ordinary savings threshold', async () => {
    const files = { [`${WS}/a.ts`]: 'hit ' + 'detail '.repeat(35) };
    const out = await runSearchTool({ query: 'hit' }, deps(files, {
      tokenBudget: 240, countTokens: async (text) => text.length,
    }));
    expect(out.isError).toBe(false);
    expect(out.text.length).toBeLessThanOrEqual(240);
    expect(out.text).toContain('partial output');
    expect(out.compressed).toBe(true);
  });

  it.each(['files', 'count'] as const)('continues compact %s pages using represented matches', async (output) => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`${WS}/file-${String(index).padStart(2, '0')}.ts`, 'hit']));
    const delivered: string[] = [];
    let skip = 0;
    for (let page = 0; page < 20; page++) {
      const out = await runSearchTool({ query: 'hit', output, skip }, deps(files, {
        tokenBudget: 220, countTokens: async (text) => text.length,
      }));
      expect(out.text.length).toBeLessThanOrEqual(220);
      delivered.push(...[...out.text.matchAll(/^file-\d+\.ts/gm)].map((match) => match[0]));
      const continuation = /continue with skip=(\d+)/.exec(out.text);
      if (!continuation) break;
      const next = Number(continuation[1]);
      expect(next).toBeGreaterThan(skip);
      expect(next).toBe(delivered.length);
      skip = next;
    }
    expect(delivered).toEqual(Object.keys(files).map((file) => file.slice(WS.length + 1)));
  });

  it('does not truncate a matching line or offer a non-advancing continuation', async () => {
    const out = await runSearchTool({ query: 'hit' }, deps({ [`${WS}/a.ts`]: 'hit ' + 'x'.repeat(1000) }, {
      tokenBudget: 240, countTokens: async (text) => text.length,
    }));
    expect(out.text).toContain('no complete match fits');
    expect(out.text).not.toContain('skip=');
    expect(out.text).not.toContain('→');
    expect(out.text.length).toBeLessThanOrEqual(240);
  });

  it.each(['files', 'count'] as const)('budgets complete %s output', async (output) => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`${WS}/file-${index}.ts`, 'hit']));
    const out = await runSearchTool({ query: 'hit', output }, deps(files, {
      tokenBudget: 220, countTokens: async (text) => text.length,
    }));
    expect(out.text.length).toBeLessThanOrEqual(220);
    expect(out.text).toContain('partial output');
    expect(out.matches).toBe(30);
    expect(out.compressed).toBe(true);
  });

  it('does not restore large output when the budget cannot fit a recovery marker', async () => {
    const out = await runSearchTool({ query: 'hit' }, deps({ [`${WS}/a.ts`]: 'hit '.repeat(500) }, {
      tokenBudget: 1, countTokens: async (text) => text.length,
    }));
    expect(out.text).toBe('[compressor: budget too small; narrow include or query]');
  });

  it('preserves full mode despite a small host budget', async () => {
    const files = { [`${WS}/a.ts`]: 'hit '.repeat(100) };
    const baseline = await runSearchTool({ query: 'hit' }, deps(files, { mode: 'full' }));
    const budgeted = await runSearchTool({ query: 'hit' }, deps(files, { mode: 'full', tokenBudget: 1 }));
    expect(budgeted.text).toBe(baseline.text);
    expect(budgeted.compressed).toBe(false);
  });

  it('budgets long no-match responses and marks them shortened', async () => {
    const out = await runSearchTool({ query: 'missing'.repeat(100) }, deps({}, {
      tokenBudget: 220, countTokens: async (text) => text.length,
    }));
    expect(out.isError).toBe(false);
    expect(out.matches).toBe(0);
    expect(out.text.length).toBeLessThanOrEqual(220);
    expect(out.compressed).toBe(true);
  });

  it('scopes discovery to the selected root before applying the file cap', async () => {
    let discoveredRoot: string | undefined;
    const result = await runSearchTool({ query: 'hit', root: 'second' }, deps({ '/ws/second/a.ts': 'hit' }, {
      workspaceFolders: [WS, '/ws/second'],
      findFiles: async (_include, _max, root) => {
        discoveredRoot = root;
        return ['/ws/second/a.ts'];
      },
    }));
    expect(discoveredRoot).toBe('/ws/second');
    expect(result.matches).toBe(1);
    expect(result.text).toContain('a.ts');
  });

  it('rejects ambiguous root names', async () => {
    const result = await runSearchTool({ query: 'hit', root: 'project' }, deps({}, {
      workspaceFolders: ['/first/project', '/second/project'],
    }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain('absolute path');
  });

  it('preserves regex pagination across file boundaries', async () => {
    const result = await runSearchTool({ query: 'hit\\d', isRegex: true, skip: 2, maxResults: 2 }, deps({
      [`${WS}/a.ts`]: 'hit1\nhit2',
      [`${WS}/b.ts`]: 'nothing\nhit3\nhit4',
    }));
    expect(result.matches).toBe(2);
    expect(result.text).toContain('2→hit3');
    expect(result.text).not.toContain('hit1');
  });
  it('returns more than 50 matches in a file and supports continuation', async () => {
    const files = { [`${WS}/a.ts`]: Array(80).fill('hit').join('\n') };
    const complete = await runSearchTool({ query: 'hit' }, deps(files));
    expect(complete.matches).toBe(80);
    const first = await runSearchTool({ query: 'hit', maxResults: 20 }, deps(files));
    expect(first.text).toContain('skip=20');
    const rest = await runSearchTool({ query: 'hit', skip: 20 }, deps(files));
    expect(rest.matches).toBe(60);
  });

  it('supports filename-only results and cancellation', async () => {
    const files = { [`${WS}/a.ts`]: 'hit' };
    const result = await runSearchTool({ query: 'hit', output: 'files' }, deps(files));
    expect(result.text).toContain('a.ts');
    expect(result.text).not.toContain('→');
    expect((await runSearchTool({ query: 'hit' }, deps(files, { cancelled: () => true }))).isError).toBe(true);
  });
  it('finds matches across files and reports a count header', async () => {
    const out = await runSearchTool(
      { query: 'TODO' },
      deps({ [`${WS}/a.ts`]: 'ok\n// TODO fix\nmore', [`${WS}/b.ts`]: 'TODO again\n' }),
    );
    expect(out.isError).toBe(false);
    expect(out.matches).toBe(2);
    expect(out.files).toBe(2);
    expect(out.text).toContain('2 matches in 2 file(s)');
    expect(out.text).toContain('a.ts');
    expect(out.text).toContain('TODO fix');
  });

  it('supports regex and reports no matches plainly', async () => {
    const hit = await runSearchTool(
      { query: 'value\\d+', isRegex: true },
      deps({ [`${WS}/a.ts`]: 'value1\nvalueX\nvalue2' }),
    );
    expect(hit.matches).toBe(2);

    const miss = await runSearchTool({ query: 'zzz' }, deps({ [`${WS}/a.ts`]: 'abc' }));
    expect(miss.text).toContain('no matches for zzz');
    expect(miss.matches).toBe(0);
  });

  it('errors on an empty query, an invalid regex, and no workspace', async () => {
    expect((await runSearchTool({ query: '' }, deps({}))).isError).toBe(true);
    const bad = await runSearchTool({ query: '(', isRegex: true }, deps({ [`${WS}/a.ts`]: 'x' }));
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('invalid regex');
    const noWs = await runSearchTool({ query: 'x' }, deps({}, { workspaceFolders: [] }));
    expect(noWs.isError).toBe(true);
  });

  it('skips binary files (NUL byte) without failing', async () => {
    const out = await runSearchTool(
      { query: 'hit' },
      deps({ [`${WS}/bin`]: 'hit\u0000hit', [`${WS}/a.ts`]: 'hit here' }),
    );
    expect(out.files).toBe(1); // only the text file
  });

  it('compresses an oversized result set with a recoverable marker', async () => {
    const files: Record<string, string> = {};
    for (let f = 0; f < 30; f += 1) {
      const lines: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        lines.push(`const match_${f}_${i} = someVeryLongIdentifierToInflateLineLength_${i};`);
      }
      files[`${WS}/file${f}.ts`] = lines.join('\n');
    }
    const out = await runSearchTool({ query: 'match_', maxResults: 2000 }, deps(files));
    expect(out.compressed).toBe(true);
    expect(out.text).toContain(OMISSION_MARKER);
    expect(out.text).toContain('matches in');
  });
});
