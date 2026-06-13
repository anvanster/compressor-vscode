# Compressor — AI Token Savings (VS Code)

Companion extension for
[compressor](https://github.com/anvanster/compressor): a compressed file-read
tool for Copilot agent mode, a savings ticker/report over the compressor
ledger (`~/.compressor/ledger`, override with `COMPRESSOR_LEDGER_DIR`), and
manage commands for instruction packs. No network calls.

## Features

- **`compressor_read` tool** (`#compressorRead` in Copilot agent-mode chat):
  reads a workspace file through the compressor engine — comment-stripping
  that preserves line numbers, repeated-line dedupe, and recoverable
  `[compressor:]` omission markers stating the exact `offset`/`limit` to
  retrieve omitted lines. Pass `offset`/`limit` for an exact uncompressed
  range. Worthwhile compressions land in the ledger as agent `vscode`.
  Reads are confined to the open workspace folders.
- **Copilot steering** — **Compressor: Enable/Disable Copilot Steering**
  installs/removes an extension-owned
  `.github/instructions/compressor-vscode.instructions.md` nudging agent mode
  toward `#compressorRead` for files longer than ~200 lines and log/output
  files. Steering, not enforcement.
- **Ticker** (status bar): `≈12.3k tok saved (30d)` — estimated tokens saved
  in the configured window. Chars are exact; token figures are estimates from
  the cheap estimator, never billable counts. Click it for the report.
- **Compressor: Show Savings** — the savings report (by day / tool / mode) in
  a webview. Static HTML, scripts disabled.
- **Compressor: Status** — per-adapter install status for the first workspace
  folder, steering state, and ledger recency.
- **Compressor: Init / Set Mode / Uninstall** — plan instruction-pack changes
  with the library adapters, review the rendered diff, confirm, apply.
  claude-code/copilot (hook-bearing) are offered only when `compressor-hook`
  resolves on PATH; otherwise use the `compressor` CLI.

Settings: `compressor.savingsWindow` (`7d` | `30d` | `all`, default `30d`),
`compressor.mode` (`full` | `optimized` | `slim`, default `optimized` — the
read tool's compression mode; `full` = passthrough).

## What it does NOT do

- It **cannot compress VS Code Copilot's built-in tool output**. VS Code hooks
  cannot replace tool output (doc-verified 2026-06-12); in-IDE compression
  happens only when the agent uses `#compressorRead`. Instruction packs reach
  Copilot via `.github/copilot-instructions.md` / `AGENTS.md` — see the
  [compressor docs](https://github.com/anvanster/compressor).
- It makes no network calls and reads no file contents beyond the ledger
  JSONL and files explicitly requested through `compressor_read`.
- It shows no percentage claims; measured savings come from
  `compressor benchmark`, not this view.

## Install (from VSIX)

Not on the marketplace. Package locally and install:

```sh
npm run package            # produces compressor-vscode-0.2.0.vsix
code --install-extension compressor-vscode-0.2.0.vsix
```

Manual validation checklist: see `VALIDATION.md` in the repo.

## Development

Requires VS Code ≥ 1.95 (LanguageModelTool API) and a built `../compressor`
checkout next to this directory (the library is a `file:` dependency):

```sh
(cd ../compressor && npm install && npm run build)
npm install
npm run typecheck
npm run build      # esbuild bundle → out/extension.js
npm test           # vitest ('vscode' is aliased to a local mock)
npm run package    # vsce → .vsix
```
