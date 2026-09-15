process.env.COMPRESSOR_NO_LEDGER = '1'; // never touch the real ledger from tests

import { describe, expect, it } from 'vitest';
import { OMISSION_MARKER, cheapEstimator } from '@astudioplus/compressor';
import { SymbolKind } from 'vscode';
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
        name: 'Service', detail: '', kind: SymbolKind.Class, column: 0, declLine: 1, start: 1, end: 120,
        children: Array.from({ length: 40 }, (_, i) => ({
          name: `run${i}`, detail: '', kind: SymbolKind.Method, column: 0, declLine: i * 3 + 1, start: i * 3 + 1, end: i * 3 + 3, children: [],
        })),
      }],
    });
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toContain('signatures only, bodies omitted');
    expect(outcome.text).toContain('compressor_read');
    expect(outcome.text).toContain('Service.run0');
  });

  // The tool description and the steering both tie their claim about `*` to
  // this sentence, because a language with no visibility rule gets neither.
  // An outline that marked nothing while the steering said "unmarked means
  // internal" would report that such a file has no public API at all.
  it('says nothing about visibility for a language it has no rule for', async () => {
    const outcome = await runOutlineTool({ path: 'lib/thing.rb' }, {
      workspaceFolders: [WS],
      mode: 'optimized',
      readFile: async () => Array.from(
        { length: 40 },
        (_, i) => `  def run_${i}\n    do_something_fairly_verbose(${i})\n  end`,
      ).join('\n'),
      symbols: async () => [{
        name: 'Thing', detail: '', kind: SymbolKind.Class, column: 0, declLine: 1, start: 1, end: 120,
        children: Array.from({ length: 40 }, (_, i) => ({
          name: `run_${i}`, detail: '', kind: SymbolKind.Method,
          column: 0, declLine: i * 3 + 1, start: i * 3 + 1, end: i * 3 + 3, children: [],
        })),
      }],
    });
    expect(outcome.text).toContain('Thing.run_0');
    expect(outcome.text).not.toContain('visible outside this file');
    expect(outcome.text).not.toMatch(/^\*/m);
  });

  // The legend is spliced into the preamble before the cap runs. A file whose
  // exports all sit below the cut shipped "unmarked names are internal to it"
  // above a listing with no marks at all, which reads as "this file exports
  // nothing" — the inverse of the preamble contract.
  it('drops the legend when the budget cut away every mark it explains', async () => {
    const COUNT = 120;
    const internals = Array.from({ length: COUNT }, (_, i) => `function internalHelperNumber${i}() {}`);
    const source = [...internals, 'export function shownAtTheEnd() {}'].join('\n');
    const outcome = await runOutlineTool({ path: 'src/late.ts' }, deps(source, {
      symbols: async () => [
        ...internals.map((_, i) => ({
          name: `internalHelperNumber${i}`, detail: '(): void', kind: SymbolKind.Function,
          column: 9, declLine: i + 1, start: i + 1, end: i + 1, children: [],
        })),
        {
          name: 'shownAtTheEnd', detail: '(): void', kind: SymbolKind.Function,
          column: 16, declLine: COUNT + 1, start: COUNT + 1, end: COUNT + 1, children: [],
        },
      ],
      tokenBudget: 200,
      countTokens: async (text: string) => Math.ceil(text.length / 4),
    }));
    expect(outcome.text).not.toMatch(/^\*/m);
    expect(outcome.text).not.toContain('visible outside this file');
    // the caller still has to be told the listing is partial
    expect(outcome.text).toContain('[compressor:');
  });

  // The source fallback is the file's own bytes, and a model copying an
  // `old_string` out of it has to match what is on disk. Rewriting the
  // returned text to drop a legend sentence edited the file's content when the
  // file happened to quote that sentence.
  it('returns the source fallback byte for byte, legend sentence and all', async () => {
    const legend =
      '* = visible outside this file or its class; unmarked names are internal to it, so do not list them as its API. ';
    const source = [
      'const LEGEND =',
      `  '${legend}';`,
      'export function explain(): string { return LEGEND; }',
    ].join('\n');
    const outcome = await runOutlineTool({ path: 'src/legend.ts' }, deps(source, {
      // a listing larger than the file, so selectOutput returns the source
      symbols: async () => Array.from({ length: 60 }, (_, i) => ({
        name: `symbolNumber${i}`, detail: `(argument: SomeFairlyLongTypeName${i}) => void`,
        kind: SymbolKind.Function, column: 0, declLine: 1, start: 1, end: 1, children: [],
      })),
    }));
    const returned = outcome.text.split('\n').map((line) => line.replace(/^\s*\d+→/, '')).join('\n');
    expect(returned).toBe(source);
  });

  // "full file below" is a coverage claim. The cap that shortens the listing
  // makes it false, and it sat at the head of the string the cap truncated.
  it('drops the full-file claim when the budget cut the listing short', async () => {
    const source = Array.from(
      { length: 400 },
      (_, i) => `export type AliasNumber${i} = SomeFairlyLongTypeName${i};`,
    ).join('\n');
    const outcome = await runOutlineTool({ path: 'src/types.ts' }, deps(source, {
      tokenBudget: 200,
      countTokens: async (text: string) => Math.ceil(text.length / 4),
    }));
    expect(outcome.text).not.toContain('full file below');
    expect(outcome.text).toContain('[compressor:');
    expect(Math.ceil(outcome.text.length / 4)).toBeLessThanOrEqual(200);
    expect(outcome.outlined).toBe(true);
  });

  // The backstop belongs to the tool, not to one of its paths: a file with no
  // symbol provider takes the skeleton fallback, and an uncapped skeleton is
  // what the host spills to a chat-session resource the model then re-reads.
  it('caps the no-provider skeleton path when the host supplies no budget', async () => {
    const source = Array.from({ length: 800 }, (_, i) => [
      `def function_number_${i}(argument_one, argument_two):`,
      '    value = argument_one + argument_two',
      '    other = value * 2',
      '    return other',
    ].join('\n')).join('\n');
    const outcome = await runOutlineTool({ path: 'src/big.py' }, deps(source));
    expect(outcome.isError).toBe(false);
    expect(cheapEstimator(outcome.text)).toBeLessThanOrEqual(5_000);
    expect(outcome.text.length).toBeLessThan(source.length);
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

describe('the budget is a cap, not a preference', () => {
  // A JSON symbol provider reports one symbol per key, so the outline of a
  // package.json is larger than the file. Falling back to the source is right;
  // returning it uncapped is not. Observed in Copilot: the fallback overflowed
  // the host's inline limit, VS Code spilled the result to a chat-session
  // resource file, the model read that file, and the read spilled in turn —
  // nine calls that never retrieved the file, ending in a question to the user.
  const KEYS = 3_000;
  const JSON_SRC = ['{', ...Array.from({ length: KEYS }, (_, i) => `  "key${i}": "value${i}",`), '}'].join('\n');
  const jsonSymbols = async () => Array.from({ length: KEYS }, (_, i) => ({
    // a real provider's detail strings make each line longer than the source line
    name: `contributes.section.key${i}`, detail: `"value${i}"`, kind: SymbolKind.Property,
    column: 2, declLine: i + 2, start: i + 2, end: i + 2, children: [],
  }));

  it('caps the source fallback when the host supplies no budget', async () => {
    // The host is not required to send tokenizationOptions. With no budget the
    // cap was skipped entirely and the whole file went back, which is what the
    // host then had to spill.
    const outcome = await runOutlineTool({ path: 'package.json' }, deps(JSON_SRC, {
      symbols: jsonSymbols,
      countTokens: async (text: string) => Math.ceil(text.length / 4),
    }));
    expect(Math.ceil(outcome.text.length / 4)).toBeLessThanOrEqual(5_000);
  });

  it('still says the output is partial when it caps the fallback', async () => {
    const outcome = await runOutlineTool({ path: 'package.json' }, deps(JSON_SRC, {
      symbols: jsonSymbols,
      countTokens: async (text: string) => Math.ceil(text.length / 4),
    }));
    expect(outcome.text).toContain('compressor:');
  });
});
