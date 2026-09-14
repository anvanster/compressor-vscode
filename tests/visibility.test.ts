import { describe, expect, it } from 'vitest';
import { type CodeSymbol, exportLegend, formatSymbols } from '../src/tools/symbols';

/** Build a symbol tree by finding each name in the source, as a provider would. */
function symbolsFor(source: string, spec: readonly (readonly [string, readonly string[]])[]): CodeSymbol[] {
  const lines = source.split('\n');
  // A provider reports `range` over the whole declaration, not just the name:
  // for `export function f()` the column is 0, not the offset of `f`. Back up
  // from the name to the start of its declaration, which on a line holding
  // several declarations is the last `;`, `{` or access-label `:` before it.
  const locate = (name: string, after = 0): { start: number; column: number } => {
    for (let i = after; i < lines.length; i += 1) {
      const line = lines[i]!;
      const at = line.indexOf(name);
      if (at < 0) continue;
      const boundary = Math.max(
        line.lastIndexOf(';', at), line.lastIndexOf('{', at), line.lastIndexOf(':', at),
      );
      const from = boundary < 0 ? 0 : boundary + 1;
      return { start: i + 1, column: from + (line.slice(from).length - line.slice(from).trimStart().length) };
    }
    throw new Error(`no line contains ${name}`);
  };
  return spec.map(([parent, children]) => {
    const at = locate(parent);
    let cursor = at.start - 1;
    return {
      name: parent, detail: '', ...at, end: at.start,
      children: children.map((child) => {
        const childAt = locate(child, cursor);
        cursor = childAt.start - 1;
        return { name: child, detail: '', ...childAt, end: childAt.start, children: [] };
      }),
    };
  });
}

/** Names carrying the `*` mark, unqualified. */
function exported(path: string, source: string, spec: Parameters<typeof symbolsFor>[1]): string[] {
  const lines = source.split('\n');
  return formatSymbols(symbolsFor(source, spec), { path, lines })
    .split('\n')
    .filter((line) => line.startsWith('*'))
    .map((line) => line.slice(1).split(' ')[0]!.split('.').pop()!);
}

describe('C and C++ visibility', () => {
  const source = [
    'static int helper(int x) { return x + 1; }',
    'int publicFn(int x) { return helper(x); }',
    'static const int kInternal = 5;',
    'extern int gShared;',
    'static',
    'void splitDecl(int a) {}',
  ].join('\n');

  it('treats file-scope static as internal linkage', () => {
    expect(exported('a.c', source, [
      ['helper', []], ['publicFn', []], ['kInternal', []], ['gShared', []], ['splitDecl', []],
    ])).toEqual(['publicFn', 'gShared']);
  });

  it('honours access sections, including a class opened on a member line', () => {
    const cpp = [
      'class Widget {',
      '  int privateByDefault_;',
      'public:',
      '  void render();',
      'private:',
      '  void layout();',
      '};',
      'struct Point {',
      '  int x;',
      '};',
      'class Tight { void hidden(); public: void shown(); };',
    ].join('\n');
    expect(exported('w.hpp', cpp, [
      ['Widget', ['privateByDefault_', 'render', 'layout']],
      ['Point', ['x']],
      ['Tight', ['hidden', 'shown']],
    ])).toEqual(['Widget', 'render', 'Point', 'x', 'Tight', 'shown']);
  });

  it('does not mistake a static member for internal linkage', () => {
    const cpp = ['class Counter {', 'public:', '  static int total();', '};'].join('\n');
    expect(exported('c.cpp', cpp, [['Counter', ['total']]])).toEqual(['Counter', 'total']);
  });

  it('hides an anonymous namespace and keeps a named one', () => {
    const cpp = [
      'namespace {',
      '  void anonInternal() {}',
      '}',
      'namespace api {',
      '  void named() {}',
      '}',
    ].join('\n');
    expect(exported('n.cpp', cpp, [
      ['namespace', ['anonInternal']],
      ['api', ['named']],
    ])).toContain('named');
    expect(exported('n.cpp', cpp, [['namespace', ['anonInternal']]])).not.toContain('anonInternal');
  });
});

describe('other languages', () => {
  it('marks TypeScript exports and unmarks private members', () => {
    const ts = [
      'export function shown() {}',
      'function hidden() {}',
      'export class Service {',
      '  private secret() {}',
      '  run() {}',
      '  #count = 0;',
      '}',
    ].join('\n');
    expect(exported('a.ts', ts, [
      ['shown', []], ['hidden', []], ['Service', ['secret', 'run', '#count']],
    ])).toEqual(['shown', 'Service', 'run']);
  });

  it('marks Rust pub and pub(crate) at any depth', () => {
    const rs = ['pub fn open() {}', 'fn shut() {}', 'pub struct S {', '    pub field: u8,', '    hidden: u8,', '}'].join('\n');
    expect(exported('a.rs', rs, [['open', []], ['shut', []], ['S', ['field', 'hidden']]]))
      .toEqual(['open', 'S', 'field']);
  });

  it('uses capitalisation in Go and underscores in Python', () => {
    expect(exported('a.go', 'func Open() {}\nfunc shut() {}', [['Open', []], ['shut', []]])).toEqual(['Open']);
    expect(exported('a.py', 'def open_it():\n    pass\ndef _hidden():\n    pass', [['open_it', []], ['_hidden', []]]))
      .toEqual(['open_it']);
  });

  it('marks Java public and leaves package-private alone', () => {
    const java = ['public class S {', '    public void run() {}', '    void pkg() {}', '}'].join('\n');
    expect(exported('S.java', java, [['S', ['run', 'pkg']]])).toEqual(['S', 'run']);
  });
});

describe('inherited visibility', () => {
  it('does not mark members of a class the file never exports', () => {
    const ts = [
      'class Internal {',
      '  run() {}',
      '}',
      'export class Public {',
      '  go() {}',
      '}',
    ].join('\n');
    expect(exported('a.ts', ts, [['Internal', ['run']], ['Public', ['go']]]))
      .toEqual(['Public', 'go']);
  });

  it('does not mark public members of a C++ class in an anonymous namespace', () => {
    const cpp = [
      'namespace {',
      'class Hidden {',
      'public:',
      '  void run();',
      '};',
      '}',
    ].join('\n');
    expect(exported('a.cpp', cpp, [['namespace', ['Hidden']]])).toEqual([]);
  });
});

describe('degrading', () => {
  const spec = [['thing', []]] as const;

  it('marks nothing and says nothing for an unknown language', () => {
    const out = formatSymbols(symbolsFor('thing', spec), { path: 'a.zig', lines: ['thing'] });
    expect(out.startsWith('*')).toBe(false);
    expect(exportLegend(out)).toBe('');
  });

  it('marks nothing when no source is supplied', () => {
    const out = formatSymbols(symbolsFor('thing', spec));
    expect(out.startsWith('*')).toBe(false);
    expect(exportLegend(out)).toBe('');
  });

  it('explains the mark only when one is present', () => {
    const marked = formatSymbols(symbolsFor('export const thing = 1;', [['thing', []]]),
      { path: 'a.ts', lines: ['export const thing = 1;'] });
    expect(marked.startsWith('*')).toBe(true);
    expect(exportLegend(marked)).toContain('visible outside this file');
    expect(exportLegend('thing [lines 1-1]')).toBe('');
  });
});
