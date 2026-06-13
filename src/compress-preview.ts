import * as vscode from 'vscode';
import { cheapEstimator, compress, policyFor } from '@astudioplus/compressor';
import type { CompressMeta, Mode } from '@astudioplus/compressor';
import {
  MIN_SAVED_CHARS,
  MIN_SAVED_RATIO,
  lengthSansMarkers,
  normalizeMode,
  numberLines,
} from './tools/read';

// "Compressor: Preview Compression" — runs the engine over the active editor
// (or selection) exactly as the compressor_read tool would (same numbering,
// mode, and worthwhile floor) and opens a side-by-side diff: numbered original
// vs compressed. A safe way to see and tune what the engine does, with no file
// writes. Honesty: omissions carry recoverable [compressor:] markers; saved
// chars are exact (marker-exclusive), token figures elsewhere are estimates.

export interface CompressionPreview {
  numberedOriginal: string;
  compressed: string;
  /** marker-exclusive saved chars, mirroring the hook/read-tool measurement */
  savedChars: number;
  /** clears the same floor the read tool uses (≥200 chars AND ≥10%) */
  worthwhile: boolean;
  transforms: string[];
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Pure preview, unit-tested. mode 'full' yields a no-op (savedChars 0). */
export function previewCompression(
  raw: string,
  mode: Mode,
  filePath?: string,
): CompressionPreview {
  const lines = raw.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop(); // drop the trailing empty segment from a final newline (cat -n parity)
  }
  const numbered = numberLines(lines, 1);
  const meta: CompressMeta = { tool: 'read', mode, filePath, targeted: false };
  const result = compress(numbered, meta, policyFor(mode), cheapEstimator);
  const saved = numbered.length - lengthSansMarkers(result.content);
  return {
    numberedOriginal: numbered,
    compressed: result.content,
    savedChars: saved,
    worthwhile: saved >= MIN_SAVED_CHARS && saved >= numbered.length * MIN_SAVED_RATIO,
    transforms: result.stats.transforms.map((t) => t.id),
  };
}

export function previewTitle(mode: Mode, preview: CompressionPreview): string {
  const note = preview.worthwhile
    ? `saved ≈${fmt(preview.savedChars)} chars (exact)`
    : `≈${fmt(preview.savedChars)} chars — below the floor; compressor_read returns this unchanged`;
  return `Compressor preview (${mode}) — ${note}`;
}

export function registerCompressSelectionCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('compressor.compressSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      void vscode.window.showInformationMessage(
        'Compressor: open a file to preview compression.',
      );
      return;
    }
    const selection = editor.selection;
    const text =
      selection !== undefined && !selection.isEmpty
        ? editor.document.getText(selection)
        : editor.document.getText();
    if (text.trim() === '') {
      void vscode.window.showInformationMessage('Compressor: nothing to compress.');
      return;
    }
    const mode = normalizeMode(
      vscode.workspace.getConfiguration('compressor').get('mode'),
    );
    if (mode === 'full') {
      void vscode.window.showInformationMessage(
        "Compressor: mode is 'full' (compression off) — set 'optimized' or 'slim' to preview.",
      );
      return;
    }
    const preview = previewCompression(text, mode, editor.document.uri.fsPath);
    const language = editor.document.languageId;
    const left = await vscode.workspace.openTextDocument({
      content: preview.numberedOriginal,
      language,
    });
    const right = await vscode.workspace.openTextDocument({
      content: preview.compressed,
      language,
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      left.uri,
      right.uri,
      previewTitle(mode, preview),
    );
  });
}
