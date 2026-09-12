import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isChatSessionResource, containsPath, readWorkspaceFile } from '../src/tools/workspace-file';

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

describe('spilled tool results', () => {
  const spill = [
    '/Users/u/Library/Application Support/Code/User/workspaceStorage/abc/GitHub.copilot-chat/chat-session-resources/s1/call_x__vscode-1/content.txt',
    '/home/u/.config/Code/User/workspaceStorage/abc/GitHub.copilot-chat/chat-session-resources/s1/call_x/content.txt',
    'C:\\Users\\u\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc\\GitHub.copilot-chat\\chat-session-resources\\s1\\content.txt',
  ];

  it('recognises VS Code spill paths on every platform layout', () => {
    for (const file of spill) expect(isChatSessionResource(file), file).toBe(true);
  });

  it('does not open the rest of the machine', () => {
    for (const file of [
      '/Users/u/.ssh/config',
      '/Users/u/Library/Application Support/Code/User/workspaceStorage/abc/state.vscdb',
      '/Users/u/Library/Application Support/Code/User/settings.json',
      // a look-alike folder without VS Code's own parent segment
      '/Users/u/projects/chat-session-resources/notes.txt',
      '/Users/u/GitHub.copilot-chat/secrets.txt',
    ]) {
      expect(isChatSessionResource(file), file).toBe(false);
    }
  });
});

