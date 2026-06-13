# Tune and inspect

- **Mode** — the status-bar `compressor: <mode>` item switches the read tool
  between `optimized` (strip comments + dedupe), `slim` (also filter logs), and
  `full` (off).
- **Count Tokens** — exact chars and an estimated token count for the active
  file or selection.
- **Preview Compression** — a side-by-side diff of what `compressor_read` would
  return for the current file or selection. No file writes.

Full guide and more example prompts live in `docs/USAGE.md`.
