import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveValuationRate, workspaceStorageDir } from '../src/copilot-rates';
import { tempDir } from './fixtures';

// The catalog VS Code's Copilot Chat writes is the only rate source; these
// cover locating it, reading it, and every way it can be missing.

const catalog = (entries: unknown[]) => JSON.stringify(entries);

const GPT = {
  id: 'gpt-5.2',
  is_chat_default: true,
  capabilities: { family: 'gpt-5.2' },
  billing: {
    token_prices: { default: { input_price: 175, output_price: 1400, cache_read_price: 17 } },
  },
};

const CLAUDE = {
  id: 'claude-sonnet-4.5',
  capabilities: { family: 'claude-sonnet-4.5' },
  billing: {
    token_prices: { default: { input_price: 300, output_price: 1500, cache_read_price: 30 } },
  },
};

/** Lay out a workspace-storage dir the way VS Code does, and return it. */
async function storageWithCatalog(body: string, session = 'session-a'): Promise<string> {
  const dir = await tempDir('compressor-rates-');
  const logs = path.join(dir, 'GitHub.copilot-chat', 'debug-logs', session);
  await mkdir(logs, { recursive: true });
  await writeFile(path.join(logs, 'models.json'), body, 'utf8');
  return dir;
}

describe('workspaceStorageDir', () => {
  it('is the parent of the extension storage path, not a rebuilt OS path', () => {
    expect(workspaceStorageDir('/data/User/workspaceStorage/abc123/astudioplus.compressor'))
      .toBe('/data/User/workspaceStorage/abc123');
    expect(workspaceStorageDir(undefined)).toBeUndefined();
  });
});

describe('resolveValuationRate', () => {
  it("prices at the catalog's own default chat model", async () => {
    const dir = await storageWithCatalog(catalog([CLAUDE, GPT]));
    const rate = await resolveValuationRate(dir);
    expect(rate?.creditsPerMillionInput).toBe(175);
    expect(rate?.cachedCreditsPerMillionInput).toBe(17);
    expect(rate?.models).toEqual(['gpt-5.2']);
    expect(rate?.source).toContain('default chat model');
  });

  it('honours a configured model and says so in the provenance', async () => {
    const dir = await storageWithCatalog(catalog([CLAUDE, GPT]));
    const rate = await resolveValuationRate(dir, 'claude-sonnet-4.5');
    expect(rate?.creditsPerMillionInput).toBe(300);
    expect(rate?.source).toContain('claude-sonnet-4.5');
  });

  it('falls back to the catalog default when the configured model is unpriceable', async () => {
    const dir = await storageWithCatalog(catalog([GPT]));
    expect(await resolveValuationRate(dir, 'a-model-that-does-not-exist')).toBeUndefined();
  });

  it('prefers the newest catalog when several sessions have one', async () => {
    const dir = await storageWithCatalog(catalog([GPT]), 'older');
    const newer = path.join(dir, 'GitHub.copilot-chat', 'debug-logs', 'newer');
    await mkdir(newer, { recursive: true });
    await writeFile(
      path.join(newer, 'models.json'),
      catalog([{ ...CLAUDE, is_chat_default: true }]),
      'utf8',
    );
    const rate = await resolveValuationRate(dir);
    expect(rate?.models).toEqual(['claude-sonnet-4.5']);
  });

  it('yields no rate rather than a guess when nothing is readable', async () => {
    expect(await resolveValuationRate(undefined)).toBeUndefined();
    expect(await resolveValuationRate(await tempDir('compressor-rates-empty-'))).toBeUndefined();
    expect(await resolveValuationRate(await storageWithCatalog('{ not json'))).toBeUndefined();
    // a catalog that names no default leaves nothing to price with
    expect(await resolveValuationRate(await storageWithCatalog(catalog([CLAUDE])))).toBeUndefined();
  });
});
