import { describe, expect, it } from 'vitest';
import { createProjectResolver } from '../src/project-resolver';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// an options object, so an explicitly absent folder is not swallowed by a
// default parameter the way `folder = '/w/project'` would swallow undefined
function harness(
  salt: () => Promise<string | undefined>,
  opts: { folder?: string } = { folder: '/w/project' },
) {
  let calls = 0;
  const resolve = createProjectResolver({
    salt: () => { calls += 1; return salt(); },
    folder: () => opts.folder,
    mode: () => 'hashed',
    label: (path, mode, key) => `${path}|${mode}|${key}`,
  });
  return { resolve, calls: () => calls };
}

describe('project resolver', () => {
  it('never touches the key when recording is switched off', async () => {
    // resolving a label reads and can CREATE ~/.compressor/project-salt, so a
    // user who set COMPRESSOR_NO_LEDGER=1 must not get a key written anyway
    let calls = 0;
    const resolve = createProjectResolver({
      salt: async () => { calls += 1; return 'key'; },
      folder: () => '/w/project',
      mode: () => 'hashed',
      label: (p, m, k) => `${p}|${m}|${k}`,
      disabled: () => true,
    });
    await settle();
    expect(calls).toBe(0);
    expect(resolve()).toBeUndefined();
    await settle();
    expect(calls).toBe(0);
  });

  it('labels once the key arrives', async () => {
    const h = harness(async () => 'key1');
    expect(h.resolve()).toBeUndefined(); // still loading
    await settle();
    expect(h.resolve()).toBe('/w/project|hashed|key1');
  });

  it('recovers instead of leaving the whole window unlabelled', async () => {
    // the observed failure: one attempt at activation, and a window that
    // started too fast recorded 101 of 144 events with no label
    let attempt = 0;
    const h = harness(async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('key unavailable');
      return 'key-late';
    });
    await settle();
    expect(h.resolve()).toBeUndefined();
    await settle();
    expect(h.resolve()).toBeUndefined();
    await settle();
    expect(h.resolve()).toBe('/w/project|hashed|key-late');
  });

  it('retries an undefined key too, not just a rejection', async () => {
    let attempt = 0;
    const h = harness(async () => (++attempt < 2 ? undefined : 'key2'));
    await settle();
    expect(h.resolve()).toBeUndefined();
    await settle();
    expect(h.resolve()).toBe('/w/project|hashed|key2');
  });

  it('keeps at most one load in flight and stops once loaded', async () => {
    const h = harness(async () => 'key3');
    for (let i = 0; i < 20; i += 1) h.resolve(); // a burst of events
    expect(h.calls()).toBe(1);
    await settle();
    for (let i = 0; i < 20; i += 1) expect(h.resolve()).toBe('/w/project|hashed|key3');
    expect(h.calls()).toBe(1); // no reload once it is known
  });

  it('records no label when no folder is open, without burning retries', async () => {
    const h = harness(async () => 'key4', {});
    await settle();
    expect(h.resolve()).toBeUndefined();
    expect(h.calls()).toBe(1);
  });
});
