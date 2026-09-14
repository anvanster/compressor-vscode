import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isChatSessionResource, containsPath, readWorkspaceFile, setChatResourceRoot } from '../src/tools/workspace-file';

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

  it('stays inside the storage area, under the default profile and a custom one', async () => {
    const user = path.join(os.tmpdir(), 'compressor-user-data', 'User');
    // spilled results live beside globalStorage, not under it, and a custom
    // profile moves globalStorage a further two levels down
    const spilled = path.join(
      user, 'workspaceStorage', 'abc', 'GitHub.copilot-chat', 'chat-session-resources', 's1', 'content.txt',
    );
    const elsewhere = path.join(
      os.tmpdir(), 'elsewhere', 'GitHub.copilot-chat', 'chat-session-resources', 'content.txt',
    );
    try {
      for (const globalStorage of [
        path.join(user, 'globalStorage', 'aStudioPlus.compressor-vscode'),
        path.join(user, 'profiles', '-abc123', 'globalStorage', 'aStudioPlus.compressor-vscode'),
      ]) {
        await setChatResourceRoot(globalStorage);
        expect(isChatSessionResource(spilled), globalStorage).toBe(true);
        expect(isChatSessionResource(elsewhere), globalStorage).toBe(false);
      }

      // an unrecognisable layout leaves the area unknown rather than refusing
      // every spilled result
      await setChatResourceRoot(path.join(os.tmpdir(), 'odd-layout', 'storage'));
      expect(isChatSessionResource(spilled)).toBe(true);
    } finally {
      await setChatResourceRoot(undefined);
    }
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


describe('unreadable targets name what is wrong', () => {
  it('distinguishes a directory from a size limit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compressor-dirmsg-'));
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await expect(readWorkspaceFile(path.join(dir, 'src'), [dir]))
      .rejects.toThrow(/a directory, not a file/);
    // a size message for a directory sends the caller looking for a big file
    await expect(readWorkspaceFile(path.join(dir, 'src'), [dir]))
      .rejects.not.toThrow(/8 MB/);
  });
});
