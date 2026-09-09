# Tune and inspect

- **Mode** — the status-bar `compressor: <mode>` item switches the read tool
  between `optimized` (preserve source, dedupe logs), `slim` (preserve source,
  compact search), and `full` (uncompressed reads/search). Explicit outline and
  command-summary tools still summarize.
- **Count Tokens** — exact chars and an estimated token count for the active
  file or selection.
- **Preview Compression** — a side-by-side diff of what `compressor_read` would
  return for the current file or selection. No file writes; preview does not
  simulate optional model-host budgets.

Full guide and example prompts: [Usage](../../docs/USAGE.md).
