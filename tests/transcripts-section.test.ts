import { describe, expect, it } from 'vitest';
import type { SessionUsage } from '@astudioplus/compressor';
import { renderTranscriptSection, summarizeSessions } from '../src/transcripts-section';

function session(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId: 's1',
    file: '/x.jsonl',
    turns: 10,
    totals: { input: 100, output: 20, cacheCreation: 5, cacheRead: 50 },
    byModel: { 'claude-opus-4-8': { input: 100, output: 20, cacheCreation: 5, cacheRead: 50 } },
    sidechain: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    ...over,
  };
}

describe('summarizeSessions', () => {
  it('sums totals, turns and per-model usage', () => {
    const usage = summarizeSessions(
      [
        session(),
        session({
          turns: 4,
          totals: { input: 10, output: 2, cacheCreation: 0, cacheRead: 1 },
          byModel: { 'claude-haiku-4-5': { input: 10, output: 2, cacheCreation: 0, cacheRead: 1 } },
        }),
      ],
      '/ws/project',
      'last 30 days',
    );
    expect(usage.sessions).toBe(2);
    expect(usage.turns).toBe(14);
    expect(usage.totals.input).toBe(110);
    expect(Object.keys(usage.byModel).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8']);
  });

  it('merges models that appear across sessions', () => {
    const usage = summarizeSessions([session(), session()], '/ws', 'last 7 days');
    expect(usage.byModel['claude-opus-4-8']?.input).toBe(200);
  });
});

describe('renderTranscriptSection', () => {
  it('returns empty string when there is nothing to show', () => {
    expect(renderTranscriptSection(undefined)).toBe('');
    expect(
      renderTranscriptSection(summarizeSessions([], '/ws', 'last 30 days')),
    ).toBe('');
  });

  it('renders an honest usage section, never claiming savings or dollars', () => {
    const html = renderTranscriptSection(summarizeSessions([session()], '/ws', 'last 30 days'));
    expect(html).toContain('actual usage (Claude Code transcripts)');
    expect(html).toContain('not savings');
    expect(html).toContain('not billable dollars');
    expect(html).toContain('1 sessions');
    expect(html).toContain('claude-opus-4-8');
    expect(html).not.toMatch(/\d%/); // no percentage claims
  });

  it('escapes model names', () => {
    const html = renderTranscriptSection(
      summarizeSessions(
        [session({ byModel: { '<script>': { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 } } })],
        '/ws',
        'last 30 days',
      ),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
