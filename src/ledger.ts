import { appendLedger } from '@astudioplus/compressor';
import type { LedgerEvent } from '@astudioplus/compressor';

// Every ledger write in this extension goes through here so the project label
// is attached in exactly one place. The label itself comes from the library
// (projectLabel + the shared key), which also reads it back and renders the
// 'by project' breakdown, so nothing here needs to know the format.

let resolveProject: () => string | undefined = () => undefined;

/** Set at activation; re-evaluated per event so config changes take effect. */
export function setProjectResolver(resolver: () => string | undefined): void {
  resolveProject = resolver;
}

export function resetProjectResolver(): void {
  resolveProject = () => undefined;
}

/** Fire-and-forget, fail-open: a ledger problem is never the tool's problem. */
export async function recordEvent(event: LedgerEvent): Promise<void> {
  let project: string | undefined;
  try {
    project = resolveProject();
  } catch {
    project = undefined; // a bad resolver must not lose the event
  }
  return appendLedger(project === undefined || project === '' ? event : { ...event, project });
}
