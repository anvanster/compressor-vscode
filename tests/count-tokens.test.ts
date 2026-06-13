import { describe, expect, it } from 'vitest';
import { countText, formatCount } from '../src/count-tokens';

describe('countText', () => {
  it('counts chars exactly and tokens via chars/3.5', () => {
    const r = countText('hello world', 'file');
    expect(r.chars).toBe(11);
    expect(r.estTokens).toBe(Math.ceil(11 / 3.5));
    expect(r.lines).toBe(1);
    expect(r.scope).toBe('file');
  });

  it('counts lines and reports the selection scope', () => {
    const r = countText('a\nb\nc', 'selection');
    expect(r.lines).toBe(3);
    expect(r.scope).toBe('selection');
  });

  it('reports zero lines for empty text', () => {
    expect(countText('', 'file').lines).toBe(0);
  });
});

describe('formatCount', () => {
  it('labels chars exact, tokens estimated and not billable', () => {
    const msg = formatCount(countText('x'.repeat(3500), 'file'));
    expect(msg).toContain('chars (exact)');
    expect(msg).toContain('estimated, chars/3.5 — not billable');
    expect(msg).toContain('file');
    expect(msg).not.toContain('%');
  });
});
