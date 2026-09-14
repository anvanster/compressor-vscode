import type { ProjectLabelMode } from '@astudioplus/compressor';

// How a ledger event learns which workspace it came from.

export interface ProjectResolverDeps {
  /** reads the shared key, creating it on first use; may fail transiently */
  salt: () => Promise<string | undefined>;
  /** true when recording is switched off, so the key must not be touched */
  disabled: () => boolean;
  /** first workspace folder, or undefined when none is open */
  folder: () => string | undefined;
  mode: () => ProjectLabelMode;
  label: (workspacePath: string, mode: ProjectLabelMode, salt: string) => string;
}

const MAX_LOAD_ATTEMPTS = 12;

/**
 * The key is read asynchronously, so the first events in a window can be
 * recorded before it arrives. Attempting it once at activation left any window
 * that started too fast, or lost the creation race with another window,
 * recording unlabelled events for its entire lifetime — observed at 101 of 144
 * events in one session, 70% of the savings landing in `unattributed`.
 *
 * So retry on demand: at most one load in flight, and a failure costs only the
 * labels on events until the next attempt succeeds, rather than the window.
 *
 * Retries are capped, because a key that can never be created (an unwritable
 * home) would otherwise cost one filesystem round-trip per compression event
 * for the lifetime of the window. The cap is far above the handful of attempts
 * a lost creation race needs.
 */
export function createProjectResolver(deps: ProjectResolverDeps): () => string | undefined {
  let salt: string | undefined;
  let loading = false;
  let attempts = 0;
  const load = (): void => {
    // the eager load at activation runs before any event is recorded, so the
    // kill switch has to be honoured here too or the key is created regardless
    if (salt !== undefined || loading || attempts >= MAX_LOAD_ATTEMPTS) return;
    if (deps.disabled()) return;
    attempts += 1;
    loading = true;
    void deps.salt().then(
      (value) => {
        salt = value;
        loading = false;
      },
      () => {
        loading = false; // transient: the next event tries again
      },
    );
  };
  load();
  return () => {
    const folder = deps.folder();
    if (folder === undefined) return undefined;
    if (salt === undefined) {
      load();
      return undefined;
    }
    return deps.label(folder, deps.mode(), salt);
  };
}
