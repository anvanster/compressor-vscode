import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { containsPath, readWorkspaceFile } from '../src/tools/workspace-file';

it('rejects symlinks outside the workspace but permits internal targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compressor-boundary-'));
  try {
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(root, 'outside.txt'), 'private');
    await writeFile(path.join(workspace, 'inside.txt'), 'public');
    await symlink(path.join(root, 'outside.txt'), path.join(workspace, 'escape.txt'));
    await symlink(path.join(workspace, 'inside.txt'), path.join(workspace, 'alias.txt'));
    await expect(readWorkspaceFile(path.join(workspace, 'escape.txt'), [workspace])).rejects.toThrow('outside');
    await expect(readWorkspaceFile(path.join(workspace, 'alias.txt'), [workspace])).resolves.toBe('public');
    expect(containsPath(workspace, path.join(workspace, '..notes'))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});