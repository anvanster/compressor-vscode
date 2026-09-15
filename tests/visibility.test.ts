import { describe, expect, it } from 'vitest';
import { SymbolKind } from 'vscode';
import { type CodeSymbol, exportLegend, formatSymbols } from '../src/tools/symbols';

/** A child name, or that name with the kind the provider gives it. */
type Child = string | readonly [string, SymbolKind];

/** A parent symbol, its children, and the kind the provider gives the parent. */
type Spec = readonly [string, readonly Child[]] | readonly [string, readonly Child[], SymbolKind];

/** Build a symbol tree by finding each name in the source, as a provider would. */
function symbolsFor(source: string, spec: readonly Spec[]): CodeSymbol[] {
  const lines = source.split('\n');
  // A provider reports selectionRange over the name and range over the whole
  // symbol, comments included. declLine/column mirror selectionRange; start
  // mirrors range, so it walks back over any comment block above the name.
  const locate = (name: string, after = 0): { declLine: number; column: number; start: number } => {
    for (let i = after; i < lines.length; i += 1) {
      const column = lines[i]!.indexOf(name);
      if (column < 0) continue;
      let start = i;
      while (start > 0 && /^\s*(\/\*\*|\*|\/\/|#)/.test(lines[start - 1]!)) start -= 1;
      return { declLine: i + 1, column, start: start + 1 };
    }
    throw new Error(`no line contains ${name}`);
  };
  return spec.map(([parent, children, kind]) => {
    const at = locate(parent);
    let cursor = at.declLine - 1;
    return {
      name: parent, detail: '', kind: kind ?? SymbolKind.Class, ...at, end: at.declLine,
      children: children.map((child) => {
        const [childName, childKind] = typeof child === 'string'
          ? [child, SymbolKind.Method] as const
          : child;
        const childAt = locate(childName, cursor);
        cursor = childAt.declLine - 1;
        return {
          name: childName, detail: '', kind: childKind,
          ...childAt, end: childAt.declLine, children: [],
        };
      }),
    };
  });
}

/** Names carrying the `*` mark, unqualified. */
function exported(path: string, source: string, spec: readonly Spec[]): string[] {
  const lines = source.split('\n');
  return formatSymbols(symbolsFor(source, spec), { path, lines })
    .split('\n')
    .filter((line) => line.startsWith('*'))
    // a provider name can contain a space (`impl Foo`), so cut at the range
    .map((line) => line.slice(1).split(' [lines ')[0]!.split('.').pop()!);
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

  // TypeScript reports a constructor parameter property as a class child whose
  // name sits on the constructor line, so a rule anchored at the start of that
  // line never sees the keyword and shipped an injected dependency as API.
  it('reads the access keyword of a constructor parameter property', () => {
    const ts = [
      'export class Service {',
      '  constructor(public readonly api: Api, private secret: Secret) {}',
      '  run(): void {}',
      '}',
    ].join('\n');
    expect(exported('a.ts', ts, [['Service', ['api', 'secret', 'run'], SymbolKind.Class]]))
      .toEqual(['Service', 'api', 'run']);
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

  // Kotlin, Scala and Groovy default to public. Under the Java rule, which
  // needs a literal `public`, a file's one explicitly-public declaration was
  // the only thing marked — and the legend then said every other declaration
  // was internal, which is the misreading the mark exists to prevent.
  it('marks a Kotlin file that never writes `public`', () => {
    const kt = [
      'class Box(private val item: String) {',
      '    fun open() {}',
      '    private fun latch() {}',
      '    internal fun crate() {}',
      '    protected fun lid() {}',
      '}',
    ].join('\n');
    expect(exported('Box.kt', kt, [['Box', ['open', 'latch', 'crate', 'lid']]]))
      .toEqual(['Box', 'open']);
    expect(exported('Box.kts', kt, [['Box', ['open', 'latch', 'crate', 'lid']]]))
      .toEqual(['Box', 'open']);
  });

  it('marks a Scala file, honouring private[this]', () => {
    const scala = [
      'class Box {',
      '  def open(): Unit = {}',
      '  private[this] def latch(): Unit = {}',
      '  protected def lid(): Unit = {}',
      '}',
    ].join('\n');
    expect(exported('Box.scala', scala, [['Box', ['open', 'latch', 'lid']]]))
      .toEqual(['Box', 'open']);
  });

  it('marks a Groovy file', () => {
    const groovy = ['class Box {', '    def open() {}', '    private def latch() {}', '}'].join('\n');
    expect(exported('Box.groovy', groovy, [['Box', ['open', 'latch']]])).toEqual(['Box', 'open']);
  });
});

// A container's children are not one thing, and a rule that reads only the
// child's own declaration line gets them wrong in both directions.
describe('what a container does to the symbols inside it', () => {
  // rust-analyzer reports an `impl` block as a container whose declaration
  // line is `impl Foo {`. That line has no `pub`, so the walk stopped there
  // and every `pub fn` in every Rust file shipped unmarked, beneath a legend
  // saying unmarked names are internal.
  it('descends through a Rust impl block without marking the block', () => {
    const rs = ['pub struct Foo;', 'impl Foo {', '    pub fn new() -> Self { Foo }', '}'].join('\n');
    expect(exported('a.rs', rs, [
      ['Foo', [], SymbolKind.Struct],
      ['impl Foo', ['new'], SymbolKind.Object],
    ])).toEqual(['Foo', 'new']);
  });

  it('does not mark the impl of a struct the file keeps to itself', () => {
    const rs = ['struct Hidden;', 'impl Hidden {', '    pub fn new() -> Self { Hidden }', '}'].join('\n');
    expect(exported('a.rs', rs, [
      ['Hidden', [], SymbolKind.Struct],
      ['impl Hidden', ['new'], SymbolKind.Object],
    ])).toEqual([]);
  });

  // The self type is the only declaration an impl's reach depends on. Scanning
  // every token on the line let a private type mentioned in a parameter
  // position close a block that has nothing to do with it.
  it('follows the self type of a trait impl, not the types it converts from', () => {
    const rs = [
      'struct Buffer;',
      'pub struct Writer;',
      'impl From<Buffer> for Writer {',
      '    pub fn new() -> Self { Writer }',
      '}',
    ].join('\n');
    expect(exported('a.rs', rs, [
      ['Buffer', [], SymbolKind.Struct],
      ['Writer', [], SymbolKind.Struct],
      ['impl From<Buffer> for Writer', ['new'], SymbolKind.Object],
    ])).toEqual(['Writer', 'new']);
  });

  it('strips generic arguments from the self type', () => {
    const rs = ['struct Hidden;', 'impl<T> Hidden<T> {', '    pub fn new() {}', '}'].join('\n');
    expect(exported('a.rs', rs, [
      ['Hidden', [], SymbolKind.Struct],
      ['impl<T> Hidden<T>', ['new'], SymbolKind.Object],
    ])).toEqual([]);
  });

  // Only what the top-level frame rejects can close a group. A method name
  // inside one impl is not a file-scope type and must not close the next.
  it('does not let an unmarked method name close a later impl', () => {
    const rs = [
      'pub struct A;',
      'impl Display for A {',
      '    fn fmt(&self) {}',
      '}',
      'pub struct B;',
      'impl fmt::Debug for B {',
      '    pub fn go() {}',
      '}',
    ].join('\n');
    expect(exported('a.rs', rs, [
      ['A', [], SymbolKind.Struct],
      ['impl Display for A', ['fmt'], SymbolKind.Object],
      ['B', [], SymbolKind.Struct],
      ['impl fmt::Debug for B', ['go'], SymbolKind.Object],
    ])).toEqual(['A', 'B', 'go']);
  });

  it('marks a Rust trait method, which carries no pub of its own', () => {
    const rs = ['pub trait Greet {', '    fn hello(&self);', '}'].join('\n');
    expect(exported('a.rs', rs, [['Greet', ['hello'], SymbolKind.Interface]]))
      .toEqual(['Greet', 'hello']);
  });

  it('marks a Java interface method, which never says public', () => {
    const java = ['public interface Repo {', '    List<Item> findAll();', '}'].join('\n');
    expect(exported('Repo.java', java, [['Repo', ['findAll'], SymbolKind.Interface]]))
      .toEqual(['Repo', 'findAll']);
  });

  it('marks Java enum constants', () => {
    const java = ['public enum Color {', '    RED,', '    GREEN', '}'].join('\n');
    expect(exported('Color.java', java, [[
      'Color',
      [['RED', SymbolKind.EnumMember], ['GREEN', SymbolKind.EnumMember]],
      SymbolKind.Enum,
    ]])).toEqual(['Color', 'RED', 'GREEN']);
  });

  // Only an enum's constants are exempt from its access keywords. Its fields,
  // constructors and methods are ordinary class members, and an enum
  // constructor is implicitly private — none of that is public API.
  it('holds a Java enum field and constructor to the ordinary class rules', () => {
    const java = [
      'public enum Planet {',
      '    MERCURY(3.303e+23),',
      '    VENUS(4.869e+24);',
      '    private final double mass;',
      '    Planet(double m) { this.mass = m; }',
      '    public double surfaceGravity() { return mass; }',
      '}',
    ].join('\n');
    expect(exported('Planet.java', java, [[
      'Planet',
      [
        ['MERCURY', SymbolKind.EnumMember], ['VENUS', SymbolKind.EnumMember],
        ['mass', SymbolKind.Field], ['Planet(double', SymbolKind.Constructor],
        ['surfaceGravity', SymbolKind.Method],
      ],
      SymbolKind.Enum,
    ]])).toEqual(['Planet', 'MERCURY', 'VENUS', 'surfaceGravity']);
  });

  // Java 9 and C# 8 both let an interface declare a private member.
  it('does not mark a private Java interface method', () => {
    const java = [
      'public interface Repo {',
      '    List<Item> findAll();',
      '    private void checkState() {}',
      '}',
    ].join('\n');
    expect(exported('Repo.java', java, [[
      'Repo', ['findAll', 'checkState'], SymbolKind.Interface,
    ]])).toEqual(['Repo', 'findAll']);
  });

  it('marks a C# interface member', () => {
    const cs = ['public interface IRepo', '{', '    int Count { get; }', '}'].join('\n');
    expect(exported('IRepo.cs', cs, [['IRepo', ['Count'], SymbolKind.Interface]]))
      .toEqual(['IRepo', 'Count']);
  });

  // A C# namespace never carries an access keyword, so judging it by the same
  // rule as a class left it unmarked and hid every type in the file with it.
  it('sees through a C# namespace to the types inside it', () => {
    const cs = ['namespace Data', '{', '    public class Repo { }', '}'].join('\n');
    expect(exported('Repo.cs', cs, [['Data', ['Repo'], SymbolKind.Namespace]])).toEqual(['Repo']);
  });

  // The other direction: a TypeScript namespace member repeats `export`, so
  // the member rule's "public unless it says private" marked module-local
  // constants as part of the file's surface.
  it('judges a TypeScript namespace member at file scope', () => {
    const ts = [
      'export namespace Cfg {',
      "  const SECRET = 'x';",
      '  export function get() {}',
      '}',
    ].join('\n');
    expect(exported('a.ts', ts, [['Cfg', ['SECRET', 'get'], SymbolKind.Module]]))
      .toEqual(['Cfg', 'get']);
  });

  it('marks nothing inside a TypeScript namespace the file never exports', () => {
    const ts = ['namespace Internal {', '  export function f() {}', '}'].join('\n');
    expect(exported('a.ts', ts, [['Internal', ['f'], SymbolKind.Module]])).toEqual([]);
  });
});

describe('a function\'s children are locals, not API', () => {
  // A TS provider reports nested functions and function-valued consts as
  // children. The member branch of a rule sees no `private`/`protected` on
  // their line and marks them, so a file-local helper is handed to the model
  // as part of the module's public surface.
  it('does not mark an arrow function declared inside an exported function', () => {
    const ts = [
      'export function runReadTool(): void {',
      '  const shown = (text: string): string => text;',
      '  shown("x");',
      '}',
    ].join('\n');
    expect(exported('read.ts', ts, [['runReadTool', ['shown'], SymbolKind.Function]]))
      .toEqual(['runReadTool']);
  });

  it('does not mark a local inside a Python function', () => {
    const py = ['def run_it():', '    def helper():', '        pass', '    helper()'].join('\n');
    expect(exported('a.py', py, [['run_it', ['helper'], SymbolKind.Function]]))
      .toEqual(['run_it']);
  });

  it('still marks the members of a class, which are declarations', () => {
    const ts = ['export class Service {', '  run() {}', '}'].join('\n');
    expect(exported('a.ts', ts, [['Service', ['run'], SymbolKind.Class]]))
      .toEqual(['Service', 'run']);
  });
});

describe('the declaration line, not the range start', () => {
  // DocumentSymbol.range covers "everything else, e.g. comments and code", so
  // for a documented symbol it starts at the opening comment. Reading
  // visibility from range.start marks nothing in a file that documents its
  // exports — which is every file in this extension.
  it('marks an export whose range starts at its JSDoc comment', () => {
    const ts = [
      '/**',
      ' * Does a thing.',
      ' */',
      'export function documented() {}',
      '',
      '/** Internal helper. */',
      'function documentedInternal() {}',
    ].join('\n');
    expect(exported('a.ts', ts, [['documented', []], ['documentedInternal', []]]))
      .toEqual(['documented']);
  });

  it('marks a documented C++ file-scope function and not a documented static', () => {
    const cpp = [
      '// Computes the area.',
      'int computeArea(int w, int h);',
      '',
      '// Clamps a value.',
      'static int clampToRange(int v);',
    ].join('\n');
    expect(exported('a.cpp', cpp, [['computeArea', []], ['clampToRange', []]]))
      .toEqual(['computeArea']);
  });

  it('still finds `static` on the line above a documented declaration', () => {
    const cpp = ['/** Tidies up. */', 'static', 'void tidyUp() {}'].join('\n');
    expect(exported('a.cpp', cpp, [['tidyUp', []]])).toEqual([]);
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
