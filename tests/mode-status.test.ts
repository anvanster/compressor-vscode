import { describe, expect, it } from 'vitest';
import { formatModeItem, modeOptions } from '../src/mode-status';

describe('formatModeItem', () => {
  it('shows the fold icon and current mode, with a click hint', () => {
    const view = formatModeItem('optimized');
    expect(view.text).toBe('$(fold) compressor: optimized');
    expect(view.tooltip).toContain('Click to change');
    expect(view.tooltip).toContain('optimized');
  });

  it('describes what full does (off)', () => {
    expect(formatModeItem('full').tooltip).toContain('off (passthrough)');
  });
});

describe('modeOptions', () => {
  it('offers all three modes in a stable order', () => {
    expect(modeOptions('optimized').map((o) => o.label)).toEqual(['optimized', 'slim', 'full']);
  });

  it('marks the current mode', () => {
    const opts = modeOptions('slim');
    expect(opts.find((o) => o.label === 'slim')?.description).toContain('current');
    expect(opts.find((o) => o.label === 'full')?.description).not.toContain('current');
  });
});
