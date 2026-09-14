process.env.COMPRESSOR_NO_LEDGER = '1'; // never touch the real ledger from tests

import { describe, expect, it } from 'vitest';
import { OMISSION_MARKER } from '@astudioplus/compressor';
import { retargetMarkers, runOutlineTool } from '../src/tools/outline';
import type { ReadToolDeps } from '../src/tools/read';

const WS = '/ws/project';

const BIG_TS = [
  "import { foo } from './foo';",
  "import { bar } from './bar';",
  '',
  'export function compute(a: number, b: number): number {',
  '  const x = a + b;',
  '  const y = x * 2;',
  ...Array.from({ length: 30 }, (_, index) => `  consume(${index});`),
  '  return y;',
  '}',
  '',
  'export class Service {',
  '  run(): void {',
  '    doThing();',
  '    doOther();',
  ...Array.from({ length: 30 }, (_, index) => `    consume(${index});`),
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
  it('does not replace a tiny function with a larger recovery marker', async () => {
    const content = 'export function x() {\n  return 1;\n}';
    const out = await runOutlineTool({ path: 'src/x.ts' }, deps(content));
    expect(out.outlined).toBe(false);
    expect(out.text).toContain('return 1;');
    expect(out.text).not.toContain(OMISSION_MARKER);
  });

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

describe('outline honesty', () => {
  it('reports a missing file without leaking the absolute path', async () => {
    const outcome = await runOutlineTool({ path: 'src/commands.ts' }, {
      workspaceFolders: [WS],
      mode: 'optimized',
      readFile: async (absPath) => { throw new Error(`ENOENT: no such file or directory, realpath '${absPath}'`); },
    });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain('compressor_outline');
    expect(outcome.text).toContain('not found in the workspace');
    expect(outcome.text).not.toContain('realpath');
    expect(outcome.text).not.toContain(WS);
  });

  it('says bodies are omitted, so names are not mistaken for behaviour', async () => {
    const outcome = await runOutlineTool({ path: 'src/a.ts' }, {
      workspaceFolders: [WS],
      mode: 'optimized',
      // big enough that the outline genuinely beats the source; on a tiny file
      // selectOutput correctly returns the source instead
      readFile: async () => Array.from(
        { length: 40 },
        (_, i) => `  run${i}(): void {\n    doSomethingFairlyVerbose(${i});\n  }`,
      ).join('\n'),
      symbols: async () => [{
        name: 'Service', detail: '', column: 0, start: 1, end: 120,
        children: Array.from({ length: 40 }, (_, i) => ({
          name: `run${i}`, detail: '', column: 0, start: i * 3 + 1, end: i * 3 + 3, children: [],
        })),
      }],
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('signatures only, bodies omitted');
    expect(outcome.text).toContain('compressor_read');
    expect(outcome.text).toContain('Service.run0');
  });

  it('never points the model at the built-in read, which the agent cannot use', () => {
    const abs = `${WS}/src/a.ts`;
    const engineMarker =
      `[compressor: lines 5-7 omitted (~26 est tokens) — Read ${abs} with offset=5 and limit=3 to retrieve]`;
    const fixed = retargetMarkers(engineMarker, abs, 'src/a.ts');
    expect(fixed).toContain('compressor_read src/a.ts offset=5 limit=3');
    expect(fixed).not.toContain(`Read ${abs}`);
    // the absolute path leaks the user's home directory into model context
    expect(fixed).not.toContain(abs);
  });

  it('leaves unrelated text alone', () => {
    expect(retargetMarkers('nothing to do here', '/w/a.ts', 'a.ts')).toBe('nothing to do here');
  });
});
