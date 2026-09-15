import * as vscode from 'vscode';
import { readWorkspaceFile, containsPath, isChatSessionResource } from './workspace-file';
import path from 'node:path';
import {
  OMISSION_MARKER,
  cheapEstimator,
} from '@astudioplus/compressor';
import { recordEvent } from '../ledger';
import type { Mode } from '@astudioplus/compressor';
import { effectiveBudget, readCandidate, selectOutput, fitOutput, tokenCounter } from './output-policy';
import type { OutputHints } from './output-policy';
import { documentSymbols, exportLegend, flattenSymbols, formatSymbols } from './symbols';
import type { CodeSymbol } from './symbols';
import { measureOperation } from '../operation-metrics';

// The compressor_read languageModelTools tool: a file read that runs the
// compressor engine in-process before the content reaches the model. Honesty
// rules apply: omissions always carry a recoverable [compressor:] marker, the
// ledger records estimated token figures only, and nothing leaves the machine.

export interface ReadToolInput {
  path: string;
  symbol?: string;
  /** 1-based start line for a verbatim range; the range still stops at the budget */
  offset?: number;
  /** line count for the verbatim range */
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
  /** true when a reduced form was returned instead of the full numbered text */
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
  // a spilled tool result: our own output, handed back by VS Code
  if (isChatSessionResource(candidate)) return { absPath: candidate };
  // A workspace root is inside the workspace. Excluding it here reported the
  // root, and `.`, as "outside the open workspace folder(s)" — which a model
  // reasonably reads as "this tool cannot see my project", and then answers
  // from filenames instead of calling the tool again. Directories are rejected
  // further down, by the check that knows they are directories.
  const inside = folders.some((folder) => containsPath(folder, candidate));
  if (!inside) {
    return {
      error:
        `compressor_read: ${requested} is outside the open workspace folder(s) — ` +
        'this tool reads files inside the workspace, plus tool results VS Code has ' +
        'spilled to its own chat-session-resources folder',
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

/**
 * When the whole file will not fit, degrade by LEVEL OF DETAIL rather than by
 * cutting the content in half.
 *
 * A truncated prefix loses both ways: a weaker model describes the part it
 * never received, and a stronger one notices the gap and re-reads the file by
 * other means, spending more than if nothing had been compressed. A complete
 * list of declarations has neither failure. Nothing is missing from it at its
 * own level, so there is no symbol to invent and no reason to re-read — the
 * next step is one named range. Measured 84-93% smaller than the source.
 */
export async function completeStructure(
  absPath: string,
  requested: string,
  deps: ReadToolDeps,
  lines: readonly string[],
): Promise<string | undefined> {
  let symbols: CodeSymbol[];
  try {
    symbols = await (deps.symbols ?? documentSymbols)(absPath);
  } catch {
    return undefined;
  }
  if (symbols.length === 0) return undefined;
  const body = formatSymbols(symbols, { path: absPath, lines });
  return `[compressor: ${requested} does not fit the budget. COMPLETE list of its ` +
    'declarations follows: every symbol the language provider reported for the file is here, ' +
    'nothing dropped to fit the budget. ' + exportLegend(body) +
    'Bodies are not included — read one with ' +
    `compressor_read ${requested} offset=N limit=M.]\n` +
    body.text;
}

/**
 * A range that stops short of the end of the file looks exactly like the whole
 * file: nothing in the output says otherwise, so a model that reads the first
 * N lines goes on to describe declarations it never saw. State what was shown
 * out of what exists, and where to continue.
 */
export function rangeNote(start: number, shown: number, total: number): string {
  if (shown <= 0) return '';
  const end = start + shown - 1;
  if (start <= 1 && end >= total) return ''; // the whole file was returned
  const next = end + 1;
  // Only a range that starts at the top is a sample of the file, where reading
  // on is the natural next step. A mid-file or symbol range was asked for
  // deliberately, and "continue with" there just invites a read nobody needed.
  const shouldContinue = start <= 1 && next <= total;
  return `[compressor: showing lines ${start}-${Math.min(end, total)} of ${total}` +
    (shouldContinue ? `; continue with offset=${next}]` : ']');
}

/**
 * A budget-trimmed read that does not say where it stopped is unrecoverable:
 * the model cannot tell which lines it is missing, so it re-reads the file by
 * other means and the saving is spent again immediately. Line numbers are
 * preserved, so the resume point is known — name it, the way search names
 * `skip=`. The rewrite is kept no longer than the marker it replaces, so the
 * output still fits the budget it was just trimmed to.
 */
/** The highest line number still present in numbered output. */
export function lastNumberedLine(text: string): number | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const numbered = /^\s*(\d+)→/.exec(lines[index] ?? '');
    if (numbered !== null) return Number(numbered[1]);
  }
  return undefined;
}

export function withResumePoint(trimmed: string, tail = 'or compressor_outline for the shape of the rest'): string {
  const lines = trimmed.split('\n');
  const marker = lines.findIndex((line) => line.startsWith('[compressor: partial output;'));
  if (marker < 0) return trimmed;
  for (let index = marker - 1; index >= 0; index -= 1) {
    const numbered = /^\s*(\d+)→/.exec(lines[index] ?? '');
    if (numbered === null) continue;
    const replacement =
      `[compressor: partial output; continue with offset=${Number(numbered[1]) + 1}, ${tail}]`;
    if (replacement.length > (lines[marker] ?? '').length) return trimmed;
    lines[marker] = replacement;
    return lines.join('\n');
  }
  return trimmed;
}

/**
 * A failed read is a dead end unless the model can see what to try instead, and
 * raw ENOENT text (which also echoes the resolved absolute path) tells it
 * nothing useful. The common miss is prefixing the workspace folder's own name,
 * so when dropping the first segment resolves to a real file, name it.
 */
export async function readFailure(
  requested: string,
  reason: string,
  folders: readonly string[],
  read: (absPath: string) => Promise<string>,
): Promise<string> {
  if (!reason.includes('ENOENT')) {
    return `compressor_read: cannot read ${requested}: ${reason}`;
  }
  const segments = requested.split('/').filter((segment) => segment !== '');
  if (segments.length > 1) {
    const without = segments.slice(1).join('/');
    const alternative = resolveWorkspacePath(without, folders);
    if (!('error' in alternative)) {
      try {
        await read(alternative.absPath);
        return `compressor_read: ${requested} not found — did you mean ${without}? ` +
          'Paths are relative to the workspace folder, so the folder\'s own name is not part of them.';
      } catch {
        // no better suggestion to offer; fall through to the plain message
      }
    }
  }
  return `compressor_read: ${requested} not found in the workspace ` +
    '(paths are workspace-relative, or absolute inside a workspace folder)';
}

/** Pure-ish handler (fs injected); the vscode layer only adapts types. */
export async function runReadTool(
  input: ReadToolInput,
  deps: ReadToolDeps,
): Promise<ReadToolOutcome> {
  try {
    if (typeof input.path !== 'string' || input.path.trim() === '') {
      return { text: 'compressor_read: a file path is required', isError: true, compressed: false };
    }
    // models occasionally emit a stray leading/trailing space; failing the read
    // over whitespace costs a whole turn to recover from
    input = { ...input, path: input.path.trim() };
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
      return {
        text: await readFailure(input.path, reason, deps.workspaceFolders, read),
        isError: true,
        compressed: false,
      };
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

    // Two independent decisions, in this order. Content reduction is optional:
    // it must never grow the output and is discarded below the worthwhile
    // floor. A host budget is a hard cap applied last: whatever fits is
    // returned even when the saving is small, and a budget too small for a
    // recovery marker yields a short notice rather than the whole file.
    const candidate = targeted ? numbered : readCandidate(allLines, resolved.absPath, deps.mode, false);
    // An absent host budget is not an absent cap: see effectiveBudget. The cap
    // applies to an explicit offset/limit too. Exempting those looked like it
    // preserved a verbatim range, but the host spills any result over its own
    // inline limit to a file, so an oversized range was never reaching the
    // model verbatim — it arrived as a path to re-read, and that read spilled
    // in turn. An honest short range beats a long one the caller cannot see.
    // The note is prepended after capping, so its cost has to come out of the
    // budget rather than be added on top of it — a cap that overshoots by the
    // width of its own coverage line is the thing that makes a host spill.
    // Sizing it from the requested range alone under-reserves: rangeNote drops
    // its resume clause when the whole range fits, so the note that ships after
    // a cap is the longer of the two forms. Reserve the widest it can become.
    const base = effectiveBudget(deps.mode, deps.tokenBudget);
    const widestNote = [slice.length, slice.length - 1, 1]
      .filter((shown) => shown >= 1)
      .map((shown) => rangeNote(start, shown, allLines.length))
      .reduce((longest, note) => (note.length > longest.length ? note : longest), '');
    const reserve = targeted && base !== undefined && widestNote !== ''
      ? await tokenCounter(deps)(`${widestNote}\n`)
      : 0;
    const capDeps: ReadToolDeps = {
      ...deps,
      tokenBudget: base === undefined ? undefined : Math.max(1, base - reserve),
    };
    const reduced = await selectOutput(numbered, candidate, capDeps);
    // Observed: the model answered a capped read by re-requesting offset=1 with
    // limit raised 400 -> 2000 -> 4000, receiving the same bytes each time,
    // because the budget bounds the output and the limit does not.
    const RAISING_LIMIT = 'a larger limit returns the same bytes, because the budget caps this output';
    let capped = deps.mode === 'full'
      ? reduced
      : await fitOutput(reduced, capDeps, targeted
        ? `advance the offset to continue; ${RAISING_LIMIT}`
        : 'use compressor_read with offset/limit for the lines you still need, or compressor_outline');
    let budgeted = capped !== reduced;
    if (budgeted && targeted) {
      // The caller asked for a specific range; answer with as much of that
      // range as fits and where to resume, not with a different view of it.
      if (capped !== '') capped = withResumePoint(capped, RAISING_LIMIT);
    } else if (budgeted) {
      // prefer a complete structure over a truncated prefix; only when no
      // symbol provider can describe the file do we fall back to cutting it
      const structure = await completeStructure(resolved.absPath, input.path, deps, allLines);
      const fitted = structure === undefined
        ? undefined
        : await fitOutput(structure, capDeps, `read compressor_outline ${input.path} instead`);
      if (fitted !== undefined && fitted !== '' && fitted === structure) {
        capped = structure;
        budgeted = true;
      } else if (capped !== '') {
        capped = withResumePoint(capped);
      }
    }
    const notice =
      `[compressor: ${input.path} omitted; the budget cannot fit a recovery marker. ` +
      'Read a range with offset/limit, or use compressor_outline]';
    // A notice longer than the file it replaces helps nobody.
    const content = !budgeted ? reduced
      : capped || (notice.length < numbered.length ? notice : numbered);

    const saved = numbered.length - content.length;
    const worthwhile =
      saved >= MIN_SAVED_CHARS && saved >= numbered.length * MIN_SAVED_RATIO;
    // Leads the output: a model that stops reading partway through a result
    // still sees how much of the file it was given. Metadata about coverage,
    // never counted as a reduction. Counted from the text actually returned,
    // so a capped range reports the lines it kept rather than the lines asked
    // for — the whole point of the note is that it cannot overstate coverage.
    const shown = (text: string): string => {
      if (!targeted) return '';
      // No numbered line means no line of the file was returned — the budget
      // left room for the notice only. There is no coverage to state, and the
      // requested range is exactly the claim that would be false.
      const end = lastNumberedLine(text);
      if (end === undefined) return '';
      return rangeNote(start, Math.max(0, end - start + 1), allLines.length);
    };
    if (content === numbered || (!budgeted && !worthwhile)) {
      const note = shown(numbered);
      return { text: note === '' ? numbered : `${note}\n${numbered}`, isError: false, compressed: false };
    }

    if (worthwhile) {
      // fire-and-forget, fail-open: the ledger must never break the tool call
      void recordEvent({
        ts: new Date().toISOString(),
        agent: 'vscode',
        tool: 'read',
        mode: deps.mode,
        charsIn: numbered.length,
        charsOut: content.length,
        estTokensIn: cheapEstimator(numbered),
        estTokensOut: cheapEstimator(content),
        transforms: [budgeted ? 'host-budget' : 'numbered-dedupe'],
      }).catch(() => {});
    }

    const note = shown(content);
    return { text: note === '' ? content : `${note}\n${content}`, isError: false, compressed: true };
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
