import * as vscode from 'vscode';
import { readWorkspaceFile } from './workspace-file';
import path from 'node:path';
import { cheapEstimator } from '@astudioplus/compressor';
import { recordEvent } from '../ledger';
import type { Mode } from '@astudioplus/compressor';
import { normalizeMode } from './read';
import { containsPath } from './workspace-file';
import { DEFAULT_TOKEN_BUDGET, fitOutput, tokenCounter } from './output-policy';
import type { OutputHints } from './output-policy';
import { measureOperation } from '../operation-metrics';
import { RegexScanner } from './regex-scanner';

// The compressor_search languageModelTools tool: a workspace text/regex search
// returning grep-style results bounded to whole matches, with a recoverable
// skip= continuation whenever a page does not fit. Search output is exactly the
// kind of bulk text that inflates context. Honesty rules match compressor_read:
// workspace-only, estimated ledger figures, nothing leaves the machine.

export interface SearchToolInput {
  query: string;
  root?: string;
  output?: 'content' | 'files' | 'count';
  skip?: number;
  contextLines?: number;
  /** treat query as a JS regular expression */
  isRegex?: boolean;
  /** case-insensitive match */
  ignoreCase?: boolean;
  /** include glob, relative to the workspace (default all files) */
  include?: string;
  /** cap on total matches returned */
  maxResults?: number;
}

export interface SearchToolDeps extends OutputHints {
  workspaceFolders: readonly string[];
  mode: Mode;
  /** absolute paths matching the include glob, already capped/excluded */
  findFiles: (include: string, max: number, root?: string) => Promise<string[]>;
  readFile?: (absPath: string) => Promise<string>;
}

export interface SearchToolOutcome {
  text: string;
  isError: boolean;
  /** true when the compressed form was returned (and a ledger event fired) */
  compressed: boolean;
  matches: number;
  files: number;
}

const MAX_RESULTS_DEFAULT = 200;
const MAX_RESULTS_CAP = 1000;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2_000_000;

/**
 * Search deliberately does not run the library's compress() pipeline. Every
 * tier there assumes a single file's contents: stripComments and skeleton need
 * a language and drop whole-line comments that are load-bearing directives
 * (`//go:build`, `# type: ignore`, text inside a template literal); the log
 * filters fire on a content sniff that grep output trips by accident; and
 * truncateHeadTail cuts a numbered multi-file result mid-block, stranding later
 * files under an earlier file's header so their matches are attributed to the
 * wrong file. The structural tiers cannot fire at all on this shape, since each
 * line carries a distinct number prefix. Bounding happens here instead, in
 * whole matches, using the skip= contract this tool actually honours.
 */

interface SearchBudget {
  tokens: number;
  /** ledger transform id naming what drove the reduction */
  source: 'host-budget' | 'search-page';
}

/**
 * Full mode is never budget-trimmed. Otherwise a usable host budget wins, and
 * DEFAULT_TOKEN_BUDGET is the backstop for hosts that supply none: optimized
 * keeps the magnitude of the engine's former truncateBudget so output size is
 * materially unchanged, and slim halves it, mirroring the library's own
 * optimized:slim ratio for touch and commentStrip. The library's note rejecting
 * a tighter read budget does not transfer here - it was measured against
 * offset/limit re-reads of the same content, whereas search pages forward
 * through skip= to matches it has not yet delivered.
 */
function budgetFor({ mode, tokenBudget }: SearchToolDeps): SearchBudget | undefined {
  if (mode === 'full') return undefined;
  return tokenBudget !== undefined && Number.isFinite(tokenBudget) && tokenBudget > 0
    ? { tokens: tokenBudget, source: 'host-budget' }
    : { tokens: DEFAULT_TOKEN_BUDGET[mode], source: 'search-page' };
}

/** Budget predicate sharing the read path's counter and cancellation. */
function budgetFits(hints: OutputHints, budget: number): (text: string) => Promise<boolean> {
  const count = tokenCounter(hints);
  return async (text) => {
    const tokens = await count(text);
    return Number.isFinite(tokens) && tokens <= budget;
  };
}

interface Match {
  absFile: string;
  lineNo: number;
  text: string;
  context?: { lineNo: number; text: string }[];
}

/** Build a per-line predicate; throws on an invalid regex (caught by caller). */
export function buildMatcher(input: SearchToolInput): (line: string) => boolean {
  if (input.isRegex === true) {
    const re = new RegExp(input.query, input.ignoreCase === true ? 'i' : '');
    return (line) => re.test(line);
  }
  if (input.ignoreCase === true) {
    const needle = input.query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => line.includes(input.query);
}

/** Group matches by file (encounter order) into a numbered grep-style block. */
export function formatMatches(matches: readonly Match[], root: string): string {
  if (matches.some((match) => match.context !== undefined)) {
    const grouped = new Map<string, { lines: Map<number, string>; selected: Set<number> }>();
    for (const match of matches) {
      let group = grouped.get(match.absFile);
      if (!group) {
        group = { lines: new Map(), selected: new Set() };
        grouped.set(match.absFile, group);
      }
      for (const line of match.context ?? []) group.lines.set(line.lineNo, line.text);
      group.lines.set(match.lineNo, match.text);
      group.selected.add(match.lineNo);
    }
    return [...grouped].map(([file, group]) => {
      const lines = [path.relative(root, file) || file];
      let previous: number | undefined;
      for (const [lineNo, text] of [...group.lines].sort(([left], [right]) => left - right)) {
        if (previous !== undefined && lineNo > previous + 1) lines.push('--');
        lines.push(`${String(lineNo).padStart(6)}${group.selected.has(lineNo) ? '→' : '|'}${text}`);
        previous = lineNo;
      }
      return lines.join('\n');
    }).join('\n\n');
  }
  const blocks: string[] = [];
  let currentFile: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (currentFile !== undefined) {
      blocks.push(`${currentFile}\n${lines.join('\n')}`);
    }
  };
  for (const m of matches) {
    const rel = path.relative(root, m.absFile) || m.absFile;
    if (rel !== currentFile) {
      flush();
      currentFile = rel;
      lines = [];
    }
    lines.push(`${String(m.lineNo).padStart(6)}→${m.text}`);
  }
  flush();
  return blocks.join('\n\n');
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** How a query is echoed back in a result header: /regex/ or "literal". */
const queryLabel = (input: SearchToolInput): string =>
  input.isRegex === true ? `/${input.query}/` : `"${input.query}"`;

async function fitSearchOutput(text: string, deps: SearchToolDeps): Promise<string> {
  if (deps.mode === 'full') return text;
  return await fitOutput(text, deps, 'narrow include or query; do not advance skip past omitted matches')
    || '[compressor: budget too small; narrow include or query]';
}

async function fitMatchPage(
  matches: readonly Match[], root: string, input: SearchToolInput,
  deps: SearchToolDeps, incomplete: ReadonlySet<string>, budget: number,
): Promise<string> {
  const skip = input.skip ?? 0;
  const notices = [...incomplete].filter((notice) => !notice.startsWith('match limit reached;'));
  const render = (size: number): string => {
    const selected = matches.slice(0, size);
    const counts = new Map<string, number>();
    for (const match of selected) counts.set(match.absFile, (counts.get(match.absFile) ?? 0) + 1);
    const body = input.output === 'files' || input.output === 'count'
      ? [...counts].map(([file, count]) => `${path.relative(root, file)}${input.output === 'count' ? `: ${count}` : ''}`).join('\n')
      : formatMatches(selected, root);
    const recovery = size > 0
      ? `continue with skip=${skip + size} and unchanged inputs`
      : 'no complete match fits; narrow include or query, or use compressor_read';
    return `Showing ${fmt(size)} of ${fmt(matches.length)} scanned matches in ${fmt(counts.size)} file(s) ` +
      `for ${queryLabel(input)}${notices.length ? `\nPartial scan: ${notices.join('; ')}` : ''}\n\n${body}\n` +
      `[compressor: partial output; ${recovery}]`;
  };
  const fits = budgetFits(deps, budget);
  let lower = 0;
  let upper = matches.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (await fits(render(middle))) lower = middle;
    else upper = middle - 1;
  }
  const text = render(lower);
  return await fits(text) ? text : '[compressor: budget too small; narrow include or query]';
}

/** Pure-ish handler (fs + file discovery injected). */
export async function runSearchTool(
  input: SearchToolInput,
  deps: SearchToolDeps,
): Promise<SearchToolOutcome> {
  let regexScanner: RegexScanner | undefined;
  try {
    if (typeof input.query !== 'string' || input.query === '') {
      return { text: 'compressor_search: a query is required', isError: true, compressed: false, matches: 0, files: 0 };
    }
    if (deps.workspaceFolders.length === 0) {
      return { text: 'compressor_search: no workspace folder open', isError: true, compressed: false, matches: 0, files: 0 };
    }
    let matcher: (line: string) => boolean;
    try {
      matcher = buildMatcher(input);
      if (input.isRegex) regexScanner = new RegexScanner(input.query, input.ignoreCase === true, deps.cancelled);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: `compressor_search: invalid regex: ${reason}`, isError: true, compressed: false, matches: 0, files: 0 };
    }

    const limit = Math.min(
      MAX_RESULTS_CAP,
      Math.max(1, Math.floor(input.maxResults ?? MAX_RESULTS_DEFAULT)),
    );
    if (!Number.isFinite(limit)) throw new Error('maxResults must be finite');
    const skip = input.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0) throw new Error('skip must be a non-negative integer');
    const contextLines = input.contextLines ?? 0;
    if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 5) throw new Error('contextLines must be an integer from 0 to 5');
    const matchingRoots = input.root === undefined ? [] : deps.workspaceFolders.filter((folder) => folder === input.root || path.basename(folder) === input.root);
    if (matchingRoots.length > 1) throw new Error('Ambiguous workspace root; use its absolute path');
    const selectedRoot = matchingRoots[0];
    if (input.root !== undefined && selectedRoot === undefined) throw new Error('root must name an open workspace folder');
    const read = deps.readFile ?? ((file: string) => readWorkspaceFile(file, deps.workspaceFolders));
    const discovered = await deps.findFiles(input.include ?? '**/*', MAX_FILES + 1, selectedRoot);
    const files = discovered.slice(0, MAX_FILES).filter((file) => selectedRoot === undefined || containsPath(selectedRoot, file)).sort();
    const incomplete = new Set<string>();
    if (discovered.length > MAX_FILES) incomplete.add('file discovery limit reached; narrow include');
    let seen = 0;

    const matches: Match[] = [];
    let capped = false;
    for (const absFile of files) {
      if (deps.cancelled?.()) throw new Error('Search cancelled');
      if (matches.length >= limit) {
        capped = true;
        break;
      }
      let content: string;
      try {
        content = await read(absFile);
      } catch {
        incomplete.add('unreadable or unsupported files skipped');
        continue; // unreadable file — skip, never fail the whole search
      }
      if (content.length > MAX_FILE_BYTES || content.includes('\u0000')) {
        incomplete.add('large or binary files skipped');
        continue; // too big or binary
      }
      const fileLines = content.split('\n');
      const addMatch = (index: number): void => {
        const match: Match = { absFile, lineNo: index + 1, text: fileLines[index] ?? '' };
        if (contextLines > 0 && (input.output === undefined || input.output === 'content')) {
          const start = Math.max(0, index - contextLines);
          match.context = fileLines.slice(start, index + contextLines + 1)
            .map((text, offset) => ({ lineNo: start + offset + 1, text }));
        }
        matches.push(match);
      };
      if (regexScanner) {
        const result = await regexScanner.scan(content, Math.max(0, skip - seen), limit - matches.length);
        seen += result.skipped + result.indices.length;
        for (const index of result.indices) {
          addMatch(index);
        }
        if (matches.length >= limit) { capped = true; break; }
        continue;
      }
      for (let i = 0; i < fileLines.length; i += 1) {
        const text = fileLines[i] ?? '';
        if (matcher(text)) {
          if (seen++ < skip) continue;
          addMatch(i);
          if (matches.length >= limit) {
            capped = true;
            break;
          }
        }
      }
    }

    const fileCount = new Set(matches.map((m) => m.absFile)).size;
    if (matches.length === 0) {
      const original = `compressor_search: no matches for ${input.query} in the scanned scope${incomplete.size ? `; partial: ${[...incomplete].join('; ')}` : ''}`;
      const text = await fitSearchOutput(original, deps);
      return {
        text,
        isError: false,
        compressed: text !== original,
        matches: 0,
        files: 0,
      };
    }

    const root = selectedRoot ?? deps.workspaceFolders[0] ?? '';
    if (capped) incomplete.add(`match limit reached; continue with skip=${skip + matches.length}`);
    const notice = incomplete.size ? `\nPartial results: ${[...incomplete].join('; ')}` : '';
    const budget = budgetFor(deps);
    // Over budget, re-render from the match list rather than cutting the text:
    // every retained match keeps its own file header, and the continuation is
    // expressed as skip=, the only recovery this tool can honour.
    const bound = async (rendered: string): Promise<string> =>
      budget === undefined || await budgetFits(deps, budget.tokens)(rendered)
        ? rendered
        : fitMatchPage(matches, root, input, deps, incomplete, budget.tokens);
    if (input.output === 'files' || input.output === 'count') {
      const counts = new Map<string, number>();
      for (const match of matches) counts.set(match.absFile, (counts.get(match.absFile) ?? 0) + 1);
      const original = `${matches.length} matches in ${counts.size} file(s)${notice}\n` + [...counts].map(([file, count]) => `${path.relative(root, file)}${input.output === 'count' ? `: ${count}` : ''}`).join('\n');
      const text = await bound(original);
      return {
        text,
        isError: false, compressed: text !== original, matches: matches.length, files: fileCount,
      };
    }
    const header =
      `${fmt(matches.length)}${capped ? '+ (capped)' : ''} matches in ${fmt(fileCount)} file(s) ` +
      `for ${queryLabel(input)}${notice}`;

    const original = `${header}\n\n${formatMatches(matches, root)}`;
    const text = await bound(original);
    const transforms = text === original || budget === undefined ? [] : [budget.source];

    if (text.length < original.length && cheapEstimator(text) < cheapEstimator(original)) void recordEvent({
      ts: new Date().toISOString(),
      agent: 'vscode',
      tool: 'search',
      mode: deps.mode,
      charsIn: original.length,
      charsOut: text.length,
      estTokensIn: cheapEstimator(original),
      estTokensOut: cheapEstimator(text),
      transforms,
    }).catch(() => {});

    return {
      text,
      isError: false,
      compressed: text !== original,
      matches: matches.length,
      files: fileCount,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `compressor_search failed: ${reason}`, isError: true, compressed: false, matches: 0, files: 0 };
  } finally {
    await regexScanner?.dispose();
  }
}

function depsFromVscode(token?: vscode.CancellationToken): SearchToolDeps {
  return {
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    mode: normalizeMode(vscode.workspace.getConfiguration('compressor').get('mode')),
    findFiles: async (include, max, root) => {
      const exclude = '**/{node_modules,.git,out,dist,.vscode-test}/**';
      const pattern = root === undefined ? include : new vscode.RelativePattern(root, include);
      const uris = await vscode.workspace.findFiles(pattern, exclude, max, token);
      return uris.map((u) => u.fsPath);
    },
  };
}

export function registerSearchTool(): vscode.Disposable {
  return vscode.lm.registerTool<SearchToolInput>('compressor_search', {
    prepareInvocation(options) {
      return { invocationMessage: `Searching for "${options.input.query}" (compressed)` };
    },
    async invoke(options, token) {
      const outcome = await measureOperation('search', false, () => runSearchTool(options.input, {
        ...depsFromVscode(token),
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
