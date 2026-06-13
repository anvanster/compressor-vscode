import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STEERING_CONTENT,
  STEERING_RELATIVE_PATH,
  installSteering,
  removeSteering,
  steeringInstalled,
  steeringPath,
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

describe('steering content', () => {
  it('uses the doc-verified instructions format and tool-reference syntax', () => {
    // format per code.visualstudio.com/docs/agent-customization/custom-instructions
    // (fetched 2026-06-12): applyTo glob frontmatter, #tool:<name> references
    expect(STEERING_CONTENT.startsWith('---\n')).toBe(true);
    expect(STEERING_CONTENT).toContain('applyTo: "**"');
    expect(STEERING_CONTENT).toContain('#tool:compressorRead');
    expect(STEERING_CONTENT).toContain('offset and limit');
    expect(STEERING_CONTENT).not.toContain('%'); // no percentage claims
    expect(STEERING_RELATIVE_PATH).toBe(
      path.join('.github', 'instructions', 'compressor-vscode.instructions.md'),
    );
  });
});

describe('install/remove round-trip', () => {
  it('installs (overwrite), reports installed, removes, prunes an empty dir', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-');
    expect(await steeringInstalled(projectDir)).toBe(false);

    const file = await installSteering(projectDir);
    expect(file).toBe(steeringPath(projectDir));
    expect(await readFile(file, 'utf8')).toBe(STEERING_CONTENT);
    expect(await steeringInstalled(projectDir)).toBe(true);

    // extension-owned: install over a hand-edited file restores our content
    await writeFile(file, 'hand edited', 'utf8');
    await installSteering(projectDir);
    expect(await readFile(file, 'utf8')).toBe(STEERING_CONTENT);

    await removeSteering(projectDir);
    expect(await steeringInstalled(projectDir)).toBe(false);
    // empty instructions dir we created is pruned
    expect(await exists(path.dirname(file))).toBe(false);
  });

  it('keeps the instructions dir when foreign files live there', async () => {
    const projectDir = await tempDir('compressor-vscode-steering-foreign-');
    const dir = path.dirname(steeringPath(projectDir));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'other.instructions.md'), 'theirs', 'utf8');

    await installSteering(projectDir);
    await removeSteering(projectDir);

    expect(await exists(path.join(dir, 'other.instructions.md'))).toBe(true);
    expect(await exists(dir)).toBe(true);
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
      'copilot steering (#compressorRead): not installed — run "Compressor: Enable Copilot Steering"',
    );

    await installSteering(projectDir);
    const after = await buildStatusReport({ projectDir, homeDir, source });
    expect(after).toContain(
      `copilot steering (#compressorRead): installed (${STEERING_RELATIVE_PATH})`,
    );
  });
});
