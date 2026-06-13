import * as vscode from 'vscode';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Extension-owned Copilot steering file. Format verified against
// https://code.visualstudio.com/docs/agent-customization/custom-instructions
// (fetched 2026-06-12):
//   - location: workspace `.github/instructions` folder, files named
//     `*.instructions.md` ("You can define instructions for a specific
//     workspace or at the user level"; the workspace default location is the
//     .github/instructions folder, searched recursively)
//   - frontmatter: optional `name`, `description`, and `applyTo` — "Glob
//     pattern that defines which files the instructions apply to
//     automatically, relative to the workspace root. Use `**` to apply to
//     all files."
//   - tool references: "To reference agent tools, use the `#tool:<tool-name>`
//     syntax (for example, `#tool:web/fetch`)."
// Ownership model mirrors the library's cursor .mdc precedent: the file is
// entirely ours (namespaced name), so install overwrites and remove deletes.

export const STEERING_RELATIVE_PATH = path.join(
  '.github',
  'instructions',
  'compressor-vscode.instructions.md',
);

export const STEERING_CONTENT = `---
description: Prefer the compressed file-read tool for large files (compressor-vscode)
applyTo: "**"
---

# Reading files with compressor

When you need to read a file's contents, prefer the #tool:compressorRead tool
(compressor_read) over the built-in file read for:

- files longer than ~200 lines, and
- logs, build output, or other repetitive / generated text.

It returns the file with line numbers preserved, comments and repeated lines
collapsed, and any omitted span marked inline as \`[compressor: … offset=N
limit=M to retrieve]\`. Because line numbers are unchanged, you can still cite
and edit by line.

How to use it well:

- Read the whole file first; let compressor collapse the noise.
- To read an exact, uncompressed range, pass offset (1-based start line) and
  limit (line count).
- If a \`[compressor: …]\` marker hides a span you actually need, call the tool
  again with the offset and limit the marker states — nothing is lost, only
  deferred.
- Short files come back unchanged, so there is no downside to preferring it.
`;

export function steeringPath(projectDir: string): string {
  return path.join(projectDir, STEERING_RELATIVE_PATH);
}

export async function installSteering(projectDir: string): Promise<string> {
  const file = steeringPath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, STEERING_CONTENT, 'utf8');
  return file;
}

export async function removeSteering(projectDir: string): Promise<string> {
  const file = steeringPath(projectDir);
  await rm(file, { force: true });
  // best-effort prune of the instructions dir we may have created; rmdir only
  // ever removes EMPTY dirs, so foreign instruction files keep it alive
  try {
    await rmdir(path.dirname(file));
  } catch {
    // not empty or already gone — leave it
  }
  return file;
}

export async function steeringInstalled(projectDir: string): Promise<boolean> {
  try {
    await readFile(steeringPath(projectDir), 'utf8');
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
      const file = await installSteering(projectDir);
      void vscode.window.showInformationMessage(
        `Compressor: steering installed at ${file} — Copilot agent mode is nudged toward #compressorRead for large files. Applies to new chats.`,
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
      void vscode.window.showInformationMessage('Compressor: steering file removed.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Compressor: steering removal failed: ${reason}`);
    }
  });
  return vscode.Disposable.from(enable, disable);
}
