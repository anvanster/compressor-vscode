import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard the Getting Started walkthrough so a renamed command or moved media
// file fails CI instead of shipping a broken onboarding panel.

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: Array<{ command: string }>;
    walkthroughs: Array<{
      id: string;
      steps: Array<{ id: string; description: string; media: { markdown?: string }; completionEvents?: string[] }>;
    }>;
  };
};

const walkthrough = pkg.contributes.walkthroughs[0];
if (walkthrough === undefined) {
  throw new Error('package.json contributes no walkthrough');
}
const commandIds = new Set(pkg.contributes.commands.map((c) => c.command));

describe('getting-started walkthrough', () => {
  it('exists with steps', () => {
    expect(walkthrough?.id).toBe('compressor.gettingStarted');
    expect(walkthrough.steps.length).toBeGreaterThanOrEqual(4);
  });

  it('every step media file is present (and ships — outside .vscodeignore)', () => {
    for (const step of walkthrough.steps) {
      const md = step.media.markdown;
      expect(md, `step ${step.id} has markdown media`).toBeTruthy();
      expect(existsSync(path.join(root, md as string)), `${md} exists`).toBe(true);
    }
  });

  it('every command link and completion event references a contributed command', () => {
    for (const step of walkthrough.steps) {
      for (const m of step.description.matchAll(/command:([\w.]+)/g)) {
        const id = m[1];
        if (id !== undefined) {
          expect(commandIds.has(id), `${id} is contributed`).toBe(true);
        }
      }
      for (const ev of step.completionEvents ?? []) {
        const cmd = /^onCommand:([\w.]+)$/.exec(ev)?.[1];
        if (cmd !== undefined) {
          expect(commandIds.has(cmd), `${cmd} is contributed`).toBe(true);
        }
      }
    }
  });
});
