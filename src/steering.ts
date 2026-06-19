import * as vscode from 'vscode';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Extension-owned Copilot steering artifacts. There is no VS Code API to force
// the agent to pick a tool or to override the built-in file read, and custom
// *instructions* are honored for code-gen style, NOT tool routing — so an
// instructions nudge alone is routinely ignored. The one deterministic lever is
// a `tools:` ALLOWLIST that omits the built-in read/search toolsets, on two
// surfaces (both shipped here as fully-owned, namespaced files):
//
//   1. `.github/agents/compressor.agent.md` — a custom AGENT (a.k.a. subagent).
//      Selected once from the Chat agents dropdown; for that whole session the
//      built-in read/search are out of scope, so reads go through the
//      compressor tools. This is the closest thing to "uses them on its own".
//   2. `.github/prompts/compressor.prompt.md` — the `/compressor` prompt
//      (slash command), which runs under that agent for one-shot tasks.
//
// Plus a best-effort always-on nudge for the DEFAULT agent, written into the
// SHARED `.github/copilot-instructions.md`. Because that file is not ours — the
// user owns it and the compressor CLI's pack also lives there — our content is
// fenced in DISTINCT comment markers (`compressor-vscode:steering:*`) and
// upserted/removed in place; bytes outside the markers are never touched. The
// markers are deliberately different from the library pack's
// `<!-- compressor:begin mode=… v=1 -->` / `<!-- compressor:end -->` grammar, so
// `compressor init` and steering coexist and neither clobbers the other.
//
// Formats verified against code.visualstudio.com/docs/agent-customization/*
// (custom-agents, prompt-files; fetched 2026-06-18): agents in `.github/agents/`
// `*.agent.md` with `tools` (an allowlist; built-in read = `read`, codebase
// search = `search`, both omitted; `edit` is a separate set, so editing does
// not drag read back in); prompt files in `.github/prompts/` `*.prompt.md`, run
// via `/<filename>`, frontmatter `agent` may name a custom agent. Tools surface
// by toolReferenceName: compressorRead / compressorSearch / compressorOutline.
// The allowlist→removal behavior is doc-inferred, so the agent body ALSO
// instructs usage and `status` says to spot-check the Configure Tools picker.
//
// Ownership: the two owned files are overwritten on install and deleted on
// remove (empty dirs we created are pruned, foreign files keep them); the
// shared instructions file is edited only between our markers.

export const AGENT_RELATIVE_PATH = path.join('.github', 'agents', 'compressor.agent.md');
export const PROMPT_RELATIVE_PATH = path.join('.github', 'prompts', 'compressor.prompt.md');
export const COPILOT_INSTRUCTIONS_RELATIVE_PATH = path.join('.github', 'copilot-instructions.md');

/** The artifact whose presence `status` and `steeringInstalled` key on. */
export const STEERING_PRIMARY_RELATIVE_PATH = AGENT_RELATIVE_PATH;

export const AGENT_CONTENT = `---
description: 'Explore and edit this repo with compressor''s token-saving tools — the built-in file read and codebase search are out of scope.'
tools: ['compressorRead', 'compressorSearch', 'compressorOutline', 'edit']
---

# Compressor agent

All file reading and searching in this workspace goes through the **compressor**
tools, which compress output before it reaches you — saving tokens with no loss.
Every omission is a recoverable \`[compressor: … offset=N limit=M to retrieve]\`
marker and original line numbers are always preserved, so you can still cite and
edit by line.

The built-in file-read and codebase-search tools are intentionally **not**
available in this agent. Read and search like this:

- **\`compressorOutline\`** — call this first on any source file longer than
  ~200 lines to see its shape (top-level imports + signatures, bodies collapsed)
  before reading bodies. Supports TS/JS, Python, Rust, and Go.
- **\`compressorRead\`** — read a file. Read the *whole* file and let it collapse
  comments and repeated lines; do **not** pre-emptively page with offset/limit
  (a targeted range is returned uncompressed, so paging defeats the savings).
  Only pass \`offset\` (1-based start line) and \`limit\` to expand an exact span
  that a \`[compressor: …]\` marker points to. Short files come back unchanged.
- **\`compressorSearch\`** — find where something is defined or used (supports a
  regex, an \`include\` glob, and a result cap) instead of reading whole files.

When a \`[compressor: …]\` marker hides a span you actually need, call
\`compressorRead\` again with the exact \`offset\`/\`limit\` the marker states —
nothing is lost, only deferred.

Do not read files by other means (for example shelling out to \`cat\`, \`head\`, or
\`grep\`): the terminal is intentionally not part of this agent so that reads
cannot bypass compression. Editing files works normally.
`;

export const PROMPT_CONTENT = `---
description: 'Explore or work in this repo using compressor''s token-saving tools (no built-in file read/search).'
agent: compressor
argument-hint: 'what to explore or do'
---

For this task, use the compressor tools — \`compressorOutline\`, \`compressorRead\`,
and \`compressorSearch\` — for **all** file reading and searching. The built-in
read and codebase-search tools are out of scope.

- Outline large files first, then read only the bodies you need.
- Read whole files and let compressor collapse the noise; use \`offset\`/\`limit\`
  only to expand a span a \`[compressor: …]\` marker points to.
- Prefer \`compressorSearch\` over opening whole files to locate definitions/uses.

Proceed with the user's request.
`;

// DISTINCT from the library pack markers (<!-- compressor:begin mode=… v=1 -->),
// so a steering section and a `compressor init` pack section coexist in the same
// copilot-instructions.md without either upsert touching the other's span.
export const STEERING_MARKER_BEGIN = '<!-- compressor-vscode:steering:begin -->';
export const STEERING_MARKER_END = '<!-- compressor-vscode:steering:end -->';

/** The fenced section upserted into the shared copilot-instructions.md. */
export const STEERING_SECTION = `${STEERING_MARKER_BEGIN}
<!-- Managed by "Compressor: Enable/Disable Copilot Steering". Content between
these markers is overwritten on update and removed on disable — edit elsewhere. -->

## Token-efficient file reading (compressor)

This repo has the compressor VS Code extension installed. Prefer the compressor
tools over the built-in ones when reading or searching files — they compress
output before it reaches you, with no loss (omissions carry a recoverable
\`[compressor: … offset=N limit=M]\` marker and line numbers are preserved):

- \`#compressorOutline\` — a large source file's shape before you read it.
- \`#compressorRead\` — reading a file (read the whole file and let it collapse
  the noise; pass offset/limit only to expand a span a marker points to).
- \`#compressorSearch\` — finding where code is defined or used.

For a session where every read is forced through these tools, pick the
**compressor** agent from the Chat agents dropdown, or run the **/compressor**
prompt.
${STEERING_MARKER_END}`;

interface OwnedArtifact {
  relativePath: string;
  content: string;
}

/** Whole-file artifacts: install overwrites, remove deletes. */
export const OWNED_ARTIFACTS: readonly OwnedArtifact[] = [
  { relativePath: AGENT_RELATIVE_PATH, content: AGENT_CONTENT },
  { relativePath: PROMPT_RELATIVE_PATH, content: PROMPT_CONTENT },
];

export function agentPath(projectDir: string): string {
  return path.join(projectDir, AGENT_RELATIVE_PATH);
}

export function promptPath(projectDir: string): string {
  return path.join(projectDir, PROMPT_RELATIVE_PATH);
}

export function copilotInstructionsPath(projectDir: string): string {
  return path.join(projectDir, COPILOT_INSTRUCTIONS_RELATIVE_PATH);
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Locate our marked section (exact begin/end lines, trimmed). */
function steeringSpan(lines: readonly string[]): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === STEERING_MARKER_BEGIN) {
      start = i;
    } else if (start !== -1 && trimmed === STEERING_MARKER_END) {
      return { start, end: i };
    }
  }
  return null;
}

export function hasSteeringSection(text: string): boolean {
  return steeringSpan(text.split('\n')) !== null;
}

/**
 * Insert/replace our section, preserving every byte outside the markers. A null
 * (or whitespace-only) file becomes just our section; otherwise we replace an
 * existing section in place or append one separated by a blank line.
 */
export function upsertSteeringSection(existing: string | null): string {
  if (existing === null || existing.trim() === '') {
    return `${STEERING_SECTION}\n`;
  }
  const lines = existing.split('\n');
  const span = steeringSpan(lines);
  if (span !== null) {
    return [
      ...lines.slice(0, span.start),
      ...STEERING_SECTION.split('\n'),
      ...lines.slice(span.end + 1),
    ].join('\n');
  }
  const trimmed = existing.replace(/\n+$/u, '');
  return `${trimmed}\n\n${STEERING_SECTION}\n`;
}

/** Strip our section, collapsing one adjacent blank line; other bytes survive. */
export function removeSteeringSection(existing: string): string {
  const lines = existing.split('\n');
  const span = steeringSpan(lines);
  if (span === null) {
    return existing;
  }
  const before = lines.slice(0, span.start);
  const after = lines.slice(span.end + 1);
  if (before.length > 0 && before[before.length - 1] === '') {
    before.pop();
  } else if (after.length > 0 && after[0] === '') {
    after.shift();
  }
  return [...before, ...after].join('\n');
}

/** Install all steering artifacts. Returns the paths written/edited. */
export async function installSteering(projectDir: string): Promise<string[]> {
  const touched: string[] = [];
  for (const artifact of OWNED_ARTIFACTS) {
    const file = path.join(projectDir, artifact.relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, artifact.content, 'utf8');
    touched.push(file);
  }
  const shared = copilotInstructionsPath(projectDir);
  await mkdir(path.dirname(shared), { recursive: true });
  await writeFile(shared, upsertSteeringSection(await readFileOrNull(shared)), 'utf8');
  touched.push(shared);
  return touched;
}

/** Remove all steering artifacts. Returns the paths deleted/edited. */
export async function removeSteering(projectDir: string): Promise<string[]> {
  const touched: string[] = [];
  const dirs = new Set<string>();
  for (const artifact of OWNED_ARTIFACTS) {
    const file = path.join(projectDir, artifact.relativePath);
    await rm(file, { force: true });
    touched.push(file);
    dirs.add(path.dirname(file));
  }
  // shared file: strip only our section; delete the file only if nothing but
  // our section was in it (it was ours to begin with), else keep user content.
  const shared = copilotInstructionsPath(projectDir);
  const existing = await readFileOrNull(shared);
  if (existing !== null) {
    const stripped = removeSteeringSection(existing);
    if (stripped.trim() === '') {
      await rm(shared, { force: true });
    } else {
      await writeFile(shared, stripped, 'utf8');
    }
    touched.push(shared);
  }
  // best-effort prune of OWNED dirs we created; rmdir only removes EMPTY dirs.
  // (.github itself is never pruned — copilot-instructions.md and others live
  // there.)
  for (const dir of dirs) {
    try {
      await rmdir(dir);
    } catch {
      // not empty or already gone — leave it
    }
  }
  return touched;
}

/** Installed ⇨ the primary artifact (the custom agent) is present. */
export async function steeringInstalled(projectDir: string): Promise<boolean> {
  try {
    await readFile(agentPath(projectDir), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function firstWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function registerSteeringCommands(): vscode.Disposable {
  const enable = vscode.commands.registerCommand('compressor.enableSteering', async () => {
    const projectDir = firstWorkspaceFolder();
    if (projectDir === undefined) {
      void vscode.window.showErrorMessage('Compressor: open a workspace folder first.');
      return;
    }
    try {
      await installSteering(projectDir);
      void vscode.window.showInformationMessage(
        'Compressor: steering installed — pick the "compressor" agent from the Chat ' +
          'agents dropdown (or run the /compressor prompt) to force the compressor ' +
          'read/search tools; a marked section in .github/copilot-instructions.md also ' +
          'nudges the default agent. Applies to new chats.',
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Compressor: steering install failed: ${reason}`);
    }
  });
  const disable = vscode.commands.registerCommand('compressor.disableSteering', async () => {
    const projectDir = firstWorkspaceFolder();
    if (projectDir === undefined) {
      void vscode.window.showErrorMessage('Compressor: open a workspace folder first.');
      return;
    }
    try {
      await removeSteering(projectDir);
      void vscode.window.showInformationMessage(
        'Compressor: steering removed (agent, /compressor prompt, and the marked ' +
          'section in copilot-instructions.md).',
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Compressor: steering removal failed: ${reason}`);
    }
  });
  return vscode.Disposable.from(enable, disable);
}
