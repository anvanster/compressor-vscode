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
  return formatSymbols(symbolsFor(source, spec), { path, lines }).text
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

  // `static` does not have to be the first token. Each of these declares
  // internal linkage and was marked externally visible while the check
  // required `static` at the start of the line.
  it('finds static behind attributes, templates and other specifiers', () => {
    const cpp = [
      'inline static int inlineFirst();',
      '[[nodiscard]] static int attributed();',
      'constexpr static int kConst = 5;',
      '__attribute__((unused)) static void decorated();',
      'void staticLooking();',
      'inline int fastPath();',
    ].join('\n');
    expect(exported('a.cpp', cpp, [
      ['inlineFirst', []], ['attributed', []], ['kConst', []],
      ['decorated', []], ['staticLooking', []], ['fastPath', []],
    ])).toEqual(['staticLooking', 'fastPath']);
  });

  it('honours the access sections of a class', () => {
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
    ].join('\n');
    expect(exported('w.hpp', cpp, [
      ['Widget', ['privateByDefault_', 'render', 'layout']],
      ['Point', ['x']],
    ])).toEqual(['Widget', 'render', 'Point', 'x']);
  });

  // A nested type's own `public:` governs its members and nothing after it.
  // Without stepping over the sibling's line range, `layout` read `Impl`'s
  // section and shipped a private member as API. The ranges are spelled out
  // here because they are what the mechanism turns on: a provider reports a
  // nested type spanning its whole body, which the shorthand above cannot say.
  it('does not let a nested type section govern the member after it', () => {
    const cpp = [
      'class Widget {',
      'public:',
      '  void render();',
      'private:',
      '  struct Impl {',
      '  public:',
      '    int x;',
      '  };',
      '  void layout();',
      '};',
    ];
    const at = (name: string, kind: SymbolKind, declLine: number, end: number): CodeSymbol => ({
      name, detail: '', kind, declLine, start: declLine, end,
      column: cpp[declLine - 1]!.indexOf(name), children: [],
    });
    const impl = at('Impl', SymbolKind.Struct, 5, 8);
    impl.children = [at('x', SymbolKind.Field, 7, 7)];
    const widget: CodeSymbol = {
      name: 'Widget', detail: '', kind: SymbolKind.Class,
      declLine: 1, start: 1, end: 10, column: 6,
      children: [at('render', SymbolKind.Method, 3, 3), impl, at('layout', SymbolKind.Method, 9, 9)],
    };
    const marked = formatSymbols([widget], { path: 'w.hpp', lines: cpp }).text
      .split('\n').filter((line) => line.startsWith('*'));

    expect(marked.some((line) => line.startsWith('*Widget.render'))).toBe(true);
    expect(marked.some((line) => line.startsWith('*Widget.layout'))).toBe(false);
    // `Impl` sits in the private section, so it and everything under it are
    // unmarked — its own `public:` governs its members, not the class's.
    expect(marked.some((line) => line.startsWith('*Widget.Impl'))).toBe(false);
  });

  // `struct sockaddr_in addr_;` names the field's type, not a scope. Reading
  // that keyword as an opener returned `struct`'s public default and the scan
  // stopped before it ever reached the `private:` above — a private member
  // shipped as API under a legend that says marks are the public surface.
  it('does not read an elaborated type specifier as an access scope', () => {
    const cpp = [
      'class Socket {',
      'private:',
      '  struct sockaddr_in addr_;',
      '  union Storage store_;',
      '  void connectTo();',
      '};',
    ].join('\n');
    expect(exported('s.hpp', cpp, [['Socket', ['addr_', 'store_', 'connectTo']]]))
      .toEqual(['Socket']);
  });

  // The same root cause one line up: a field the provider never reported is
  // not in `siblings`, so the scan met its `struct` and stopped there.
  it('does not read an unreported field line as an access scope', () => {
    const cpp = [
      'class Widget {',
      'private:',
      '  struct Impl* impl_;',
      '  void layout();',
      '};',
    ].join('\n');
    expect(exported('w.hpp', cpp, [['Widget', ['layout']]])).toEqual(['Widget']);
  });

  it('does not mark a private pimpl pointer or its forward declaration', () => {
    const cpp = [
      'class Widget {',
      'public:',
      '  void run();',
      'private:',
      '  struct Impl;',
      '  Impl* impl_;',
      '};',
    ].join('\n');
    expect(exported('w.hpp', cpp, [
      ['Widget', ['run', ['Impl', SymbolKind.Struct], 'impl_']],
    ])).toEqual(['Widget', 'run']);
  });

  // An access label is read only at the start of its line, so one inside a
  // comment cannot govern the member beneath it.
  it('ignores an access label written inside a comment', () => {
    const cpp = [
      'class Widget {',
      'private:',
      '  /// Not public: internal only.',
      '  void layoutPass();',
      '};',
    ].join('\n');
    expect(exported('w.hpp', cpp, [['Widget', ['layoutPass']]])).toEqual(['Widget']);
  });

  // The cost of anchoring: an inline label mid-line is not a section opener the
  // scan can see, so `shown` falls back to the class default and is
  // under-marked. Under-marking is the safe direction — the caller reads the
  // code rather than trusting a wrong summary.
  it('under-marks a one-line class rather than reading an inline label', () => {
    const cpp = ['class Tight { void hidden(); public: void shown(); };'].join('\n');
    expect(exported('t.hpp', cpp, [['Tight', ['hidden', 'shown']]])).toEqual(['Tight']);
  });

  it('does not mistake a static member for internal linkage', () => {
    const cpp = ['class Counter {', 'public:', '  static int total();', '};'].join('\n');
    expect(exported('c.cpp', cpp, [['Counter', ['total']]])).toEqual(['Counter', 'total']);
  });

  // An enum constant sits in no access section of its own, so it follows its
  // enum the way every other curly-brace language treats one — and because it
  // is judged, it does not cost the listing its completeness claim.
  it('marks the constants of a visible C++ enum and stays complete', () => {
    const cpp = ['enum class Level {', '  Debug,', '  Info', '};'].join('\n');
    const spec = [[
      'Level',
      [['Debug', SymbolKind.EnumMember], ['Info', SymbolKind.EnumMember]],
      SymbolKind.Enum,
    ]] as const;
    expect(exported('l.hpp', cpp, spec)).toEqual(['Level', 'Debug', 'Info']);
    const listing = formatSymbols(symbolsFor(cpp, spec), { path: 'l.hpp', lines: cpp.split('\n') });
    expect(listing.complete).toBe(true);
    expect(exportLegend(listing)).toContain('do not list them as its API');
  });

  // Every symbol here was judged, so the legend can say what an unmarked name
  // means as well as what a mark means.
  it('keeps the unmarked-names claim for a C++ header it judged throughout', () => {
    const cpp = ['class Widget {', 'private:', '  void layout();', '};'].join('\n');
    const listing = formatSymbols(symbolsFor(cpp, [['Widget', ['layout']]]), {
      path: 'w.hpp', lines: cpp.split('\n'),
    });
    expect(listing.complete).toBe(true);
    expect(exportLegend(listing)).toContain('do not list them as its API');
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
      ['namespace', ['anonInternal'], SymbolKind.Namespace],
      ['api', ['named'], SymbolKind.Namespace],
    ])).toContain('named');
    expect(exported('n.cpp', cpp, [['namespace', ['anonInternal'], SymbolKind.Namespace]]))
      .not.toContain('anonInternal');
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

  // A keyword qualifies one parameter. Scanning the whole line to the left of
  // the name let the first hidden parameter hide every public one after it,
  // and the legend then called a real dependency internal.
  it('judges each parameter property by its own keyword, whatever the order', () => {
    const ts = [
      'export class Service {',
      '  constructor(private dep: Dep, public readonly api: Api) {}',
      '}',
    ].join('\n');
    expect(exported('a.ts', ts, [['Service', ['dep', 'api'], SymbolKind.Class]]))
      .toEqual(['Service', 'api']);
  });

  it('judges each Kotlin constructor property by its own keyword', () => {
    const kt = 'class Box(private val secret: S, val label: L)';
    expect(exported('Box.kt', kt, [['Box', ['secret', 'label']]])).toEqual(['Box', 'label']);
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

  // A comma inside `<...>` separates type arguments, not parameters. Cutting
  // the prefix there dropped the `private` in front of the return type and
  // marked a hidden member as part of the class's surface.
  it('does not let a comma inside generic arguments swallow the keyword', () => {
    const groovy = [
      'class Box {',
      '    private Map<String, Integer> lookup() {}',
      '    private Map<String, List<Integer>> deepLookup() {}',
      '    Map<String, Integer> shown() {}',
      '}',
    ].join('\n');
    expect(exported('Box.groovy', groovy, [['Box', ['lookup', 'deepLookup', 'shown']]]))
      .toEqual(['Box', 'shown']);
  });

  it('does not let a generic type parameter list swallow the keyword', () => {
    const kt = [
      'class Box {',
      '    private fun <A, B> zip(a: A, b: B) {}',
      '    fun <A, B> pair(a: A, b: B) {}',
      '}',
    ].join('\n');
    expect(exported('Box.kt', kt, [['Box', ['zip', 'pair']]])).toEqual(['Box', 'pair']);
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

  // An impl block is judged by the file-scope `pub` rule and nothing else. The
  // stated cost: a `pub` item in an impl on a file-private type is marked,
  // though nothing outside the file can reach it. One line of source cannot
  // say which type an impl is for without re-deriving the module's name
  // resolution, and three rounds of trying produced a different wrong answer
  // each time — a limitation that can be written down beats a heuristic.
  it('marks a pub item in an impl even when its type stays in the file', () => {
    const rs = ['struct Hidden;', 'impl Hidden {', '    pub fn new() -> Self { Hidden }', '}'].join('\n');
    expect(exported('a.rs', rs, [
      ['Hidden', [], SymbolKind.Struct],
      ['impl Hidden', ['new'], SymbolKind.Object],
    ])).toEqual(['new']);
  });

  it('leaves an impl item with no pub unmarked', () => {
    const rs = ['pub struct Foo;', 'impl Foo {', '    fn helper(&self) {}', '}'].join('\n');
    expect(exported('a.rs', rs, [
      ['Foo', [], SymbolKind.Struct],
      ['impl Foo', ['helper'], SymbolKind.Object],
    ])).toEqual(['Foo']);
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

// A provider reports an exported object literal as a Variable whose properties
// are children. No rule runs on them, so they are listed unmarked — but
// `api.fetchUser` is reachable, and the legend must not call it internal.
describe('coverage the legend depends on', () => {
  const api = [
    'export const api = {',
    '  fetchUser(id: string) { return id; },',
    '  saveUser(user: User) { return user; },',
    '};',
  ].join('\n');

  it('does not claim unmarked object-literal properties are internal', () => {
    const listing = formatSymbols(
      symbolsFor(api, [['api', ['fetchUser', 'saveUser'], SymbolKind.Variable]]),
      { path: 'src/api.ts', lines: api.split('\n') },
    );
    expect(listing.text).toMatch(/^\*api /m);
    expect(listing.complete).toBe(false);
    expect(exportLegend(listing)).toContain('visible outside this file');
    expect(exportLegend(listing)).not.toContain('do not list them as its API');
  });

  it('keeps the claim for a file whose symbols a rule all reached', () => {
    const ts = ['export function open() {}', 'function shut() {}'].join('\n');
    const listing = formatSymbols(symbolsFor(ts, [['open', []], ['shut', []]]), {
      path: 'src/api.ts', lines: ts.split('\n'),
    });
    expect(listing.complete).toBe(true);
    expect(exportLegend(listing)).toContain('do not list them as its API');
  });
});

describe('degrading', () => {
  const spec = [['thing', []]] as const;

  it('marks nothing and says nothing for an unknown language', () => {
    const out = formatSymbols(symbolsFor('thing', spec), { path: 'a.zig', lines: ['thing'] });
    expect(out.text.startsWith('*')).toBe(false);
    expect(out.complete).toBe(false);
    expect(exportLegend(out)).toBe('');
  });

  it('marks nothing when no source is supplied', () => {
    const out = formatSymbols(symbolsFor('thing', spec));
    expect(out.text.startsWith('*')).toBe(false);
    expect(out.complete).toBe(false);
    expect(exportLegend(out)).toBe('');
  });

  it('explains the mark only when one is present', () => {
    const marked = formatSymbols(symbolsFor('export const thing = 1;', [['thing', []]]),
      { path: 'a.ts', lines: ['export const thing = 1;'] });
    expect(marked.text.startsWith('*')).toBe(true);
    expect(exportLegend(marked)).toContain('visible outside this file');
    expect(exportLegend({ text: 'thing [lines 1-1]', complete: true })).toBe('');
  });

  // Every symbol in this file was judged, so the legend can say what an
  // unmarked name means as well as what a mark means.
  it('keeps the unmarked-names claim when every symbol was judged', () => {
    const ts = ['export class Service {', '  private secret() {}', '  run() {}', '}'].join('\n');
    const listing = formatSymbols(symbolsFor(ts, [['Service', ['secret', 'run']]]), {
      path: 'a.ts', lines: ts.split('\n'),
    });
    expect(listing.complete).toBe(true);
    expect(exportLegend(listing)).toContain('do not list them as its API');
  });
});
