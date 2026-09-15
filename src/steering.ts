import * as vscode from 'vscode';
import os from 'node:os';
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

/** Workspace steering is per-repo; user steering installs into the home dir. */
export type SteeringScope = 'workspace' | 'user';

/**
 * Copilot's user-profile agent folder (doc: "User profile ~/.copilot/agents").
 * Unlike the workspace folder this is a namespace shared with every agent the
 * user has ever installed, so installs there check ownership first.
 */
export function userAgentDir(home: string = os.homedir()): string {
  return path.join(home, '.copilot', 'agents');
}

export function userAgentPath(home: string = os.homedir()): string {
  return path.join(userAgentDir(home), 'compressor.agent.md');
}

/**
 * Bump whenever the agent/prompt/instructions text changes in a way an existing
 * install should pick up. Stamped into owned files so an install can say what
 * it replaced, and so `status` can name the revision on disk.
 */
export const STEERING_REVISION = 5;

const OWNED_MARKER_PREFIX = '<!-- compressor-vscode:owned';
const OWNED_MARKER_RE = /<!-- compressor-vscode:owned v=(\d+) -->/;

/**
 * Stamped into files this extension owns. VS Code gives custom agents no
 * namespace (microsoft/vscode#311920): the agent's `name` is its whole
 * identity, so a user-scope install must never clobber a `compressor` agent
 * somebody else wrote.
 */
export const OWNED_MARKER = `${OWNED_MARKER_PREFIX} v=${STEERING_REVISION} -->`;

/** Prefix match, so a file stamped by an older revision is still ours. */
export function isOwned(text: string): boolean {
  return text.includes(OWNED_MARKER_PREFIX);
}

/** The revision stamped in an owned file; undefined before stamps existed. */
export function ownedRevision(text: string): number | undefined {
  const stamped = OWNED_MARKER_RE.exec(text)?.[1];
  return stamped === undefined ? undefined : Number(stamped);
}

// The tools allowlist is the load-bearing part of the agent (it is what keeps
// the built-in read out of scope), so both scopes build from one definition
// rather than two constants that can drift apart.
const AGENT_TOOLS =
  "['compressorRead', 'compressorSearch', 'compressorOutline', 'compressorExecute', 'compressorLog', 'edit']";

function buildAgentContent(scope: SteeringScope): string {
  const subject = scope === 'user' ? 'any workspace' : 'this repo';
  const opening = scope === 'user'
    ? 'All file reading and searching goes through the **compressor** tools in\nwhichever workspace you select this agent.'
    : 'All file reading and searching in this workspace goes through the **compressor**\ntools.';
  return `---
name: compressor
description: 'Explore and edit ${subject} with compressor''s token-saving tools — the built-in file read and codebase search are out of scope.'
tools: ${AGENT_TOOLS}
---
${OWNED_MARKER}

# Compressor agent

${opening} Source code and comments are preserved; summarized results may omit information.
Every omission is a recoverable \`[compressor: … offset=N limit=M to retrieve]\`
marker and original line numbers are always preserved, so you can still cite and
edit by line.

The built-in file-read and codebase-search tools are intentionally **not**
available in this agent. Read and search like this:

- **\`compressorOutline\`** — call this first on any source file longer than
  ~200 lines to see its shape (top-level imports + signatures, bodies collapsed)
  before reading bodies. Works in any language VS Code has a symbol provider
  for; without one it falls back to a basic TS/JS, Python, Rust or Go outline.
- **\`compressorRead\`** — read relevant \`offset\`/\`limit\` ranges or qualified
  \`symbol\` names. Whole-file reads suit small files or broad edits.
- **\`compressorSearch\`** — find where something is defined or used (supports a
  regex, an \`include\` glob, and a result cap) instead of reading whole files.

When a \`[compressor: …]\` marker hides a span you actually need, call
\`compressorRead\` again with the exact \`offset\`/\`limit\` the marker states —
nothing is lost, only deferred.

Use \`compressorExecute\` for tests, builds and diagnostics after confirmation.
Always inspect exit status. Use \`compressorLog\` to retrieve omitted output
instead of rerunning commands. Do not use execution to bypass file boundaries.
Never use it to print a file (\`cat\`, \`head\`, \`sed -n\`): command output is
summarized for diagnostics, so a file read that way comes back sampled rather
than whole. \`compressorRead\` returns the range you asked for and states its
coverage. Editing files works normally.

## State only what the tools actually returned

Every compressor result says how much of the file it covers. Read that line and
obey it literally.

- \`showing lines A-B of N\` means you received lines A to B and nothing else.
  To describe anything outside that range, fetch it first with the \`offset\`
  the marker gives you. Never describe a default value, a signature, or a
  behaviour that was outside the lines you received.
- \`COMPLETE list of its declarations\` means nothing was dropped to fit the
  budget: it is everything the language provider reported for that file. Work
  from it rather than re-reading the whole file; if a symbol you have other
  evidence for is missing, search for it instead of assuming it does not exist.
  Bodies are excluded, so read a named range before you say what any of them
  does.
- \`signatures only, bodies omitted\` is a shape, not an implementation. Names
  are not evidence of behaviour.
- A preamble explaining \`*\` means that result marks the declarations the tools
  read as visible outside their file, or outside their class for a member.
  Only then is an unmarked symbol internal to that file, and not to be
  presented as part of a public API; the mark is read from the declaration
  line, so a missing \`*\` means "not shown to be public", not proof that
  nothing else can reach it. A result with no such preamble marks nothing —
  its language has no visibility rule here — so say nothing about what it
  exports.
- A \`[compressor: ...]\` marker always names the exact call that retrieves what
  it left out. Make that call. Do not substitute a different tool.

If you did not read something, say you did not read it. An invented constant,
default, or return type is far more expensive than the tokens the tool saved,
because it is wrong in a way the user cannot see.
`;
}

export const AGENT_CONTENT = buildAgentContent('workspace');
export const USER_AGENT_CONTENT = buildAgentContent('user');

export const PROMPT_CONTENT = `---
description: 'Explore or work in this repo using compressor''s token-saving tools (no built-in file read/search).'
agent: compressor
argument-hint: 'what to explore or do'
---

For this task, use the compressor tools — \`compressorOutline\`, \`compressorRead\`,
and \`compressorSearch\` — for **all** file reading and searching. The built-in
read and codebase-search tools are out of scope.

- Outline large files first, then read only the bodies you need.
- Read relevant ranges or symbols; read whole files when necessary.
- Run checks with \`compressorExecute\` and retrieve diagnostics with \`compressorLog\`.
- Prefer \`compressorSearch\` over opening whole files to locate definitions/uses.
- Compressor output states its own coverage (\`showing lines A-B of N\`,
  \`COMPLETE list\`, \`signatures only\`). Describe only what you actually
  received; fetch the rest with the offset the marker gives, or say you did not
  check it. Do not infer a value or a behaviour from a name.

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
output before it reaches you (omissions carry a recoverable
\`[compressor: … offset=N limit=M]\` marker and line numbers are preserved):

- \`#compressorOutline\` — a large source file's shape before you read it.
- \`#compressorRead\` — read a relevant range or symbol, or a whole small file.
- \`#compressorSearch\` — finding where code is defined or used.
- \`#compressorExecute\` / \`#compressorLog\` — run checks and retrieve diagnostics.

Compressor results state their own coverage (\`showing lines A-B of N\`,
\`COMPLETE list of its declarations\`, \`signatures only\`). Describe only what
you actually received, fetch the rest using the offset the marker names, and do
not infer values or behaviour from symbol names.

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

/** Write whole-file artifacts under a root, creating parent dirs. */
async function writeOwned(root: string, artifacts: readonly OwnedArtifact[]): Promise<string[]> {
  const touched: string[] = [];
  for (const artifact of artifacts) {
    const file = path.join(root, artifact.relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, artifact.content, 'utf8');
    touched.push(file);
  }
  return touched;
}

/** Install all steering artifacts. Returns the paths written/edited. */
export async function installSteering(projectDir: string): Promise<string[]> {
  const touched = await writeOwned(projectDir, OWNED_ARTIFACTS);
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

/**
 * Whether an install would change anything on disk. "outdated" covers content
 * this extension wrote under an older revision, a hand-edited owned file, and a
 * missing instructions section alike: install rewrites all of them the same way,
 * so the useful question is simply whether the bytes already match.
 *
 * "foreign" is the one state install does NOT rewrite unasked: a file in the
 * shared user agent namespace that carries no ownership marker belongs to
 * somebody else, so it is neither ours to call stale nor ours to update.
 */
export type SteeringState = 'absent' | 'current' | 'outdated' | 'foreign';

export interface SteeringStatus {
  state: SteeringState;
  /** revision stamped in the installed agent; absent on pre-stamp installs */
  revision?: number;
}

function statusFor(agent: string | null, expected: string, rest: () => boolean): SteeringStatus {
  if (agent === null) return { state: 'absent' };
  const revision = ownedRevision(agent);
  const state: SteeringState = agent === expected && rest() ? 'current' : 'outdated';
  return revision === undefined ? { state } : { state, revision };
}

export async function steeringStatus(projectDir: string): Promise<SteeringStatus> {
  const [agent, prompt, shared] = await Promise.all([
    readFileOrNull(agentPath(projectDir)),
    readFileOrNull(promptPath(projectDir)),
    readFileOrNull(copilotInstructionsPath(projectDir)),
  ]);
  // the shared file is current when upserting our section would be a no-op
  return statusFor(agent, AGENT_CONTENT, () =>
    prompt === PROMPT_CONTENT && shared !== null && upsertSteeringSection(shared) === shared);
}

export async function userSteeringStatus(home: string = os.homedir()): Promise<SteeringStatus> {
  const agent = await readFileOrNull(userAgentPath(home));
  if (agent !== null && !isOwned(agent)) return { state: 'foreign' };
  return statusFor(agent, USER_AGENT_CONTENT, () => true);
}

/** Installed ⇨ the primary artifact (the custom agent) is present. */
export async function steeringInstalled(projectDir: string): Promise<boolean> {
  return (await steeringStatus(projectDir)).state !== 'absent';
}

/**
 * User scope installs the agent only. The /compressor prompt has no documented
 * home-directory location (user prompts live in VS Code profile user data), and
 * the instructions section is always-on, which is not something to switch on
 * for every workspace behind a single click.
 */
export async function installUserSteering(home: string = os.homedir()): Promise<string[]> {
  return writeOwned(userAgentDir(home), [{ relativePath: 'compressor.agent.md', content: USER_AGENT_CONTENT }]);
}

/**
 * The shared user namespace may hold a `compressor` agent this extension never
 * wrote, so removal is ownership-checked the way installing is: a foreign file
 * is left in place and no path is reported as deleted. `force` is for the one
 * caller that has already asked the user about it.
 */
export async function removeUserSteering(
  home: string = os.homedir(),
  options: { readonly force?: boolean } = {},
): Promise<string[]> {
  const file = userAgentPath(home);
  const existing = await readFileOrNull(file);
  if (existing !== null && !isOwned(existing) && options.force !== true) return [];
  await rm(file, { force: true });
  try {
    await rmdir(userAgentDir(home)); // only succeeds when empty
  } catch {
    // other agents live there — leave the folder alone
  }
  return [file];
}

export async function userSteeringInstalled(home: string = os.homedir()): Promise<boolean> {
  return (await userSteeringStatus(home)).state !== 'absent';
}

/** How an install should describe what it just did. */
export function installOutcome(before: SteeringStatus, scope: SteeringScope): string {
  const what = scope === 'user' ? 'user-profile agent' : 'steering';
  if (before.state === 'absent') return `${what} installed`;
  if (before.state === 'foreign') return `${what} installed over the agent that was there`;
  const from = before.revision === undefined ? 'an older build' : `v${before.revision}`;
  return `${what} updated from ${from} to v${STEERING_REVISION}`;
}

/**
 * True when a `compressor` agent already sits in the shared user namespace but
 * this extension did not write it. Installing over it would silently replace
 * somebody else's agent, so the command asks first.
 */
export async function userAgentIsForeign(home: string = os.homedir()): Promise<boolean> {
  return (await userSteeringStatus(home)).state === 'foreign';
}

function firstWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function steeringWorkspaceFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length < 2) return firstWorkspaceFolder();
  return vscode.window.showQuickPick(folders.map((folder) => folder.uri.fsPath), { placeHolder: 'Workspace folder for compressor steering' });
}

/**
 * Workspace or user profile. With no folder open only user scope is possible,
 * so the picker is skipped rather than shown with one usable answer.
 */
async function pickScope(verb: string): Promise<SteeringScope | undefined> {
  if ((vscode.workspace.workspaceFolders ?? []).length === 0) return 'user';
  const workspace = {
    label: 'This workspace',
    detail: 'compressor agent, /compressor prompt, and a marked section in copilot-instructions.md',
  };
  const user = {
    label: 'All workspaces (user profile)',
    detail: `the compressor agent only, in ${userAgentDir()}`,
  };
  const picked = await vscode.window.showQuickPick([workspace, user], {
    placeHolder: `Where should compressor steering be ${verb}?`,
  });
  if (picked === undefined) return undefined;
  return picked.label === user.label ? 'user' : 'workspace';
}

export function registerSteeringCommands(): vscode.Disposable {
  const enable = vscode.commands.registerCommand('compressor.enableSteering', async () => {
    const scope = await pickScope('installed');
    if (scope === undefined) return;
    try {
      if (scope === 'user') {
        const before = await userSteeringStatus();
        if (before.state === 'current') {
          void vscode.window.showInformationMessage(
            `Compressor: user-profile agent is already up to date (v${STEERING_REVISION}).`,
          );
          return;
        }
        if (await userAgentIsForeign()) {
          const choice = await vscode.window.showWarningMessage(
            `Compressor: ${userAgentPath()} already exists and was not written by this extension. ` +
              'Custom agents share one namespace, so installing replaces it.',
            { modal: true },
            'Replace it',
          );
          if (choice !== 'Replace it') return;
        }
        await installUserSteering();
        void vscode.window.showInformationMessage(
          `Compressor: ${installOutcome(before, 'user')} at ${userAgentPath()}. Pick "compressor" from ` +
            'the Chat agents dropdown in any workspace. If it does not appear, VS Code has an open ' +
            'issue discovering user-level agents; workspace steering is unaffected.',
        );
        return;
      }
      const projectDir = await steeringWorkspaceFolder();
      if (projectDir === undefined) {
        void vscode.window.showErrorMessage('Compressor: open a workspace folder first.');
        return;
      }
      const before = await steeringStatus(projectDir);
      if (before.state === 'current') {
        void vscode.window.showInformationMessage(
          `Compressor: steering is already up to date (v${STEERING_REVISION}).`,
        );
        return;
      }
      await installSteering(projectDir);
      void vscode.window.showInformationMessage(
        `Compressor: ${installOutcome(before, 'workspace')} — pick the "compressor" agent from the Chat ` +
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
    const scope = await pickScope('removed');
    if (scope === undefined) return;
    try {
      if (scope === 'user') {
        if (!(await userSteeringInstalled())) {
          void vscode.window.showInformationMessage(
            `Compressor: no user-profile agent at ${userAgentPath()}. Workspace steering is unchanged.`,
          );
          return;
        }
        if (await userAgentIsForeign()) {
          const choice = await vscode.window.showWarningMessage(
            `Compressor: ${userAgentPath()} exists but was not written by this extension. ` +
              'Custom agents share one namespace, so this is likely somebody else\'s agent.',
            { modal: true },
            'Delete it',
          );
          if (choice !== 'Delete it') return;
          await removeUserSteering(os.homedir(), { force: true });
        } else {
          await removeUserSteering();
        }
        void vscode.window.showInformationMessage(
          'Compressor: user-profile compressor agent removed. Workspace steering is unchanged.',
        );
        return;
      }
      const projectDir = await steeringWorkspaceFolder();
      if (projectDir === undefined) {
        void vscode.window.showErrorMessage('Compressor: open a workspace folder first.');
        return;
      }
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
