import * as vscode from 'vscode';

/**
 * An outline lists every symbol the language provider reports, with nothing to
 * say which ones are reachable from outside the file. Models read that as a
 * description of the public API and name module-local helpers as part of it.
 *
 * The provider cannot help. `SymbolTag` has exactly one member (`Deprecated`),
 * so visibility never reaches us through the API. The declaration line carries
 * it in every language below, which is enough for a hint and needs no parser.
 *
 * A hint is all this is. Each rule reads one line, so it can under-mark (a
 * TypeScript `export { a, b }` list re-exports names whose own declaration
 * lines say nothing) and, in C/C++, over-mark (a non-`static` definition in a
 * .c file is externally linkable even when no header declares it). A `pub` item
 * in a Rust `impl` on a file-private type is marked as well, though nothing
 * outside the file can reach it: the impl line does not say which type it is
 * for in a form one line can resolve. Unknown extensions mark nothing at all.
 * Under-marking is the safe direction: the caller reads unmarked code rather
 * than trusting a wrong summary.
 *
 * An inline C++ access label (`class T { void a(); public: void b(); };`) is
 * not read, because a label is only recognised at the start of its line —
 * which is what keeps one inside a comment from governing the member below it.
 * `b` there falls back to the class default and is under-marked.
 *
 * A listing that reaches symbols no rule judged says so, so the legend can
 * stop claiming an unmarked name is internal.
 */

/** A 1-based, inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
}

/** One symbol, with the context its visibility rule needs. */
export interface VisibilityContext {
  /** Symbol name, unqualified. */
  name: string;
  /** The whole declaration line, trimmed. */
  decl: string;
  /** 1-based line the name sits on. */
  start: number;
  /** 1-based declaration line of the enclosing symbol; 0 at file scope. */
  containerStart: number;
  /** Column of the name within the declaration line, 0-based. */
  column: number;
  /** Every line of the file. */
  lines: readonly string[];
  /**
   * Line ranges of the declarations sharing this symbol's container, this one
   * included. A scan walking outward from a symbol steps over them: whatever a
   * sibling's own body says governs that sibling, not this symbol.
   */
  siblings: readonly LineRange[];
}

/**
 * A container symbol, as its language sees it.
 *
 * What sits under a container is not one thing. A class member is governed by
 * an access keyword; an interface method has none to give; a namespace member
 * carries the same keyword it would at file scope; and a Rust `impl` block is
 * not a scope at all. A rule that reads only the child's own line cannot tell
 * these apart, and gets a wrong answer in both directions: an interface method
 * looks package-private to the Java rule, and a namespace member looks public
 * to the TypeScript one.
 */
export interface ContainerContext {
  kind: vscode.SymbolKind;
  /** The container's declaration line, trimmed. */
  decl: string;
}

/** How the declarations inside a container are judged. */
export type MemberScope =
  /** By the language's access rules for members. */
  | 'member'
  /** By the file-scope rule: the member carries its own keyword. */
  | 'file'
  /**
   * Public by default: a member that writes no access keyword is visible, and
   * one that writes `private` or `protected` is not. Java 9 and C# 8 both let
   * an interface hide a member, and a Java enum's fields and constructors are
   * ordinary class members that only its constants are exempt from.
   */
  | 'implicit'
  /**
   * A grouping rather than a scope: the container is not itself a symbol and is
   * never marked, and its children are judged at file scope.
   */
  | 'group';

export interface LanguageRule {
  visible: (context: VisibilityContext) => boolean;
  /** undefined for a kind that declares nothing: its children are locals. */
  scope: (container: ContainerContext) => MemberScope | undefined;
}

type Rule = LanguageRule['visible'];

const topLevel = (context: VisibilityContext): boolean => context.containerStart === 0;

const KIND = vscode.SymbolKind;

/**
 * Kinds that hold declarations. A provider reports a function's nested
 * functions and function-valued consts as its children, and those are locals:
 * nothing outside the function can name them whatever their declaration line
 * says. `export function f() { const g = () => {}; }` is one symbol of public
 * API, not two.
 */
const DECLARING: ReadonlySet<vscode.SymbolKind> = new Set([
  KIND.Class, KIND.Interface, KIND.Struct, KIND.Enum,
  KIND.Object, KIND.Namespace, KIND.Module,
]);

/** Every container is its own access scope; nothing declares members but these. */
const byKind = (container: ContainerContext): MemberScope | undefined =>
  DECLARING.has(container.kind) ? 'member' : undefined;

/**
 * The shape shared by the curly-brace languages: an interface or an enum has
 * no access keywords to read, and a namespace re-opens whatever scope the
 * language spells out — `file` where a member must repeat the keyword,
 * `group` where the namespace itself never carries one.
 */
const withNamespaces = (namespaces: MemberScope) =>
  (container: ContainerContext): MemberScope | undefined => {
    if (!DECLARING.has(container.kind)) return undefined;
    if (container.kind === KIND.Namespace || container.kind === KIND.Module) return namespaces;
    if (container.kind === KIND.Interface || container.kind === KIND.Enum) return 'implicit';
    return 'member';
  };

/**
 * The modifiers that qualify this name and no other: the declaration line back
 * to the `(` that opens the parameter list or the `,` that ends the previous
 * parameter, whichever comes last. A keyword to the right belongs to a later
 * declaration, and one to the left of an earlier parameter belongs to that
 * parameter — `class Foo(private val a: A, val b: B)` declares a public `b`.
 *
 * The scan tracks bracket depth, because a `,` inside `<>`, `[]`, `()` or `{}`
 * separates type arguments rather than parameters: cutting at the comma in
 * `private Map<String, Integer> lookup()` leaves `Integer>`, drops the
 * `private`, and marks a hidden member as API. With no delimiter at depth zero
 * the whole prefix qualifies the name, so `class Box(...)` reads its `class `.
 */
const beforeName = (context: VisibilityContext): string => {
  const prefix = (context.lines[context.start - 1] ?? '').slice(0, context.column);
  let depth = 0;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const character = prefix[index];
    if (character === '>' || character === ')' || character === ']' || character === '}') depth += 1;
    else if (character === '<' || character === '[' || character === '{') depth = Math.max(0, depth - 1);
    else if (character === '(') {
      if (depth === 0) return prefix.slice(index + 1);
      depth -= 1;
    } else if (character === ',' && depth === 0) return prefix.slice(index + 1);
  }
  return prefix;
};

/**
 * Public unless the declaration hides it, judged from the modifiers that
 * qualify this name alone.
 */
export const implicitlyVisible = (context: VisibilityContext): boolean =>
  !/\b(?:private|protected)\b/.test(beforeName(context)) && !context.name.startsWith('#');

/**
 * `namespace {` with no name. Its contents have internal linkage, and so does
 * the namespace itself — nothing outside the file can name either.
 */
const anonymousNamespace = (line: string): boolean =>
  /^\s*namespace\s*\{/.test(line) || /^\s*namespace\s*$/.test(line.trimEnd());

/**
 * An access label, anchored. A label only ever opens a section at the start of
 * its line, so anchoring is what keeps `/// Not public: internal only.` and
 * `// NOTE: private: section below` from deciding the member beneath them —
 * no comment stripping needed. The cost is an inline label in a one-line class
 * (`class T { void a(); public: void b(); };`), which no longer resolves: `b`
 * falls back to the class default and is under-marked, the safe direction.
 */
const ACCESS_LABEL = /^\s*(public|private|protected)\s*:(?![:\w])/;
const TYPE_OPENER = /^\s*(?:template\s*<[^>]*>\s*)?(class|struct|union)\b/;

/** Leading attributes and template headers, which sit before any specifier. */
const DECORATION = /^\s*(?:\[\[[^\]]*\]\]|__attribute__\s*\(\(.*?\)\)|template\s*<[^>]*>)/;

const SPECIFIERS: ReadonlySet<string> = new Set([
  'static', 'inline', 'constexpr', 'consteval', 'constinit', 'extern', 'virtual',
  'explicit', 'friend', 'mutable', 'thread_local', 'const', 'volatile', 'typedef',
]);

/**
 * `static` at file scope means internal linkage, but it does not have to come
 * first: `inline static`, `[[nodiscard]] static` and `constexpr static` all
 * hide a symbol. Read the run of leading specifier keywords after any
 * attributes or template header and stop at the first word that is not one, so
 * `static_assert(...)` and `void staticLooking();` stay external.
 */
const internalLinkage = (decl: string): boolean => {
  let rest = decl;
  for (let decoration = DECORATION.exec(rest); decoration !== null; decoration = DECORATION.exec(rest)) {
    rest = rest.slice(decoration[0].length);
  }
  for (const word of rest.trim().split(/\s+/)) {
    const token = /^[A-Za-z_][A-Za-z0-9_]*/.exec(word)?.[0];
    if (token === undefined || !SPECIFIERS.has(token)) return false;
    if (token === 'static') return true;
  }
  return false;
};

const covers = (range: LineRange, line: number): boolean =>
  line >= range.start && line <= range.end;

/**
 * C and C++ have no `export` keyword outside C++20 modules, so the rule runs
 * the other way round: a symbol is visible unless something hides it. At file
 * scope that is `static` or an anonymous namespace; inside a class it is the
 * access section the member sits in.
 *
 * The section is found by walking outward to the container, stepping over the
 * line ranges of the container's other children. That is what keeps a nested
 * type's own `public:` from governing the member declared after it, and it
 * needs no brace counting: the provider already reports where each sibling
 * begins and ends.
 */
const cFamily: Rule = (context) => {
  const { decl, lines, start, containerStart, column, siblings } = context;
  if (anonymousNamespace(decl)) return false;
  if (topLevel(context)) {
    const previous = lines[start - 2] ?? '';
    // A declaration may put `static` alone on the line above its name.
    return !internalLinkage(decl) && !/^\s*static\s*$/.test(previous.trimEnd());
  }
  for (let index = start; index >= containerStart; index -= 1) {
    const sibling = index !== start
      && siblings.some((range) => covers(range, index) && !covers(range, start));
    if (sibling) continue;
    const text = index === start ? (lines[index - 1] ?? '').slice(0, column) : (lines[index - 1] ?? '');
    const label = ACCESS_LABEL.exec(text);
    if (label) return label[1] === 'public';
    const open = TYPE_OPENER.exec(text);
    // `class` defaults to private, `struct` and `union` to public — but only
    // the container's own declaration line carries the opener that sets that
    // default. Anywhere else the keyword belongs to the declaration it sits on:
    // `struct sockaddr_in addr_;` names a field's type, and reading it as a
    // scope returned `struct`'s public default before the scan ever reached
    // the `private:` above. One line, one owner.
    if (open && index === containerStart) return open[1] !== 'class';
  }
  return true;
};

const RULES: Record<string, LanguageRule> = {
  // `export` only ever appears at file scope; members are public unless the
  // declaration says otherwise, including the `#private` field syntax. A
  // namespace member repeats `export`, so it is judged at file scope.
  ts: {
    visible: (context) => topLevel(context)
      ? /^export\b/.test(context.decl)
      : implicitlyVisible(context),
    scope: withNamespaces('file'),
  },
  // `pub`, including `pub(crate)`: both reach another file, which is what the
  // mark claims. An `impl` block carries no `pub` of its own and is not a
  // symbol anyone can name, so it groups rather than encloses.
  rs: {
    visible: (context) => /^pub\b/.test(context.decl),
    scope: (container) => /^impl\b/.test(container.decl) ? 'group' : withNamespaces('file')(container),
  },
  // Exported identifiers are capitalised, at every depth including fields. An
  // interface method follows the same rule, so nothing here is implicit.
  go: { visible: (context) => /^[A-Z]/.test(context.name), scope: byKind },
  // The leading-underscore convention, which applies to members too.
  py: { visible: (context) => !context.name.startsWith('_'), scope: byKind },
  // Java package-private and C# internal are both the unmarked default. A C#
  // namespace never carries an access keyword, so it groups rather than
  // encloses; treating it as a scope hid every type in the file behind it.
  java: {
    visible: (context) => /^(?:[\w@[\]]+\s+)*?public\b/.test(context.decl),
    scope: withNamespaces('group'),
  },
  // Kotlin, Scala and Groovy default to public, so the test runs the other way
  // round from Java's: visible unless the declaration hides it. Kotlin's
  // `internal` does reach the rest of its module, but not the consumers this
  // mark is about, so it joins `private` and `protected` on the hidden side.
  open: {
    visible: (context) => !/\b(?:private|protected|internal)\b/.test(beforeName(context)),
    scope: byKind,
  },
  c: {
    visible: cFamily,
    // A named namespace re-opens file scope, where the linkage rule applies. An
    // anonymous one is a boundary rather than a grouping: cFamily refuses it,
    // and refusing the container hides everything under it. An enum constant
    // sits in no access section of its own, so it follows its enum.
    scope: (container) => anonymousNamespace(container.decl)
      ? 'member'
      : withNamespaces('group')(container),
  },
};

const BY_EXTENSION: Record<string, keyof typeof RULES> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  rs: 'rs',
  go: 'go',
  py: 'py', pyi: 'py',
  java: 'java', cs: 'java',
  kt: 'open', kts: 'open', scala: 'open', groovy: 'open',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', 'c++': 'c',
  hpp: 'c', hh: 'c', hxx: 'c', 'h++': 'c', ipp: 'c', inl: 'c', cu: 'c', cuh: 'c',
};

/**
 * The rule for a path, or undefined when the language is not one of the above.
 * Callers mark nothing rather than guessing when this returns undefined.
 */
export function visibilityRule(filePath: string): LanguageRule | undefined {
  const extension = filePath.toLowerCase().split('.').pop();
  const key = extension === undefined ? undefined : BY_EXTENSION[extension];
  return key === undefined ? undefined : RULES[key];
}
