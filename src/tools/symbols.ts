import * as vscode from 'vscode';
import { implicitlyVisible, visibilityRule } from './visibility';

export interface CodeSymbol {
  name: string;
  detail: string;
  /**
   * What the provider says this symbol is. Only the kind decides whether the
   * symbols nested under it are declared members or function locals, and no
   * visibility rule can tell the two apart from the declaration line alone.
   */
  kind: vscode.SymbolKind;
  /** 1-based first line of the symbol, comments included: the range to read. */
  start: number;
  end: number;
  /**
   * 1-based line the name sits on. `range` deliberately covers "everything
   * else, e.g. comments and code", so for a documented symbol `start` is the
   * line of its opening comment, not of its declaration. Reading visibility
   * off `start` marks nothing in a commented file.
   */
  declLine: number;
  /** Column of the name within declLine, 0-based. */
  column: number;
  children: CodeSymbol[];
}

/** A symbol lifted out of the tree, keeping where its enclosing symbol began. */
export interface FlatSymbol extends CodeSymbol {
  /** 1-based start line of the enclosing symbol; 0 at file scope. */
  containerStart: number;
}

export async function documentSymbols(file: string): Promise<CodeSymbol[]> {
  const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
    'vscode.executeDocumentSymbolProvider', vscode.Uri.file(file),
  );
  const convert = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation): CodeSymbol => {
    const range = 'range' in symbol ? symbol.range : symbol.location.range;
    // SymbolInformation carries no selectionRange; its range is all there is.
    const name = 'selectionRange' in symbol ? symbol.selectionRange.start : range.start;
    return {
      name: symbol.name,
      detail: 'detail' in symbol ? symbol.detail : '',
      kind: symbol.kind,
      start: range.start.line + 1,
      end: range.end.line + 1,
      declLine: name.line + 1,
      column: name.character,
      children: 'children' in symbol ? symbol.children.map(convert) : [],
    };
  };
  return (result ?? []).map(convert);
}

export function flattenSymbols(
  symbols: readonly CodeSymbol[], parent = '', containerStart = 0,
): FlatSymbol[] {
  return symbols.flatMap((symbol) => {
    const name = parent ? `${parent}.${symbol.name}` : symbol.name;
    return [
      { ...symbol, name, containerStart },
      ...flattenSymbols(symbol.children, name, symbol.start),
    ];
  });
}

/** The file a symbol list came from, so visibility can be read off its lines. */
export interface SymbolSource {
  path: string;
  lines: readonly string[];
}

const MARK_MEANS = '* = visible outside this file or its class. ';
const UNMARKED_MEANS = 'Unmarked names are internal to it, so do not list them as its API. ';

/** A symbol listing, and whether a rule reached every symbol in it. */
export interface SymbolListing {
  /** One line per symbol, marked where a rule found it visible. */
  text: string;
  /**
   * true when a rule produced a verdict for every symbol listed. When false,
   * an unmarked name may simply be one no rule could judge, so nothing can be
   * concluded from the absence of a mark.
   */
  complete: boolean;
}

/**
 * One sentence for the preamble explaining the `*` in formatted output, or ''
 * when that output carries no mark. Stating what the mark means is the point:
 * an unexplained sigil is one more thing for a model to guess at, and a model
 * shown correct marks still listed four unmarked symbols as module API, so the
 * sentence states the consequence rather than only the meaning. The caveat it
 * used to carry — that a one-line read under-marks — lives in the agent file,
 * which is where nuance belongs; output that is read once needs an
 * instruction. Taking the
 * formatted text rather than the language keeps the two in step — the sentence
 * costs budget that a structure listing needs, so it is never spent on a
 * legend for a mark that does not appear.
 *
 * What an unmarked name means is a second claim, and only a listing every rule
 * reached can support it. A C++ header lists members no rule judged, so there
 * the legend says what `*` means and stops.
 */
export function exportLegend(listing: SymbolListing): string {
  if (!/^\*/m.test(listing.text)) return '';
  return listing.complete ? MARK_MEANS + UNMARKED_MEANS : MARK_MEANS;
}

/**
 * Every symbol the provider reported, one per line, marked with `*` where the
 * language's rule calls it visible. Visibility is inherited: a public method of
 * a class the file never exports is no more reachable from outside than the
 * class is, so a symbol is marked only when every enclosing symbol is. Without
 * a source, or in a language with no rule, nothing is marked.
 */
export function formatSymbols(symbols: readonly CodeSymbol[], source?: SymbolSource): SymbolListing {
  let complete = true;
  const entry = (symbol: CodeSymbol, name: string, visible: boolean): string =>
    `${visible ? '*' : ''}${name}${symbol.detail ? ` ${symbol.detail}` : ''} [lines ${symbol.start}-${symbol.end}; offset=${symbol.start} limit=${symbol.end - symbol.start + 1}]`;

  // Two symbols can share a qualified name — a C++ overload set reports the
  // signature in `detail`, not in `name` — so the decision has to travel with
  // the symbol it was made for. Deciding here, in the walk that flattens,
  // leaves nothing to look a name up in.
  const listed = (nodes: readonly CodeSymbol[], parent: string): string[] =>
    nodes.flatMap((symbol) => {
      const name = parent ? `${parent}.${symbol.name}` : symbol.name;
      return [entry(symbol, name, false), ...listed(symbol.children, name)];
    });

  const rule = source === undefined ? undefined : visibilityRule(source.path);
  if (rule === undefined || source === undefined) {
    return { text: listed(symbols, '').join('\n'), complete: false };
  }

  const walk = (
    nodes: readonly CodeSymbol[], parent: string, containerStart: number,
    implicitFrom?: vscode.SymbolKind,
  ): string[] => nodes.flatMap((symbol) => {
    const name = parent ? `${parent}.${symbol.name}` : symbol.name;
    const line = source.lines[symbol.declLine - 1];
    if (line === undefined) {
      complete = false;
      return [entry(symbol, name, false), ...listed(symbol.children, name)];
    }
    // The whole line: a keyword like `export` or `static` sits to the left of
    // the name, so slicing at the name's column would discard it.
    const decl = line.trim();
    const container = { kind: symbol.kind, decl };
    const scope = rule.scope(container);
    if (scope === 'group') {
      return [entry(symbol, name, false), ...walk(symbol.children, name, 0)];
    }
    const context = {
      name: symbol.name,
      decl,
      start: symbol.declLine,
      containerStart,
      column: symbol.column,
      lines: source.lines,
    };
    // An enum grants its constants default visibility and nothing else: its
    // fields, constructors and methods are ordinary class members.
    const implicit = implicitFrom !== undefined
      && (implicitFrom !== vscode.SymbolKind.Enum || symbol.kind === vscode.SymbolKind.EnumMember);
    const ok = implicit ? implicitlyVisible(context) : rule.visible(context);
    // an invisible container hides everything under it — a verdict of its own
    if (!ok) return [entry(symbol, name, false), ...listed(symbol.children, name)];
    // `undefined` is not a container: what it declares are locals, which no
    // rule needs to reach. `unevaluated` is a container whose members no rule
    // can judge, which the listing has to own up to.
    if (scope === 'unevaluated' && symbol.children.length > 0) complete = false;
    return [
      entry(symbol, name, true),
      ...(scope === undefined || scope === 'unevaluated'
        ? listed(symbol.children, name)
        : walk(
          symbol.children, name, scope === 'file' ? 0 : symbol.declLine,
          scope === 'implicit' ? symbol.kind : undefined,
        )),
    ];
  });

  const text = walk(symbols, '', 0).join('\n');
  return { text, complete };
}
