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
