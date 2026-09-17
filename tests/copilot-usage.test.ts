import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCopilotUsage } from '../src/copilot-usage';
import { tempDir } from './fixtures';

// Chat debug logs as VS Code lays them out:
//   <storage>/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl
// plus child logs for subagent sessions in the same directory.

const entry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1, ts: Date.UTC(2026, 8, 10, 12), dur: 0, sid: 'session-a',
    type: 'session_start', name: 'session_start', spanId: 'x', status: 'ok', attrs: {},
    ...over,
  });

const llm = (attrs: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  entry({ type: 'llm_request', name: 'chat:m', dur: 900, attrs, ...over });

async function storageWithLogs(files: Record<string, string>): Promise<string> {
  const dir = await tempDir('compressor-usage-');
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(dir, 'GitHub.copilot-chat', 'debug-logs', relative);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return dir;
}

describe('readCopilotUsage', () => {
  it('reads model calls from a session log', async () => {
    const dir = await storageWithLogs({
      'session-a/main.jsonl': [
        entry(),
        llm({ model: 'gpt-5.2', inputTokens: 1000, outputTokens: 200 }),
      ].join('\n'),
    });
    const usage = await readCopilotUsage(dir);
    expect(usage?.summary.totals.requests).toBe(1);
    expect(usage?.summary.totals.inputTokens).toBe(1000);
    expect(usage?.probe.byType['session_start']).toBe(1);
    expect(usage?.truncated).toBe(false);
  });

  it('includes child/subagent logs alongside the parent', async () => {
    const dir = await storageWithLogs({
      'session-a/main.jsonl': llm({ model: 'gpt-5.2', inputTokens: 100 }),
      'session-a/runSubagent-explore-child1.jsonl': llm(
        { model: 'gpt-5-mini', inputTokens: 40 },
        { sid: 'child1' },
      ),
    });
    const usage = await readCopilotUsage(dir);
    expect(usage?.summary.totals.requests).toBe(2);
    expect(usage?.summary.sessions).toBe(2);
    expect(usage?.summary.totals.inputTokens).toBe(140);
  });

  it('skips logs untouched since before the window without reading them', async () => {
    const dir = await storageWithLogs({
      'session-a/main.jsonl': llm({ model: 'gpt-5.2', inputTokens: 100 }),
    });
    // the fixture was just written, so a future cutoff excludes every file
    const usage = await readCopilotUsage(dir, Date.now() + 60_000);
    expect(usage?.summary.totals.requests).toBe(0);
    expect(usage?.probe.entries).toBe(0);
  });

  it('ignores non-jsonl companions in the session directory', async () => {
    const dir = await storageWithLogs({
      'session-a/main.jsonl': llm({ model: 'gpt-5.2', inputTokens: 100 }),
      'session-a/models.json': '[{"id":"gpt-5.2"}]',
      'session-a/system_prompt_0': 'you are a helpful assistant',
    });
    const usage = await readCopilotUsage(dir);
    expect(usage?.summary.totals.requests).toBe(1);
    expect(usage?.probe.malformed).toBe(0);
  });

  it('returns undefined when there is no storage dir or no logs dir', async () => {
    expect(await readCopilotUsage(undefined)).toBeUndefined();
    expect(await readCopilotUsage(await tempDir('compressor-usage-empty-'))).toBeUndefined();
  });

  it('reports an empty probe rather than failing when logging is off', async () => {
    const dir = await storageWithLogs({ 'session-a/main.jsonl': [entry(), entry()].join('\n') });
    const usage = await readCopilotUsage(dir);
    expect(usage?.summary.totals.requests).toBe(0);
    expect(usage?.probe.entries).toBe(2);
    expect(usage?.probe.byType['llm_request']).toBeUndefined();
  });
});
