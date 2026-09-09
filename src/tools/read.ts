import * as vscode from 'vscode';
import { readWorkspaceFile, containsPath } from './workspace-file';
import path from 'node:path';
import {
  OMISSION_MARKER,
  appendLedger,
  cheapEstimator,
} from '@astudioplus/compressor';
import type { Mode } from '@astudioplus/compressor';
import { readCandidate, selectOutput, fitOutput } from './output-policy';
import type { OutputHints } from './output-policy';
import { documentSymbols, flattenSymbols } from './symbols';
import type { CodeSymbol } from './symbols';
import { measureOperation } from '../operation-metrics';

// The compressor_read languageModelTools tool: a file read that runs the
// compressor engine in-process before the content reaches the model. Honesty
// rules apply: omissions always carry a recoverable [compressor:] marker, the
// ledger records estimated token figures only, and nothing leaves the machine.

export interface ReadToolInput {
  path: string;
  symbol?: string;
  /** 1-based start line for an exact uncompressed range */
  offset?: number;
  /** line count for the exact range */
  limit?: number;
}

/** Injectable seams so the handler is unit-testable without an extension host. */
export interface ReadToolDeps extends OutputHints {
  /** absolute fsPaths of the open workspace folders (privacy boundary) */
  workspaceFolders: readonly string[];
  /** compressor.mode setting, already normalized */
  mode: Mode;
  readFile?: (absPath: string) => Promise<string>;
  symbols?: (file: string) => Promise<CodeSymbol[]>;
}

export interface ReadToolOutcome {
  text: string;
  /** true when the text is an error message, not file content */
  isError: boolean;
  /** true when the compressed form was returned (and a ledger event fired) */
  compressed: boolean;
}

export function normalizeMode(value: unknown): Mode {
  return value === 'full' || value === 'slim' ? value : 'optimized';
}

/**
 * Resolve the requested path inside the workspace. Relative paths resolve
 * against each folder (first existing wins is unnecessary — resolution is
 * purely lexical; the first folder is the default). Absolute paths must lie
 * inside SOME workspace folder: the tool must not become a read primitive for
 * arbitrary filesystem locations.
 */
export function resolveWorkspacePath(
  requested: string,
  folders: readonly string[],
): { absPath: string } | { error: string } {
  if (folders.length === 0) {
    return { error: 'compressor_read: no workspace folder open' };
  }
  const candidate = path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.normalize(path.join(folders[0] ?? '', requested));
  const inside = folders.some((folder) => {
    const rel = path.relative(folder, candidate);
    return rel !== '' && containsPath(folder, candidate);
  });
  if (!inside) {
    return {
      error:
        `compressor_read: ${requested} is outside the open workspace folder(s) — ` +
        'this tool only reads files inside the workspace',
    };
  }
  return { absPath: candidate };
}

/** Claude-Read-style numbering the engine's code tier recognizes: '   123→text'. */
export function numberLines(lines: readonly string[], startLine: number): string {
  return lines
    .map((text, i) => `${String(startLine + i).padStart(6)}→${text}`)
    .join('\n');
}

/**
 * The hook's worthwhile floor (src/hook/core.ts in the library — compressCall
 * is not exported from the package root, so the floor is replicated here):
 * below 200 saved chars or 10% of the input, the rewrite is noise. Saved chars
 * include the complete returned marker text.
 */
export const MIN_SAVED_CHARS = 200;
export const MIN_SAVED_RATIO = 0.1;

export function lengthSansMarkers(text: string): number {
  if (!text.includes(OMISSION_MARKER)) {
    return text.length;
  }
  return text
    .split('\n')
    .filter((line) => !line.includes(OMISSION_MARKER))
    .join('\n').length;
}

/** Pure-ish handler (fs injected); the vscode layer only adapts types. */
export async function runReadTool(
  input: ReadToolInput,
  deps: ReadToolDeps,
): Promise<ReadToolOutcome> {
  try {
    if (typeof input.path !== 'string' || input.path === '') {
      return { text: 'compressor_read: a file path is required', isError: true, compressed: false };
    }
    const resolved = resolveWorkspacePath(input.path, deps.workspaceFolders);
    if ('error' in resolved) {
      return { text: resolved.error, isError: true, compressed: false };
    }
    const read = deps.readFile ?? ((file: string) => readWorkspaceFile(file, deps.workspaceFolders));
    let raw: string;
    try {
      raw = await read(resolved.absPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: `compressor_read: cannot read ${input.path}: ${reason}`, isError: true, compressed: false };
    }

    const allLines = raw.split('\n');
    // drop a trailing empty segment from a final newline (cat -n parity)
    if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    if (deps.cancelled?.()) throw new Error('Operation cancelled');
    if (input.symbol !== undefined) {
      if (input.offset !== undefined || input.limit !== undefined) throw new Error('Use symbol or offset/limit, not both');
      const symbols = flattenSymbols(await (deps.symbols ?? documentSymbols)(resolved.absPath));
      const matches = symbols.filter((symbol) => symbol.name === input.symbol || symbol.name.endsWith(`.${input.symbol}`));
      if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous symbol; use its qualified name or exact line range' : 'Symbol not found; use an exact line range');
      const match = matches[0]!;
      input = { path: input.path, offset: match.start, limit: match.end - match.start + 1 };
    }
    for (const value of [input.offset, input.limit]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error('offset and limit must be positive integers');
    }
    const targeted = input.offset !== undefined || input.limit !== undefined;
    const start = Math.max(1, Math.floor(input.offset ?? 1));
    const count =
      input.limit === undefined ? allLines.length : Math.max(0, Math.floor(input.limit));
    const slice = targeted ? allLines.slice(start - 1, start - 1 + count) : allLines;
    const numbered = numberLines(slice, targeted ? start : 1);

    const candidate = targeted ? numbered : readCandidate(allLines, resolved.absPath, deps.mode, false);
    const bounded = targeted || deps.mode === 'full' ? candidate : await fitOutput(candidate, deps, 'use compressor_read with offset/limit for required original lines, or compressor_outline');
    const content = await selectOutput(numbered, bounded || candidate, deps);
    const transforms = content === numbered ? [] : [{ id: content === candidate ? 'numbered-dedupe' : 'host-budget' }];
    const result = { content, stats: { estTokensIn: cheapEstimator(numbered), estTokensOut: cheapEstimator(content), transforms } };

    const saved = numbered.length - result.content.length;
    const worthwhile =
      saved >= MIN_SAVED_CHARS && saved >= numbered.length * MIN_SAVED_RATIO;
    if (!worthwhile) {
      return { text: numbered, isError: false, compressed: false };
    }

    // fire-and-forget, fail-open: the ledger must never break the tool call
    void appendLedger({
      ts: new Date().toISOString(),
      agent: 'vscode',
      tool: 'read',
      mode: deps.mode,
      charsIn: numbered.length,
      charsOut: result.content.length,
      estTokensIn: result.stats.estTokensIn,
      estTokensOut: result.stats.estTokensOut,
      transforms: result.stats.transforms.map((t) => t.id),
    }).catch(() => {});

    return { text: result.content, isError: false, compressed: true };
  } catch (error) {
    // never throw raw out of a tool invocation
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `compressor_read failed: ${reason}`, isError: true, compressed: false };
  }
}

function depsFromVscode(): ReadToolDeps {
  return {
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    mode: normalizeMode(vscode.workspace.getConfiguration('compressor').get('mode')),
  };
}

export function registerReadTool(): vscode.Disposable {
  return vscode.lm.registerTool<ReadToolInput>('compressor_read', {
    prepareInvocation(options) {
      return {
        invocationMessage: `Reading ${options.input.path} (compressed)`,
      };
    },
    async invoke(options, token) {
      const outcome = await measureOperation('read', options.input.symbol !== undefined || options.input.offset !== undefined || options.input.limit !== undefined, () => runReadTool(options.input, {
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
