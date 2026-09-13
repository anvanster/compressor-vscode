import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The single exception to the workspace boundary.
 *
 * When a tool result is too large to pass inline, VS Code writes it to a file
 * under its own Copilot session storage and hands the model that path. The file
 * is this extension's own output coming back to us, so refusing to read it
 * protects nothing — it only pushes the model onto an uncompressed path.
 * Observed: the read was rejected and the model fell back to `cat` through the
 * shell, which is both larger and lossy.
 *
 * Deliberately narrow: the path must contain VS Code's own
 * `GitHub.copilot-chat/chat-session-resources` segment pair, which no workspace
 * file has, AND lie under VS Code's per-user storage area once that is known.
 * Size, regular-file and binary checks still apply.
 */
const SESSION_RESOURCE = /(?:^|[\\/])GitHub\.copilot-chat[\\/]chat-session-resources[\\/]/;

/**
 * VS Code's `User` directory, holding both `globalStorage/` and the
 * `workspaceStorage/<hash>/` trees Copilot spills tool results into. Derived at
 * activation from this extension's own global storage directory; until then the
 * segment pair alone decides, so a spilled result is never refused because of
 * startup ordering. Both the raw and the symlink-resolved form are kept, since
 * the caller may hand over either.
 */
let storageRoots: readonly string[] = [];

/**
 * `<user data>/User/globalStorage/<extension id>` under the default profile and
 * `<user data>/User/profiles/<id>/globalStorage/<extension id>` under a custom
 * one, so a fixed climb lands in a different place depending on the profile and
 * misses the sibling `workspaceStorage/` that holds the spilled results. The
 * `User` directory is the common ancestor of every layout, including remote and
 * portable installs, so that is what the exception is anchored to. A layout with
 * no `User` segment at all leaves the area unknown rather than guessed: the
 * segment pair still has to match, and refusing our own output outright would
 * push the model back onto the uncompressed shell read.
 */
function userStorageArea(globalStorageDir: string): string | undefined {
  const parts = path.resolve(globalStorageDir).split(path.sep);
  const index = parts.lastIndexOf('User');
  return index < 1 ? undefined : parts.slice(0, index + 1).join(path.sep);
}

export async function setChatResourceRoot(globalStorageDir: string | undefined): Promise<void> {
  const area = globalStorageDir === undefined ? undefined : userStorageArea(globalStorageDir);
  if (area === undefined) {
    storageRoots = [];
    return;
  }
  const resolved = await realpath(area).catch(() => area);
  storageRoots = area === resolved ? [area] : [area, resolved];
}

export function isChatSessionResource(target: string): boolean {
  if (!SESSION_RESOURCE.test(target)) return false;
  if (storageRoots.length === 0) return true;
  return storageRoots.some((root) => containsPath(root, path.resolve(target)));
}

export function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function canonicalWorkspacePath(target: string, roots: readonly string[]): Promise<string> {
  const canonical = await realpath(target);
  if (isChatSessionResource(canonical)) return canonical;
  const canonicalRoots = await Promise.all(roots.map((root) => realpath(root)));
  if (!canonicalRoots.some((root) => containsPath(root, canonical))) {
    throw new Error('Path resolves outside the open workspace folders');
  }
  return canonical;
}

export async function readWorkspaceFile(target: string, roots: readonly string[]): Promise<string> {
  const canonical = await canonicalWorkspacePath(target, roots);
  const info = await stat(canonical);
  if (!info.isFile() || info.size > 8_000_000) {
    throw new Error('Only regular text files up to 8 MB can be read');
  }
  const content = await readFile(canonical, 'utf8');
  if (content.includes('\u0000')) throw new Error('Binary files are not supported');
  return content;
}