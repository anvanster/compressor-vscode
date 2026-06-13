import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendLedger,
  cheapEstimator,
  compress,
  policyFor,
} from '@astudioplus/compressor';
import type { CompressMeta, Mode } from '@astudioplus/compressor';
import { MIN_SAVED_CHARS, MIN_SAVED_RATIO, lengthSansMarkers, normalizeMode } from './read';

// The compressor_search languageModelTools tool: a workspace text/regex search
// whose grep-style results run through the compressor engine (dedupe repeated
// lines, truncate over budget with a recoverable [compressor:] marker) before
// reaching the model. Search output is exactly the kind of bulk text that
// inflates context. Honesty rules match compressor_read: workspace-only,
// estimated ledger figures, nothing leaves the machine.

export interface SearchToolInput {
  query: string;
  /** treat query as a JS regular expression */
  isRegex?: boolean;
  /** case-insensitive match */
  ignoreCase?: boolean;
  /** include glob, relative to the workspace (default all files) */
  include?: string;
  /** cap on total matches returned */
  maxResults?: number;
}

export interface SearchToolDeps {
  workspaceFolders: readonly string[];
  mode: Mode;
  /** absolute paths matching the include glob, already capped/excluded */
  findFiles: (include: string, max: number) => Promise<string[]>;
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
const PER_FILE_CAP = 50;
const MAX_FILE_BYTES = 2_000_000;

interface Match {
  absFile: string;
  lineNo: number;
  text: string;
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

/** Pure-ish handler (fs + file discovery injected). */
export async function runSearchTool(
  input: SearchToolInput,
  deps: SearchToolDeps,
): Promise<SearchToolOutcome> {
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
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { text: `compressor_search: invalid regex: ${reason}`, isError: true, compressed: false, matches: 0, files: 0 };
    }

    const limit = Math.min(
      MAX_RESULTS_CAP,
      Math.max(1, Math.floor(input.maxResults ?? MAX_RESULTS_DEFAULT)),
    );
    const read = deps.readFile ?? ((p: string) => readFile(p, 'utf8'));
    const files = await deps.findFiles(input.include ?? '**/*', MAX_FILES);

    const matches: Match[] = [];
    let capped = false;
    for (const absFile of files) {
      if (matches.length >= limit) {
        capped = true;
        break;
      }
      let content: string;
      try {
        content = await read(absFile);
      } catch {
        continue; // unreadable file — skip, never fail the whole search
      }
      if (content.length > MAX_FILE_BYTES || content.includes('\u0000')) {
        continue; // too big or binary
      }
      const fileLines = content.split('\n');
      let perFile = 0;
      for (let i = 0; i < fileLines.length; i += 1) {
        const text = fileLines[i] ?? '';
        if (matcher(text)) {
          matches.push({ absFile, lineNo: i + 1, text });
          perFile += 1;
          if (matches.length >= limit) {
            capped = true;
            break;
          }
          if (perFile >= PER_FILE_CAP) {
            break; // don't let one file dominate the budget
          }
        }
      }
    }

    const fileCount = new Set(matches.map((m) => m.absFile)).size;
    if (matches.length === 0) {
      return {
        text: `compressor_search: no matches for ${input.query}`,
        isError: false,
        compressed: false,
        matches: 0,
        files: 0,
      };
    }

    const root = deps.workspaceFolders[0] ?? '';
    const body = formatMatches(matches, root);
    const meta: CompressMeta = { tool: 'search', mode: deps.mode, targeted: false };
    const result = compress(body, meta, policyFor(deps.mode), cheapEstimator);

    const saved = body.length - lengthSansMarkers(result.content);
    const worthwhile = saved >= MIN_SAVED_CHARS && saved >= body.length * MIN_SAVED_RATIO;
    const header =
      `${fmt(matches.length)}${capped ? '+ (capped)' : ''} matches in ${fmt(fileCount)} file(s) ` +
      `for ${input.isRegex === true ? '/' : '"'}${input.query}${input.isRegex === true ? '/' : '"'}`;

    if (!worthwhile) {
      return {
        text: `${header}\n\n${body}`,
        isError: false,
        compressed: false,
        matches: matches.length,
        files: fileCount,
      };
    }

    void appendLedger({
      ts: new Date().toISOString(),
      agent: 'vscode',
      tool: 'search',
      mode: deps.mode,
      charsIn: body.length,
      charsOut: result.content.length,
      estTokensIn: result.stats.estTokensIn,
      estTokensOut: result.stats.estTokensOut,
      transforms: result.stats.transforms.map((t) => t.id),
    }).catch(() => {});

    return {
      text: `${header}\n\n${result.content}`,
      isError: false,
      compressed: true,
      matches: matches.length,
      files: fileCount,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { text: `compressor_search failed: ${reason}`, isError: true, compressed: false, matches: 0, files: 0 };
  }
}

function depsFromVscode(): SearchToolDeps {
  return {
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    mode: normalizeMode(vscode.workspace.getConfiguration('compressor').get('mode')),
    findFiles: async (include, max) => {
      const exclude = '**/{node_modules,.git,out,dist,.vscode-test}/**';
      const uris = await vscode.workspace.findFiles(include, exclude, max);
      return uris.map((u) => u.fsPath);
    },
  };
}

export function registerSearchTool(): vscode.Disposable {
  return vscode.lm.registerTool<SearchToolInput>('compressor_search', {
    prepareInvocation(options) {
      return { invocationMessage: `Searching for "${options.input.query}" (compressed)` };
    },
    async invoke(options) {
      const outcome = await runSearchTool(options.input, depsFromVscode());
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(outcome.text),
      ]);
    },
  });
}
