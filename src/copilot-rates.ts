import * as path from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { blendInputRate, parseCopilotCatalog } from '@astudioplus/compressor';
import type { ValuationRate } from '@astudioplus/compressor';

// Copilot credit rates, read from the catalog VS Code's Copilot Chat writes
// next to its own debug logs (models.json). That file states the user's real
// per-model prices in credits per 1M tokens, so nothing here is a maintained
// price list that could go stale — when the catalog is absent the extension
// reports no value at all rather than a guess.
//
// This module owns the IO; all parsing and arithmetic lives in the library.

/** models.json lives under this folder inside a workspace-storage directory. */
const COPILOT_DIR = 'GitHub.copilot-chat';
const DEBUG_LOGS_DIR = 'debug-logs';
const CATALOG_NAME = 'models.json';

/**
 * The workspace-storage directory for this window.
 *
 * Derived from the extension's own storage path (…/workspaceStorage/<id>/<ext>)
 * rather than rebuilt from per-OS install locations: the parent is by
 * definition the right directory for THIS window, which also keeps the read
 * scoped to the current workspace instead of scanning every workspace the user
 * has ever opened.
 */
export function workspaceStorageDir(extensionStoragePath: string | undefined): string | undefined {
  return extensionStoragePath === undefined ? undefined : path.dirname(extensionStoragePath);
}

/** Newest models.json under a workspace-storage dir; undefined when absent. */
async function findCatalog(storageDir: string): Promise<string | undefined> {
  const logsDir = path.join(storageDir, COPILOT_DIR, DEBUG_LOGS_DIR);
  let sessions: string[];
  try {
    sessions = await readdir(logsDir);
  } catch {
    return undefined;
  }
  let newest: string | undefined;
  let newestMtime = -Infinity;
  for (const session of sessions) {
    const candidate = path.join(logsDir, session, CATALOG_NAME);
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.mtimeMs > newestMtime) {
        newestMtime = info.mtimeMs;
        newest = candidate;
      }
    } catch {
      // no catalog for this session
    }
  }
  return newest;
}

/**
 * Resolve the rate used to value ledger savings.
 *
 * The model is the one the catalog itself marks as the chat default, which is
 * a fact rather than a guess; a configured override wins when the user knows
 * better. Best-effort throughout: any failure yields undefined and the report
 * falls back to its token-only form.
 */
export async function resolveValuationRate(
  storageDir: string | undefined,
  configuredModel?: string,
): Promise<ValuationRate | undefined> {
  if (storageDir === undefined) {
    return undefined;
  }
  const catalogPath = await findCatalog(storageDir);
  if (catalogPath === undefined) {
    return undefined;
  }
  let raw: string;
  try {
    raw = await readFile(catalogPath, 'utf8');
  } catch {
    return undefined;
  }
  const { rates, defaultModelId } = parseCopilotCatalog(raw);
  const configured = configuredModel?.trim();
  const modelId = configured !== undefined && configured !== '' ? configured : defaultModelId;
  if (modelId === undefined) {
    return undefined;
  }
  const blended = blendInputRate([{ modelId, weight: 1 }], rates);
  if (blended === undefined) {
    return undefined;
  }
  return {
    ...blended,
    source:
      configured !== undefined && configured !== ''
        ? `your Copilot model catalog (compressor.pricingModel: ${configured})`
        : "your Copilot model catalog (this account's default chat model)",
  };
}
