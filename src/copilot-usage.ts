import * as path from 'path';
import { readdir, readFile, stat } from 'fs/promises';
import { aggregateCopilotUsage, emptyProbe, probeDebugLog, readLlmRequests } from '@astudioplus/compressor';
import type { DebugLogProbe, LlmRequest, UsageSummary } from '@astudioplus/compressor';

// Reads the chat debug logs Copilot writes beside its model catalog, under
// <workspaceStorage>/GitHub.copilot-chat/debug-logs/<sessionId>/*.jsonl.
//
// Resolving the directory from the extension's own storage path means this
// works unchanged over remote-SSH, where the extension host (and therefore the
// logs) live on the remote machine rather than under a local install path.
//
// All parsing lives in the library; this module only decides which bytes to read.

const COPILOT_DIR = 'GitHub.copilot-chat';
const DEBUG_LOGS_DIR = 'debug-logs';

/**
 * Total bytes to read across a window. The writer retains up to 50 session
 * directories and allows 100 MB per log, so an unbounded read could pull
 * gigabytes into the extension host to render one report. Overshoot is
 * reported rather than hidden — see {@link CopilotUsage.truncated}.
 */
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export interface CopilotUsage {
  summary: UsageSummary;
  /** what the logs actually contained, for honest empty states */
  probe: DebugLogProbe;
  /** session directories considered */
  sessionDirs: number;
  /** true when the byte budget stopped the read before every log was covered */
  truncated: boolean;
}

/** Log files for one session: the parent plus any child/subagent logs. */
async function sessionLogFiles(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir))
      .filter((name) => name.endsWith('.jsonl'))
      // main.jsonl first: it is the parent session, and the budget may cut the rest
      .sort((a, b) => Number(b === 'main.jsonl') - Number(a === 'main.jsonl'))
      .map((name) => path.join(sessionDir, name));
  } catch {
    return [];
  }
}

/**
 * Model calls recorded for this workspace within the window.
 *
 * Best-effort at every step: an unreadable directory or file is skipped, not
 * fatal. Sessions whose log was last written before the window are skipped
 * without being read, which is what keeps a 30-day report cheap on a machine
 * with 50 retained sessions.
 */
export async function readCopilotUsage(
  storageDir: string | undefined,
  sinceMs?: number,
): Promise<CopilotUsage | undefined> {
  if (storageDir === undefined) {
    return undefined;
  }
  const logsDir = path.join(storageDir, COPILOT_DIR, DEBUG_LOGS_DIR);
  let sessions: string[];
  try {
    sessions = await readdir(logsDir);
  } catch {
    return undefined;
  }

  const requests: LlmRequest[] = [];
  const probe = emptyProbe();
  let budget = MAX_TOTAL_BYTES;
  let truncated = false;
  let sessionDirs = 0;

  for (const session of sessions) {
    const sessionDir = path.join(logsDir, session);
    for (const file of await sessionLogFiles(sessionDir)) {
      let size: number;
      try {
        const info = await stat(file);
        // mtime is the last flush: a log untouched since before the window
        // cannot hold an in-window request.
        if (sinceMs !== undefined && info.mtimeMs < sinceMs) {
          continue;
        }
        size = info.size;
      } catch {
        continue;
      }
      if (size > budget) {
        truncated = true;
        continue;
      }
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      budget -= size;
      probeDebugLog(text, probe);
      requests.push(...readLlmRequests(text, sinceMs));
    }
    sessionDirs += 1;
  }

  return {
    summary: aggregateCopilotUsage(requests),
    probe,
    sessionDirs,
    truncated,
  };
}
