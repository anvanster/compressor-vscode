import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import {
  appendLedger,
  cheapEstimator,
  langFromPath,
  skeleton,
} from '@astudioplus/compressor';
import type { CompressMeta } from '@astudioplus/compressor';
import { normalizeMode, numberLines, resolveWorkspacePath } from './read';
import type { ReadToolDeps } from './read';

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
    if (lang === undefined) {
      return {
        text: `compressor_outline: no outline for this file type — use compressor_read for ${input.path}`,
        isError: false,
        outlined: false,
      };
    }
    const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
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

    const meta: CompressMeta = {
      tool: 'read',
      mode: deps.mode,
      filePath: resolved.absPath,
      targeted: false,
    };
    const result = skeleton(numbered, lang, meta, cheapEstimator);
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
    async invoke(options) {
      const outcome = await runOutlineTool(options.input, depsFromVscode());
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(outcome.text),
      ]);
    },
  });
}
