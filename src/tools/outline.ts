import * as vscode from 'vscode';
import { readWorkspaceFile } from './workspace-file';
import {
  cheapEstimator,
  langFromPath,
  skeleton,
} from '@astudioplus/compressor';
import type { CompressMeta } from '@astudioplus/compressor';
import { normalizeMode, numberLines, readFailure, resolveWorkspacePath } from './read';
import type { ReadToolDeps } from './read';
import { recordEvent } from '../ledger';
import { documentSymbols, exportLegend, formatSymbols } from './symbols';
import type { CodeSymbol } from './symbols';
import { effectiveBudget, selectOutput, fitOutput } from './output-policy';
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
/** Rewrite `Read <abs> with offset=N and limit=M` to this tool's own call. */
export function retargetMarkers(text: string, absPath: string, requested: string): string {
  const quoted = absPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(`Read ${quoted} with offset=(\\d+) and limit=(\\d+) to retrieve`, 'g'),
    (_match, offset: string, limit: string) =>
      `compressor_read ${requested} offset=${offset} limit=${limit} to retrieve`,
  );
}

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
      const failure = await readFailure(input.path, reason, deps.workspaceFolders, read);
      return { text: failure.replace('compressor_read', 'compressor_outline'), isError: true, outlined: false };
    }

    const allLines = raw.split('\n');
    if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }
    const numbered = numberLines(allLines, 1);
    const budgeted: ReadToolDeps = { ...deps, tokenBudget: effectiveBudget(deps.mode, deps.tokenBudget) };
    // The budget is a cap on every path of this tool, including the degenerate
    // one where it cannot fit even a recovery marker and fitOutput answers ''.
    // Falling back to the uncapped text there skipped the cap in the one case
    // it was needed most — a 20-token request answered with the whole listing.
    // compressor_read already answers that regime with a short notice; this is
    // the same notice, not a second mechanism.
    const cap = async (
      text: string,
      recovery = `read a range with compressor_read ${input.path} offset=N limit=M`,
    ): Promise<string> => {
      const fitted = await fitOutput(text, budgeted, recovery);
      if (fitted !== '') return fitted;
      const notice =
        `[compressor: ${input.path} omitted; the budget cannot fit a recovery marker. ` +
        `Read a range with compressor_read ${input.path} offset=N limit=M]`;
      // A notice longer than the thing it stands in for helps nobody.
      return notice.length < text.length ? notice : text;
    };
    if (deps.cancelled?.()) throw new Error('Operation cancelled');
    let symbols: CodeSymbol[];
    try { symbols = await (deps.symbols ?? (deps.readFile ? async () => [] : documentSymbols))(resolved.absPath); }
    catch { symbols = []; }
    if (symbols.length > 0) {
      // An outline is signatures with the bodies removed. Without saying so it
      // reads like a complete description of the file, and a model will answer
      // questions about behaviour from names alone rather than reading the
      // ranges it was just handed.
      const body = formatSymbols(symbols, { path: resolved.absPath, lines: allLines });
      const preamble = (legend: string): string =>
        `${input.path}: signatures only, bodies omitted. ${legend}` +
        'Read a range with compressor_read before describing what any of it does.\n';
      const head = preamble(exportLegend(body));
      const formatted = head + body.text;
      const capped = await cap(formatted, 'use compressor_read with offset/limit to inspect the remaining source');
      // The legend is settled a second time against the listing that survived
      // the cap, by rebuilding the preamble this code composed. A file whose
      // marks all sit below the cut would otherwise ship "unmarked names are
      // internal" over a listing with no marks left to exempt.
      const listed = capped.startsWith(head) ? capped.slice(head.length) : undefined;
      const candidate = listed !== undefined && exportLegend({ ...body, text: listed }) === ''
        ? preamble('') + listed
        : capped;
      // The cap applies to whichever of the two is chosen. Selecting first and
      // capping second matters when the outline loses: a JSON provider reports
      // a symbol per key, so the outline of a package.json is larger than the
      // file, and the source it falls back to is a whole file.
      const selected = await selectOutput(numbered, candidate, budgeted);
      const content = await cap(selected);
      if (content !== numbered) {
        void recordEvent({
          ts: new Date().toISOString(), agent: 'vscode', tool: 'read', mode: deps.mode,
          charsIn: numbered.length, charsOut: content.length,
          estTokensIn: cheapEstimator(numbered), estTokensOut: cheapEstimator(content),
          // The listing lost to the source and the cap then cut it: what came
          // back is trimmed source, not an outline.
          transforms: [selected === numbered ? 'host-budget' : 'symbol-outline'],
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
    // The engine's marker names the built-in `Read` and an absolute path. The
    // built-in read is exactly what the compressor agent's allowlist removes,
    // so the instruction is unfollowable there; point at this tool instead, and
    // keep the workspace-relative path the model already used.
    result.content = retargetMarkers(result.content, resolved.absPath, input.path);
    if (result.content !== numbered && await selectOutput(numbered, result.content, budgeted) === numbered) {
      const text = await cap(numbered);
      if (text === numbered) return { text, isError: false, outlined: false };
      void recordEvent({
        ts: new Date().toISOString(), agent: 'vscode', tool: 'read', mode: deps.mode,
        charsIn: numbered.length, charsOut: text.length,
        estTokensIn: cheapEstimator(numbered), estTokensOut: cheapEstimator(text),
        transforms: ['host-budget'],
      }).catch(() => {});
      return { text, isError: false, outlined: true };
    }
    if (result.content === numbered || result.transform === undefined) {
      // signature model exists but produced no collapse (tiny file, or all
      // top-level declarations) — the full numbered file IS the outline
      const head = `compressor_outline: ${input.path} is already all signatures — full file below\n`;
      const whole = head + numbered;
      const capped = await cap(whole);
      if (capped === whole) return { text: whole, isError: false, outlined: false };
      // The budget cut the listing, so "full file below" is no longer true.
      // The recovery marker the cap appended says what was returned instead.
      const text = capped.startsWith(head) ? capped.slice(head.length) : capped;
      void recordEvent({
        ts: new Date().toISOString(), agent: 'vscode', tool: 'read', mode: deps.mode,
        charsIn: numbered.length, charsOut: text.length,
        estTokensIn: cheapEstimator(numbered), estTokensOut: cheapEstimator(text),
        transforms: ['host-budget'],
      }).catch(() => {});
      return { text, isError: false, outlined: true };
    }

    const text = await cap(result.content);
    void recordEvent({
      ts: new Date().toISOString(),
      agent: 'vscode',
      tool: 'read',
      mode: deps.mode,
      charsIn: numbered.length,
      charsOut: text.length,
      estTokensIn: cheapEstimator(numbered),
      estTokensOut: cheapEstimator(text),
      transforms: [result.transform.id],
    }).catch(() => {});

    return { text, isError: false, outlined: true };
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
