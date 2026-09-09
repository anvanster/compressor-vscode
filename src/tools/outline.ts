import * as vscode from 'vscode';
import { readWorkspaceFile } from './workspace-file';
import {
  appendLedger,
  cheapEstimator,
  langFromPath,
  skeleton,
} from '@astudioplus/compressor';
import type { CompressMeta } from '@astudioplus/compressor';
import { normalizeMode, numberLines, resolveWorkspacePath } from './read';
import type { ReadToolDeps } from './read';
import { documentSymbols, formatSymbols } from './symbols';
import type { CodeSymbol } from './symbols';
import { selectOutput, fitOutput } from './output-policy';
import { measureOperation } from '../operation-metrics';

// The compressor_outline languageModelTools tool: returns a code file's
// structure — top-level imports and signatures — with the bodies collapsed
// into recoverable [compressor: … offset/limit] markers. Backed by the engine
// skeleton tier (ts-js, rust, python, go; other languages have no signature
// model and the tool says so rather than dumping the whole file). Honesty
// rules match compressor_read: line numbers preserved, ledger records
// estimated figures only, nothing leaves the machine.

export interface OutlineToolInput {
  path: string;
}

export interface OutlineToolOutcome {
  text: string;
  isError: boolean;
  /** true when a smaller outline was returned (and a ledger event fired) */
  outlined: boolean;
}

/** Pure-ish handler (fs injected); the vscode layer only adapts types. */
export async function runOutlineTool(
  input: OutlineToolInput,
  deps: ReadToolDeps,
): Promise<OutlineToolOutcome> {
  try {
    if (typeof input.path !== 'string' || input.path === '') {
      return { text: 'compressor_outline: a file path is required', isError: true, outlined: false };
    }
    const resolved = resolveWorkspacePath(input.path, deps.workspaceFolders);
    if ('error' in resolved) {
      return { text: resolved.error.replace('compressor_read', 'compressor_outline'), isError: true, outlined: false };
    }
    const lang = langFromPath(resolved.absPath);
    if (lang === undefined && deps.symbols === undefined && deps.readFile !== undefined) {
      return {
        text: `compressor_outline: no outline for this file type — use compressor_read for ${input.path}`,
        isError: false,
        outlined: false,
      };
    }
    const read = deps.readFile ?? ((file: string) => readWorkspaceFile(file, deps.workspaceFolders));
    let raw: string;
    try {
      raw = await read(resolved.absPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: `compressor_outline: cannot read ${input.path}: ${reason}`, isError: true, outlined: false };
    }

    const allLines = raw.split('\n');
    if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const numbered = numberLines(allLines, 1);
    if (deps.cancelled?.()) throw new Error('Operation cancelled');
    let symbols: CodeSymbol[];
    try { symbols = await (deps.symbols ?? (deps.readFile ? async () => [] : documentSymbols))(resolved.absPath); }
    catch { symbols = []; }
    if (symbols.length > 0) {
      const formatted = formatSymbols(symbols);
      const candidate = await fitOutput(formatted, deps, 'use compressor_read with offset/limit to inspect the remaining source') || formatted;
      const content = await selectOutput(numbered, candidate, deps);
      if (content !== numbered) {
        void appendLedger({
          ts: new Date().toISOString(), agent: 'vscode', tool: 'read', mode: deps.mode,
          charsIn: numbered.length, charsOut: content.length,
          estTokensIn: cheapEstimator(numbered), estTokensOut: cheapEstimator(content),
          transforms: ['symbol-outline'],
        }).catch(() => {});
      }
      return { text: content, isError: false, outlined: content !== numbered };
    }
    if (lang === undefined) return { text: 'No symbol provider available; use compressor_read with an exact range.', isError: false, outlined: false };

    const meta: CompressMeta = {
      tool: 'read',
      mode: deps.mode,
      filePath: resolved.absPath,
      targeted: false,
    };
    const result = skeleton(numbered, lang, meta, cheapEstimator);
    if (result.content !== numbered && await selectOutput(numbered, result.content, deps) === numbered) {
      return { text: numbered, isError: false, outlined: false };
    }
    if (result.content === numbered || result.transform === undefined) {
      // signature model exists but produced no collapse (tiny file, or all
      // top-level declarations) — the full numbered file IS the outline
      return {
        text: `compressor_outline: ${input.path} is already all signatures — full file below\n${numbered}`,
        isError: false,
        outlined: false,
      };
    }

    void appendLedger({
      ts: new Date().toISOString(),
      agent: 'vscode',
      tool: 'read',
      mode: deps.mode,
      charsIn: numbered.length,
      charsOut: result.content.length,
      estTokensIn: cheapEstimator(numbered),
      estTokensOut: cheapEstimator(result.content),
      transforms: [result.transform.id],
    }).catch(() => {});

    return { text: result.content, isError: false, outlined: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `compressor_outline failed: ${reason}`, isError: true, outlined: false };
  }
}

function depsFromVscode(): ReadToolDeps {
  return {
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    mode: normalizeMode(vscode.workspace.getConfiguration('compressor').get('mode')),
  };
}

export function registerOutlineTool(): vscode.Disposable {
  return vscode.lm.registerTool<OutlineToolInput>('compressor_outline', {
    prepareInvocation(options) {
      return { invocationMessage: `Outlining ${options.input.path}` };
    },
    async invoke(options, token) {
      const outcome = await measureOperation('outline', false, () => runOutlineTool(options.input, {
        ...depsFromVscode(),
        tokenBudget: options.tokenizationOptions?.tokenBudget,
        countTokens: options.tokenizationOptions ? (text) => options.tokenizationOptions!.countTokens(text, token) : undefined,
        cancelled: () => token.isCancellationRequested,
      }), (result) => result);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(outcome.text),
      ]);
    },
  });
}
