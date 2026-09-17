import { describe, expect, it } from 'vitest';
import { aggregateCopilotUsage, emptyProbe } from '@astudioplus/compressor';
import { buildSavingsHtml } from '../src/savings-panel';
import { event } from './fixtures';

describe('buildSavingsHtml', () => {
  it('produces the self-contained report with charts and honest labels', () => {
    const html = buildSavingsHtml(
      [event('2026-06-10T12:00:00.000Z'), event('2026-06-11T09:00:00.000Z')],
      '/home/user/.compressor/ledger',
      '30d',
    );
    expect(html).toContain('<svg');
    expect(html).toContain('estimated');
    expect(html).toContain('last 30 days'); // totals must state their window
    expect(html).not.toContain('<script'); // static report, scripts stay disabled
  });

  it('places the stale-steering banner inside the body, whatever the tag carries', () => {
    const html = buildSavingsHtml([event('2026-06-10T12:00:00.000Z')], '/tmp/ledger', '30d', undefined, {
      steeringNotice: 'Steering is out of date',
    });
    expect(html).toContain('Steering is out of date');
    expect(html.indexOf('Steering is out of date')).toBeGreaterThan(html.indexOf('<body'));
    expect(html.indexOf('Steering is out of date')).toBeLessThan(html.indexOf('<h1'));
  });

  it('omits the priced view when no rate was resolved', () => {
    const html = buildSavingsHtml([event('2026-06-10T12:00:00.000Z')], '/tmp/ledger', '30d');
    expect(html).not.toContain('estimated value');
  });

  it('prices only the Copilot surfaces, and names the remainder', () => {
    const html = buildSavingsHtml(
      [
        event('2026-06-10T12:00:00.000Z', { agent: 'vscode', estTokensIn: 1_000_000, estTokensOut: 0 }),
        event('2026-06-11T09:00:00.000Z', { agent: 'claude-code', estTokensIn: 500_000, estTokensOut: 0 }),
      ],
      '/tmp/ledger',
      '30d',
      undefined,
      { rate: { creditsPerMillionInput: 100, models: ['gpt-5.2'], source: 'your Copilot model catalog' } },
    );
    expect(html).toContain('estimated value');
    expect(html).toContain('$1.00');
    expect(html).toContain('not priced');
    expect(html).toContain('Claude Code');
    expect(html).not.toContain('<script');
  });

  it('renders the empty state without charts', () => {
    const html = buildSavingsHtml([], '/tmp/none', 'all');
    expect(html).toContain('no events in this window');
    expect(html).toContain('all time');
  });

  it('scopes the reduction share to this project, so the two sources match', () => {
    const summary = aggregateCopilotUsage([
      {
        ts: Date.UTC(2026, 5, 10, 12), sessionId: 's', model: 'gpt-5.2',
        inputTokens: 3000, outputTokens: 100, durationMs: 1, status: 'ok',
      },
    ]);
    const events = [
      event('2026-06-10T12:00:00.000Z', { agent: 'vscode', project: '#here', estTokensIn: 1000, estTokensOut: 0 }),
      event('2026-06-10T13:00:00.000Z', { agent: 'vscode', project: '#elsewhere', estTokensIn: 9000, estTokensOut: 0 }),
    ];
    const html = buildSavingsHtml(events, '/tmp/ledger', '30d', undefined, {
      copilot: { summary, probe: emptyProbe(), sessionDirs: 1, truncated: false },
      projectLabel: '#here',
    });
    expect(html).toContain('actual Copilot usage');
    // 1000 / (1000 + 3000) — another project's 9000 must not enter the ratio
    expect(html).toContain('≈25.0%');
  });

  it('explains an empty usage section instead of showing zeros', () => {
    const html = buildSavingsHtml([], '/tmp/ledger', '30d', undefined, {
      copilot: {
        summary: aggregateCopilotUsage([]),
        probe: emptyProbe(),
        sessionDirs: 0,
        truncated: false,
      },
    });
    expect(html).toContain('agentDebugLog.fileLogging.enabled');
    expect(html).not.toContain('0 model requests');
  });
});
