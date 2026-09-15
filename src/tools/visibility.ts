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
 * .c file is externally linkable even when no header declares it). Unknown
 * extensions mark nothing at all. Under-marking is the safe direction: the
 * caller reads unmarked code rather than trusting a wrong summary.
 */

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
  /** No access keyword exists here, so a member is visible with its container. */
  | 'implicit'
  /**
   * A grouping rather than a scope: the container is not itself a symbol and is
   * never marked, its children are judged at file scope, and it is reachable
   * only as far as the symbol it names is.
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
 * The untrimmed declaration line up to the name's column: every modifier sits
 * to the left of the name it qualifies, and everything to the right belongs to
 * the signature. `class Box(private val item: T)` declares a public `Box`, and
 * scanning the whole line for `private` would call it hidden.
 */
const beforeName = (context: VisibilityContext): string =>
  (context.lines[context.start - 1] ?? '').slice(0, context.column);

/**
 * `public:` / `private:` / `protected:` and the `class` / `struct` / `union`
 * that opens their scope. A member's own line is searched only up to its start
 * column, so `class T { void hidden(); public: void shown(); };` resolves both
 * members correctly rather than giving them whichever label comes last.
 */
const ACCESS_LABEL = /.*\b(public|private|protected)\s*:(?![:\w])/;
const TYPE_OPENER = /^\s*(?:template\s*<[^>]*>\s*)?(class|struct|union)\b/;

/**
 * C and C++ have no `export` keyword outside C++20 modules, so the rule runs
 * the other way round: a symbol is visible unless something hides it. At file
 * scope that is `static` (internal linkage) or an anonymous namespace; inside
 * a class it is the access section the member sits in.
 *
 * `static` means two unrelated things depending on scope — internal linkage at
 * file scope, a static member inside a class, which is usually public — so the
 * linkage test must never run on a member.
 */
/**
 * `namespace {` with no name. Its contents have internal linkage, and so does
 * the namespace itself — nothing outside the file can name either.
 */
const anonymousNamespace = (line: string): boolean =>
  /^\s*namespace\s*\{/.test(line) || /^\s*namespace\s*$/.test(line.trimEnd());

const cFamily: Rule = (context) => {
  const { decl, lines, start, containerStart, column } = context;
  if (anonymousNamespace(decl)) return false;
  if (topLevel(context)) {
    const previous = lines[start - 2] ?? '';
    // A declaration may put `static` alone on the line above its name.
    return !/^\s*static\b/.test(decl) && !/^\s*static\s*$/.test(previous.trimEnd());
  }
  // A provider that reports the anonymous namespace as a container gives us an
  // enclosing symbol to test. One that flattens it past us falls through to the
  // access scan, which lands on "visible" — the safe direction.
  if (anonymousNamespace(lines[containerStart - 1] ?? '')) return false;
  for (let index = start; index >= containerStart; index -= 1) {
    const text = index === start ? (lines[index - 1] ?? '').slice(0, column) : (lines[index - 1] ?? '');
    const label = ACCESS_LABEL.exec(text);
    if (label) return label[1] === 'public';
    const open = TYPE_OPENER.exec(text);
    // `class` defaults to private, `struct` and `union` to public.
    if (open) return open[1] !== 'class';
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
      : !/^[\s]*(?:(?:static|readonly|async|abstract|override|accessor)\s+)*(?:private|protected)\b/.test(context.decl)
        && !context.name.startsWith('#'),
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
    // An anonymous namespace is a boundary, not a grouping: its contents have
    // internal linkage, and cFamily already refuses it and everything under it.
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
