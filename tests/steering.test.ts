import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTENT,
  USER_AGENT_CONTENT,
  AGENT_RELATIVE_PATH,
  COPILOT_INSTRUCTIONS_RELATIVE_PATH,
  OWNED_ARTIFACTS,
  PROMPT_CONTENT,
  PROMPT_RELATIVE_PATH,
  STEERING_MARKER_BEGIN,
  STEERING_MARKER_END,
  STEERING_PRIMARY_RELATIVE_PATH,
  STEERING_SECTION,
  agentPath,
  copilotInstructionsPath,
  hasSteeringSection,
  installSteering,
  promptPath,
  removeSteering,
  removeSteeringSection,
  STEERING_REVISION,
  installOutcome,
  ownedRevision,
  steeringInstalled,
  steeringStatus,
  upsertSteeringSection,
  userSteeringStatus,
  installUserSteering,
  isOwned,
  removeUserSteering,
  userAgentDir,
  userAgentIsForeign,
  userAgentPath,
  userSteeringInstalled,
} from '../src/steering';
import { buildStatusReport } from '../src/status';
import { createLedgerSource } from '../src/ledger-source';
import { tempDir } from './fixtures';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe('agent content (the deterministic lever)', () => {
  it('is a .agent.md whose tools allowlist excludes the built-in read/search', () => {
    // format per code.visualstudio.com/docs/agent-customization/custom-agents
    // (fetched 2026-06-18): `tools` is an allowlist; omitting the `read`/
    // `search` toolsets removes the built-in file read + codebase search.
    expect(AGENT_CONTENT.startsWith('---\n')).toBe(true);
    expect(AGENT_CONTENT).toContain(
      "tools: ['compressorRead', 'compressorSearch', 'compressorOutline', 'compressorExecute', 'compressorLog', 'edit']",
    );
    // the built-in read/search toolsets must NOT be listed (they would re-grant
    // the built-in read and defeat the allowlist). 'compressorRead' /
    // 'compressorSearch' do not contain the quoted bare tokens.
    expect(AGENT_CONTENT).not.toContain("'read'");
    expect(AGENT_CONTENT).not.toContain("'search'");
    expect(AGENT_RELATIVE_PATH).toBe(path.join('.github', 'agents', 'compressor.agent.md'));
    expect(STEERING_PRIMARY_RELATIVE_PATH).toBe(AGENT_RELATIVE_PATH);
  });
});

describe('prompt content (/compressor slash command)', () => {
  it('is a .prompt.md that runs under the compressor agent', () => {
    // format per code.visualstudio.com/docs/agent-customization/prompt-files
    expect(PROMPT_CONTENT.startsWith('---\n')).toBe(true);
    expect(PROMPT_CONTENT).toContain('agent: compressor');
    expect(PROMPT_CONTENT).toContain('compressorRead');
    expect(PROMPT_RELATIVE_PATH).toBe(path.join('.github', 'prompts', 'compressor.prompt.md'));
  });
});

describe('shared-file marked section (copilot-instructions.md)', () => {
  it('uses distinct markers — NOT the library pack grammar', () => {
    expect(STEERING_MARKER_BEGIN).toBe('<!-- compressor-vscode:steering:begin -->');
    expect(STEERING_MARKER_END).toBe('<!-- compressor-vscode:steering:end -->');
    // must not collide with `compressor init`'s <!-- compressor:begin mode=… -->
    expect(STEERING_MARKER_BEGIN).not.toMatch(/^<!-- compressor:begin mode=\S+ v=\d+ -->$/);
    expect(STEERING_SECTION.startsWith(STEERING_MARKER_BEGIN)).toBe(true);
    expect(STEERING_SECTION.endsWith(STEERING_MARKER_END)).toBe(true);
    expect(STEERING_SECTION).toContain('#compressorRead');
    expect(COPILOT_INSTRUCTIONS_RELATIVE_PATH).toBe(
      path.join('.github', 'copilot-instructions.md'),
    );
  });

  it('upserts into an empty file as just our section', () => {
    expect(upsertSteeringSection(null)).toBe(`${STEERING_SECTION}\n`);
    expect(upsertSteeringSection('   \n')).toBe(`${STEERING_SECTION}\n`);
  });

  it('appends after user content, then replaces in place (idempotent)', () => {
    const user = '# House rules\n\nBe concise.\n';
    const once = upsertSteeringSection(user);
    expect(once).toContain('Be concise.');
    expect(hasSteeringSection(once)).toBe(true);
    expect(occurrences(once, STEERING_MARKER_BEGIN)).toBe(1);

    const twice = upsertSteeringSection(once);
    expect(occurrences(twice, STEERING_MARKER_BEGIN)).toBe(1);
    expect(twice).toContain('Be concise.');
  });

  it('removes only our section, leaving user bytes intact', () => {
    const user = '# House rules\n\nBe concise.\n';
    const withSection = upsertSteeringSection(user);
    const stripped = removeSteeringSection(withSection);
    expect(hasSteeringSection(stripped)).toBe(false);
    expect(stripped).toContain('Be concise.');
    expect(stripped).not.toContain('compressor');
  });

  it('does not disturb a foreign library-pack marker block', () => {
    const pack =
      '<!-- compressor:begin mode=optimized v=1 -->\npack body\n<!-- compressor:end -->\n';
    const withSection = upsertSteeringSection(pack);
    expect(withSection).toContain('<!-- compressor:begin mode=optimized v=1 -->');
    expect(withSection).toContain('pack body');
    const stripped = removeSteeringSection(withSection);
    expect(stripped).toContain('<!-- compressor:begin mode=optimized v=1 -->');
    expect(stripped).toContain('pack body');
    expect(hasSteeringSection(stripped)).toBe(false);
  });
});

describe('install/remove round-trip', () => {
  it('installs owned files + the marked section, then removes and prunes', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-');
    expect(await steeringInstalled(projectDir)).toBe(false);

    const written = await installSteering(projectDir);
    expect(written).toEqual([
      agentPath(projectDir),
      promptPath(projectDir),
      copilotInstructionsPath(projectDir),
    ]);
    expect(await readFile(agentPath(projectDir), 'utf8')).toBe(AGENT_CONTENT);
    expect(await readFile(promptPath(projectDir), 'utf8')).toBe(PROMPT_CONTENT);
    expect(hasSteeringSection(await readFile(copilotInstructionsPath(projectDir), 'utf8'))).toBe(
      true,
    );
    expect(await steeringInstalled(projectDir)).toBe(true);

    // extension-owned: install over a hand-edited file restores our content
    await writeFile(agentPath(projectDir), 'hand edited', 'utf8');
    await installSteering(projectDir);
    expect(await readFile(agentPath(projectDir), 'utf8')).toBe(AGENT_CONTENT);

    await removeSteering(projectDir);
    expect(await steeringInstalled(projectDir)).toBe(false);
    // owned dirs we created are pruned
    for (const artifact of OWNED_ARTIFACTS) {
      expect(await exists(path.dirname(path.join(projectDir, artifact.relativePath)))).toBe(false);
    }
    // copilot-instructions.md was ours alone here → deleted on remove
    expect(await exists(copilotInstructionsPath(projectDir))).toBe(false);
  });

  it('preserves a pre-existing copilot-instructions.md on install and remove', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-shared-');
    const shared = copilotInstructionsPath(projectDir);
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, '# House rules\n\nBe concise.\n', 'utf8');

    await installSteering(projectDir);
    const installed = await readFile(shared, 'utf8');
    expect(installed).toContain('Be concise.');
    expect(hasSteeringSection(installed)).toBe(true);

    await removeSteering(projectDir);
    expect(await exists(shared)).toBe(true); // not ours to delete
    const after = await readFile(shared, 'utf8');
    expect(after).toContain('Be concise.');
    expect(hasSteeringSection(after)).toBe(false);
  });

  it('keeps an owned dir when foreign files live there', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-foreign-');
    const dir = path.dirname(agentPath(projectDir));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'other.agent.md'), 'theirs', 'utf8');

    await installSteering(projectDir);
    await removeSteering(projectDir);

    expect(await exists(path.join(dir, 'other.agent.md'))).toBe(true);
    expect(await exists(dir)).toBe(true);
  });
});

describe('user-profile steering (~/.copilot/agents)', () => {
  it('shares the workspace tools allowlist but drops workspace-specific wording', () => {
    const tools = /^tools: (.+)$/m;
    expect(tools.exec(USER_AGENT_CONTENT)?.[1]).toBe(tools.exec(AGENT_CONTENT)?.[1]);
    // custom agents have no namespace, so identity must not rest on the filename
    expect(USER_AGENT_CONTENT).toContain('name: compressor');
    expect(AGENT_CONTENT).toContain('name: compressor');
    expect(isOwned(USER_AGENT_CONTENT)).toBe(true);
    // an agent offered in every workspace must not claim to be about one repo
    expect(USER_AGENT_CONTENT).not.toContain('this workspace');
    expect(USER_AGENT_CONTENT).not.toContain('this repo');
    expect(AGENT_CONTENT).toContain('this workspace');
  });

  it('installs and removes the agent, pruning only a folder it emptied', async () => {
    const home = await tempDir('compressor-vscode-steering-userhome-');
    expect(await userSteeringInstalled(home)).toBe(false);

    const touched = await installUserSteering(home);
    expect(touched).toEqual([path.join(home, '.copilot', 'agents', 'compressor.agent.md')]);
    expect(await readFile(userAgentPath(home), 'utf8')).toBe(USER_AGENT_CONTENT);
    expect(await userSteeringInstalled(home)).toBe(true);

    await removeUserSteering(home);
    expect(await userSteeringInstalled(home)).toBe(false);
    expect(await exists(userAgentDir(home))).toBe(false);
  });

  it("keeps the agents folder when somebody else's agent lives there", async () => {
    const home = await tempDir('compressor-vscode-steering-userhome-');
    await installUserSteering(home);
    const neighbour = path.join(userAgentDir(home), 'reviewer.agent.md');
    await writeFile(neighbour, 'not ours', 'utf8');

    await removeUserSteering(home);
    expect(await exists(userAgentPath(home))).toBe(false);
    expect(await readFile(neighbour, 'utf8')).toBe('not ours');
  });

  it("leaves somebody else's compressor agent in place on remove", async () => {
    // custom agents share one namespace, so a `compressor` agent in the user
    // profile is not necessarily ours to delete
    const home = await tempDir('compressor-vscode-steering-userhome-');
    const foreign = '---\nname: compressor\n---\nsomeone else\n';
    await mkdir(userAgentDir(home), { recursive: true });
    await writeFile(userAgentPath(home), foreign, 'utf8');

    expect(await removeUserSteering(home)).toEqual([]);
    expect(await readFile(userAgentPath(home), 'utf8')).toBe(foreign);

    // the command path deletes it only after the user has confirmed
    expect(await removeUserSteering(home, { force: true }))
      .toEqual([userAgentPath(home)]);
    expect(await exists(userAgentPath(home))).toBe(false);
  });

  it('detects a foreign compressor agent so an install cannot silently replace it', async () => {
    const home = await tempDir('compressor-vscode-steering-userhome-');
    expect(await userAgentIsForeign(home)).toBe(false); // absent is not foreign

    await mkdir(userAgentDir(home), { recursive: true });
    await writeFile(userAgentPath(home), '---\nname: compressor\n---\nsomeone else\n', 'utf8');
    expect(await userAgentIsForeign(home)).toBe(true);

    await installUserSteering(home);
    expect(await userAgentIsForeign(home)).toBe(false);
  });
});

describe('revision tracking (older installs must be updatable)', () => {
  it('stamps a revision that survives reading back', () => {
    expect(ownedRevision(AGENT_CONTENT)).toBe(STEERING_REVISION);
    expect(ownedRevision(USER_AGENT_CONTENT)).toBe(STEERING_REVISION);
    expect(ownedRevision('no marker here')).toBeUndefined();
  });

  it('treats a file stamped by an older revision as ours, and as outdated', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-rev-');
    await installSteering(projectDir);
    expect(await steeringStatus(projectDir)).toEqual({ state: 'current', revision: STEERING_REVISION });

    // simulate what an earlier extension version left behind
    const older = AGENT_CONTENT
      .replace(`v=${STEERING_REVISION} -->`, 'v=0 -->')
      .replace(/^tools: .*$/m, "tools: ['compressorRead', 'edit']");
    await writeFile(agentPath(projectDir), older, 'utf8');

    const stale = await steeringStatus(projectDir);
    expect(stale).toEqual({ state: 'outdated', revision: 0 });
    expect(isOwned(older)).toBe(true); // still ours, so it is safe to replace
    expect(installOutcome(stale, 'workspace')).toBe(`steering updated from v0 to v${STEERING_REVISION}`);

    await installSteering(projectDir);
    expect(await readFile(agentPath(projectDir), 'utf8')).toBe(AGENT_CONTENT);
    expect((await steeringStatus(projectDir)).state).toBe('current');
  });

  it('reports a pre-stamp install as outdated without inventing a revision', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-rev-');
    await installSteering(projectDir);
    await writeFile(agentPath(projectDir), '---\nname: compressor\n---\nancient\n', 'utf8');

    const stale = await steeringStatus(projectDir);
    expect(stale).toEqual({ state: 'outdated' });
    expect(installOutcome(stale, 'workspace')).toBe(`steering updated from an older build to v${STEERING_REVISION}`);
    expect(installOutcome({ state: 'absent' }, 'user')).toBe('user-profile agent installed');
  });

  it('notices a stale prompt or a stripped instructions section, not just the agent', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-rev-');
    await installSteering(projectDir);

    await writeFile(promptPath(projectDir), 'stale prompt\n', 'utf8');
    expect((await steeringStatus(projectDir)).state).toBe('outdated');

    await installSteering(projectDir);
    await writeFile(copilotInstructionsPath(projectDir), '# just my own notes\n', 'utf8');
    expect((await steeringStatus(projectDir)).state).toBe('outdated');

    await installSteering(projectDir);
    expect((await steeringStatus(projectDir)).state).toBe('current');
  });

  it('tracks the user-scope agent revision independently', async () => {
    const home = await tempDir('compressor-vscode-steering-userrev-');
    expect(await userSteeringStatus(home)).toEqual({ state: 'absent' });

    await installUserSteering(home);
    expect(await userSteeringStatus(home)).toEqual({ state: 'current', revision: STEERING_REVISION });

    await writeFile(userAgentPath(home), USER_AGENT_CONTENT.replace(`v=${STEERING_REVISION} -->`, 'v=0 -->'), 'utf8');
    expect(await userSteeringStatus(home)).toEqual({ state: 'outdated', revision: 0 });

    await installUserSteering(home);
    expect((await userSteeringStatus(home)).state).toBe('current');
  });
});

describe('status integration', () => {
  it('reports steering installed/not installed', async () => {
    const [ledgerDir, projectDir, homeDir] = await Promise.all([
      tempDir('compressor-vscode-steering-ledger-'),
      tempDir('compressor-vscode-steering-project-'),
      tempDir('compressor-vscode-steering-home-'),
    ]);
    const source = createLedgerSource(ledgerDir);

    const before = await buildStatusReport({ projectDir, homeDir, source });
    expect(before).toContain(
      'copilot steering (compressor agent + /compressor): not installed — run "Compressor: Enable Copilot Steering"',
    );

    await installSteering(projectDir);
    const after = await buildStatusReport({ projectDir, homeDir, source });
    expect(after).toContain(
      `copilot steering (compressor agent + /compressor): installed at ${STEERING_PRIMARY_RELATIVE_PATH} (v${STEERING_REVISION})`,
    );
  });

  it('reports user-profile steering and warns when both scopes define the agent', async () => {
    const [ledgerDir, projectDir, homeDir] = await Promise.all([
      tempDir('compressor-vscode-steering-ledger-'),
      tempDir('compressor-vscode-steering-project-'),
      tempDir('compressor-vscode-steering-home-'),
    ]);
    const source = createLedgerSource(ledgerDir);

    expect(await buildStatusReport({ projectDir, homeDir, source }))
      .toContain('copilot steering (user profile): not installed');

    await installUserSteering(homeDir);
    const withUser = await buildStatusReport({ projectDir, homeDir, source });
    expect(withUser).toContain(`copilot steering (user profile): installed at ${userAgentPath(homeDir)} (v${STEERING_REVISION})`);
    expect(withUser).not.toContain('both define a "compressor" agent');

    await installSteering(projectDir);
    expect(await buildStatusReport({ projectDir, homeDir, source }))
      .toContain('both define a "compressor" agent');
  });

  it('flags an out-of-date install and names the fix', async () => {
    const [ledgerDir, projectDir, homeDir] = await Promise.all([
      tempDir('compressor-vscode-steering-ledger-'),
      tempDir('compressor-vscode-steering-project-'),
      tempDir('compressor-vscode-steering-home-'),
    ]);
    await installSteering(projectDir);
    await writeFile(agentPath(projectDir), AGENT_CONTENT.replace(`v=${STEERING_REVISION} -->`, 'v=0 -->'), 'utf8');

    const report = await buildStatusReport({ projectDir, homeDir, source: createLedgerSource(ledgerDir) });
    expect(report).toContain(`OUT OF DATE (v0; this build writes v${STEERING_REVISION})`);
    expect(report).toContain('re-run "Compressor: Enable Copilot Steering" to update');
  });

  it('reports user-profile steering with no workspace folder open', async () => {
    const [ledgerDir, homeDir] = await Promise.all([
      tempDir('compressor-vscode-steering-ledger-'),
      tempDir('compressor-vscode-steering-home-'),
    ]);
    await installUserSteering(homeDir);
    const report = await buildStatusReport({ projectDir: undefined, homeDir, source: createLedgerSource(ledgerDir) });
    expect(report).toContain('no workspace folder open');
    expect(report).toContain('copilot steering (user profile): installed');
  });
});
