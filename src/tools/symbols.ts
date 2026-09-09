import * as vscode from 'vscode';

export interface CodeSymbol {
  name: string;
  detail: string;
  start: number;
  end: number;
  children: CodeSymbol[];
}

export async function documentSymbols(file: string): Promise<CodeSymbol[]> {
  const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
    'vscode.executeDocumentSymbolProvider', vscode.Uri.file(file),
  );
  const convert = (symbol: vscode.DocumentSymbol | vscode.SymbolInformation): CodeSymbol => {
    const range = 'range' in symbol ? symbol.range : symbol.location.range;
    return {
      name: symbol.name,
      detail: 'detail' in symbol ? symbol.detail : '',
      start: range.start.line + 1,
      end: range.end.line + 1,
      children: 'children' in symbol ? symbol.children.map(convert) : [],
    };
  };
  return (result ?? []).map(convert);
}

export function flattenSymbols(symbols: readonly CodeSymbol[], parent = ''): CodeSymbol[] {
  return symbols.flatMap((symbol) => {
    const name = parent ? `${parent}.${symbol.name}` : symbol.name;
    return [{ ...symbol, name }, ...flattenSymbols(symbol.children, name)];
  });
}

export function formatSymbols(symbols: readonly CodeSymbol[]): string {
  return flattenSymbols(symbols).map((symbol) =>
    `${symbol.name}${symbol.detail ? ` ${symbol.detail}` : ''} [lines ${symbol.start}-${symbol.end}; offset=${symbol.start} limit=${symbol.end - symbol.start + 1}]`,
  ).join('\n');
}