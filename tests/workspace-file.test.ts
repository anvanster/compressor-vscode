import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isChatSessionResource, containsPath, readWorkspaceFile, setChatResourceRoot } from '../src/tools/workspace-file';
import { runSearchTool } from '../src/tools/search';

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

  // The message is a recovery instruction: a model follows it literally, so a
  // call it names has to be one compressor_search accepts. The previous
  // wording left out `query`, which the tool requires, spending a whole turn
  // on `compressor_search: a query is required`.
  it('names a compressor_search call that compressor_search accepts', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compressor-dirmsg-call-'));
    try {
      await mkdir(path.join(dir, 'src'), { recursive: true });
      await writeFile(path.join(dir, 'src', 'service.ts'), 'export const marker = 1;\n');
      await writeFile(path.join(dir, 'elsewhere.ts'), 'export const marker = 2;\n');
      const message = await readWorkspaceFile(path.join(dir, 'src'), [dir])
        .then(() => '', (error: Error) => error.message);

      // rebuild the suggested call out of the message rather than restating it
      const suggested = /compressor_search \(([^)]*)\)/.exec(message);
      expect(suggested, message).not.toBeNull();
      const argument = (name: string): string | undefined =>
        new RegExp(`\\b${name}=(\\S+?)(?:,|$)`).exec(suggested![1]!)?.[1];
      expect(argument('query'), message).toBeDefined();

      const include = argument('include')!.replace('<dir>', 'src');
      const glob = new RegExp(`^${include.replace(/\*\*/g, '.*').replace(/([^.])\*/g, '$1[^/]*')}$`);
      const outcome = await runSearchTool({
        query: 'marker',
        include,
        output: argument('output') as 'files' | undefined,
      }, {
        workspaceFolders: [dir],
        mode: 'optimized',
        findFiles: async (pattern) => {
          const matcher = new RegExp(`^${pattern.replace(/\*\*/g, '.*').replace(/([^.])\*/g, '$1[^/]*')}$`);
          return ['src/service.ts', 'elsewhere.ts']
            .filter((file) => matcher.test(file))
            .map((file) => path.join(dir, file));
        },
      });

      expect(outcome.isError, outcome.text).toBe(false);
      expect(outcome.text).toContain('service.ts');
      // the include the message names has to scope the search to the directory
      expect(glob.test('src/service.ts')).toBe(true);
      expect(outcome.text).not.toContain('elsewhere.ts');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
