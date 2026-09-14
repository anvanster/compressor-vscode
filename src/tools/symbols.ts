import * as vscode from 'vscode';
import { visibilityRule } from './visibility';

export interface CodeSymbol {
  name: string;
  detail: string;
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
  return /^\*/m.test(formatted)
    ? '* = visible outside this file or its class; unmarked names are internal to it, so do not list them as its API. '
    : '';
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
  const walk = (nodes: readonly CodeSymbol[], parent: string, containerStart: number): void => {
    for (const symbol of nodes) {
      const name = parent ? `${parent}.${symbol.name}` : symbol.name;
      const line = source.lines[symbol.declLine - 1];
      const ok = line !== undefined && rule({
        name: symbol.name,
        // The whole line: a keyword like `export` or `static` sits to the left
        // of the name, so slicing at the name's column would discard it.
        decl: line.trim(),
        start: symbol.declLine,
        containerStart,
        column: symbol.column,
        lines: source.lines,
      });
      if (ok) visible.add(name);
      // An invisible container hides everything under it, so stop descending.
      if (ok) walk(symbol.children, name, symbol.declLine);
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
