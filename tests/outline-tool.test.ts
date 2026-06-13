process.env.COMPRESSOR_NO_LEDGER = '1'; // never touch the real ledger from tests

import { describe, expect, it } from 'vitest';
import { OMISSION_MARKER } from '@astudioplus/compressor';
import { runOutlineTool } from '../src/tools/outline';
import type { ReadToolDeps } from '../src/tools/read';

const WS = '/ws/project';

const BIG_TS = [
  "import { foo } from './foo';",
  "import { bar } from './bar';",
  '',
  'export function compute(a: number, b: number): number {',
  '  const x = a + b;',
  '  const y = x * 2;',
  '  return y;',
  '}',
  '',
  'export class Service {',
  '  run(): void {',
  '    doThing();',
  '    doOther();',
  '  }',
  '}',
].join('\n');

function deps(content: string, over: Partial<ReadToolDeps> = {}): ReadToolDeps {
  return {
    workspaceFolders: [WS],
    mode: 'optimized',
    readFile: async () => content,
    ...over,
  };
}

describe('runOutlineTool', () => {
  it('keeps imports and signatures, collapses bodies into recoverable markers', async () => {
    const out = await runOutlineTool({ path: 'src/service.ts' }, deps(BIG_TS));
    expect(out.outlined).toBe(true);
    expect(out.text).toContain('export function compute');
    expect(out.text).toContain('export class Service');
    expect(out.text).toContain(OMISSION_MARKER);
    expect(out.text).not.toContain('return y;'); // body collapsed
    expect(out.text).toMatch(/^ *1→import/m); // line numbers preserved
  });

  it('returns a note (not the file) for unsupported file types', async () => {
    const out = await runOutlineTool({ path: 'notes.md' }, deps('# heading\n\ntext'));
    expect(out.outlined).toBe(false);
    expect(out.text).toContain('use compressor_read');
  });

  it('reports an all-signatures file rather than an empty outline', async () => {
    const out = await runOutlineTool(
      { path: 'types.ts' },
      deps("import { A } from './a';\nexport type B = A;"),
    );
    expect(out.outlined).toBe(false);
    expect(out.text).toContain('already all signatures');
  });

  it('rejects paths outside the workspace', async () => {
    const out = await runOutlineTool({ path: '/etc/passwd' }, deps('x'));
    expect(out.isError).toBe(true);
    expect(out.text).toContain('compressor_outline');
  });

  it('requires a path', async () => {
    expect((await runOutlineTool({ path: '' }, deps('x'))).isError).toBe(true);
  });
});
