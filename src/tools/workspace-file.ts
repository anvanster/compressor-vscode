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
 * file has. Size, regular-file and binary checks still apply.
 */
const SESSION_RESOURCE = /(?:^|[\\/])GitHub\.copilot-chat[\\/]chat-session-resources[\\/]/;

export function isChatSessionResource(target: string): boolean {
  return SESSION_RESOURCE.test(target);
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