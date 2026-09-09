import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function canonicalWorkspacePath(target: string, roots: readonly string[]): Promise<string> {
  const canonical = await realpath(target);
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