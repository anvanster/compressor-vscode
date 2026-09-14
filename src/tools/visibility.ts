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
  /** The declaration line, from the symbol's start column onward. */
  decl: string;
  /** 1-based line the declaration starts on. */
  start: number;
  /** 1-based line the enclosing symbol starts on; 0 at file scope. */
  containerStart: number;
  /** Start column of the declaration, 0-based. */
  column: number;
  /** Every line of the file. */
  lines: readonly string[];
}

type Rule = (context: VisibilityContext) => boolean;

const topLevel = (context: VisibilityContext): boolean => context.containerStart === 0;

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

const RULES: Record<string, Rule> = {
  // `export` only ever appears at file scope; members are public unless the
  // declaration says otherwise, including the `#private` field syntax.
  ts: (context) => topLevel(context)
    ? /^export\b/.test(context.decl)
    : !/^[\s]*(?:(?:static|readonly|async|abstract|override|accessor)\s+)*(?:private|protected)\b/.test(context.decl)
      && !context.name.startsWith('#'),
  // `pub`, including `pub(crate)`: both reach another file, which is what the
  // mark claims. Works unchanged on struct fields and `impl` items.
  rs: (context) => /^pub\b/.test(context.decl),
  // Exported identifiers are capitalised, at every depth including fields.
  go: (context) => /^[A-Z]/.test(context.name),
  // The leading-underscore convention, which applies to members too.
  py: (context) => !context.name.startsWith('_'),
  // Java package-private and C# internal are both the unmarked default.
  java: (context) => /^(?:[\w@[\]]+\s+)*?public\b/.test(context.decl),
  c: cFamily,
};

const BY_EXTENSION: Record<string, keyof typeof RULES> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  rs: 'rs',
  go: 'go',
  py: 'py', pyi: 'py',
  java: 'java', cs: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', 'c++': 'c',
  hpp: 'c', hh: 'c', hxx: 'c', 'h++': 'c', ipp: 'c', inl: 'c', cu: 'c', cuh: 'c',
};

/**
 * The rule for a path, or undefined when the language is not one of the above.
 * Callers mark nothing rather than guessing when this returns undefined.
 */
export function visibilityRule(filePath: string): Rule | undefined {
  const extension = filePath.toLowerCase().split('.').pop();
  const key = extension === undefined ? undefined : BY_EXTENSION[extension];
  return key === undefined ? undefined : RULES[key];
}
