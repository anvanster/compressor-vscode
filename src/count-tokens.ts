import * as vscode from 'vscode';
import { cheapEstimator } from '@astudioplus/compressor';

// "Compressor: Count Tokens" — token count of the active editor, or the
// selection when one exists. Estimated via the cheap chars/3.5 estimator (the
// same one the read tool and ledger use): keeping js-tiktoken out of the bundle
// avoids ~5.6MB of inlined ranks. Honesty: chars are exact, tokens are
// estimated and never billable; the exact count_tokens API path stays CLI-only.

export interface CountResult {
  chars: number;
  estTokens: number;
  lines: number;
  scope: 'selection' | 'file';
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Pure count, unit-tested. */
export function countText(text: string, scope: CountResult['scope']): CountResult {
  return {
    chars: text.length,
    estTokens: cheapEstimator(text),
    lines: text === '' ? 0 : text.split('\n').length,
    scope,
  };
}

export function formatCount(result: CountResult): string {
  return (
    `Compressor: ${fmt(result.chars)} chars (exact), ` +
    `≈${fmt(result.estTokens)} tokens (estimated, chars/3.5 — not billable) · ` +
    `${fmt(result.lines)} lines · ${result.scope}`
  );
}

export function registerCountCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('compressor.countTokens', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      void vscode.window.showInformationMessage(
        'Compressor: open a file to count its tokens.',
      );
      return;
    }
    const selection = editor.selection;
    const hasSelection = selection !== undefined && !selection.isEmpty;
    const text = hasSelection ? editor.document.getText(selection) : editor.document.getText();
    void vscode.window.showInformationMessage(
      formatCount(countText(text, hasSelection ? 'selection' : 'file')),
    );
  });
}
