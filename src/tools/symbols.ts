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

const LEGEND =
  '* = visible outside this file or its class; unmarked names are internal to it, so do not list them as its API. ';

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
 */
export function exportLegend(formatted: string): string {
  return /^\*/m.test(formatted) ? LEGEND : '';
}

/**
 * The legend is spliced into a preamble before the budget cap runs, so a file
 * whose marked declarations all sit below the cut ships the sentence with
 * nothing for it to explain — and "unmarked names are internal" then reads as
 * "this file exports nothing". Drop it from whatever text is actually
 * returned, which only ever shortens it.
 */
export function withoutDeadLegend(text: string): string {
  return /^\*/m.test(text) ? text : text.replace(LEGEND, '');
}

/**
 * Names the rule calls visible, in the order they appear. Visibility is
 * inherited: a public method of a class the file never exports is no more
 * reachable from outside than the class is, so a symbol is listed only when
 * every enclosing symbol is listed too.
 */
function visibleNames(
  symbols: readonly CodeSymbol[], source: SymbolSource,
): Set<string> {
  const rule = visibilityRule(source.path);
  const visible = new Set<string>();
  if (rule === undefined) return visible;
  // A grouping borrows the reach of the type it names, so a file-scope type
  // the rule already rejected closes the group with it.
  const rejected = new Set<string>();
  const walk = (
    nodes: readonly CodeSymbol[], parent: string, containerStart: number,
    implicitFrom?: vscode.SymbolKind,
  ): void => {
    for (const symbol of nodes) {
      const name = parent ? `${parent}.${symbol.name}` : symbol.name;
      const line = source.lines[symbol.declLine - 1];
      if (line === undefined) continue;
      // The whole line: a keyword like `export` or `static` sits to the left of
      // the name, so slicing at the name's column would discard it.
      const decl = line.trim();
      const container = { kind: symbol.kind, decl };
      const scope = rule.scope(container);
      if (scope === 'group') {
        const subject = rule.subject?.(container);
        if (subject === undefined || !rejected.has(subject)) walk(symbol.children, name, 0);
        continue;
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
      if (!ok) {
        // an invisible container hides everything under it
        if (parent === '' && scope !== undefined) rejected.add(symbol.name);
        continue;
      }
      visible.add(name);
      if (scope !== undefined) {
        walk(
          symbol.children, name, scope === 'file' ? 0 : symbol.declLine,
          scope === 'implicit' ? symbol.kind : undefined,
        );
      }
    }
  };
  walk(symbols, '', 0);
  return visible;
}

export function formatSymbols(symbols: readonly CodeSymbol[], source?: SymbolSource): string {
  const visible = source === undefined ? new Set<string>() : visibleNames(symbols, source);
  return flattenSymbols(symbols).map((symbol) =>
    `${visible.has(symbol.name) ? '*' : ''}${symbol.name}${symbol.detail ? ` ${symbol.detail}` : ''} [lines ${symbol.start}-${symbol.end}; offset=${symbol.start} limit=${symbol.end - symbol.start + 1}]`,
  ).join('\n');
}
