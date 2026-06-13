# Compressor — AI Token Savings (VS Code)

Companion extension for
[compressor](https://github.com/anvanster/compressor): a compressed file-read
tool for Copilot agent mode, a savings ticker/report over the compressor
ledger (`~/.compressor/ledger`, override with `COMPRESSOR_LEDGER_DIR`), and
manage commands for instruction packs. No network calls.

## Features

- **Three language-model tools** for Copilot agent mode, all confined to the
  open workspace folders and all recording worthwhile compressions to the
  ledger as agent `vscode`:
  - **`#compressorRead`** — reads a file through the engine: comment-stripping
    that preserves line numbers, repeated-line dedupe, and recoverable
    `[compressor:]` markers stating the exact `offset`/`limit` to retrieve
    omitted lines. Pass `offset`/`limit` for an exact uncompressed range.
  - **`#compressorSearch`** — workspace text/regex search returning compressed
    grep-style results (file, line, match). Accepts `isRegex`, `ignoreCase`,
    an `include` glob, and `maxResults`. Find where something is used without
    reading whole files.
  - **`#compressorOutline`** — a file's imports and signatures with bodies
    collapsed into recoverable markers (TypeScript/JavaScript, Rust, Python,
    Go). Understand a large file's shape cheaply, then expand a body with
    `#compressorRead`.
- **Copilot steering** — **Compressor: Enable/Disable Copilot Steering**
  installs/removes an extension-owned
  `.github/instructions/compressor-vscode.instructions.md` nudging agent mode
  toward `#compressorRead` for files longer than ~200 lines and log/output
  files. Steering, not enforcement.
- **Ticker** (status bar): `≈12.3k tok saved (30d)` — estimated tokens saved
  in the configured window. Chars are exact; token figures are estimates from
  the cheap estimator, never billable counts. Click it for the report.
- **Compressor: Show Savings** — the savings report (by day / agent / tool / mode) in
  a webview, themed to the active color scheme. Static HTML, scripts disabled.
  Appends an **actual-usage** section parsed from this project's Claude Code
  session transcripts (`~/.claude`) — authoritative token counts, clearly
  labeled *not savings* and not billable dollars (Claude Code only).
- **Mode indicator** (status bar): `$(fold) compressor: <mode>` — click to
  switch the read tool's compression mode without the command palette.
- **Compressor: Count Tokens** — exact chars and an estimated token count for
  the active file or selection (chars/3.5; never billable).
- **Compressor: Preview Compression** — runs the engine over the active file or
  selection exactly as `compressor_read` would and opens a side-by-side diff
  (numbered original vs compressed). No file writes.
- **Compressor: Status** — per-adapter install status for the first workspace
  folder, steering state, and ledger recency.
- **Compressor: Init / Set Instruction-Pack Mode / Uninstall** — plan
  instruction-pack changes with the library adapters, review the rendered diff,
  confirm, apply. claude-code/copilot (hook-bearing) are offered only when
  `compressor-hook` resolves on PATH; otherwise use the `compressor` CLI.

Settings: `compressor.savingsWindow` (`7d` | `30d` | `all`, default `30d`),
`compressor.mode` (`full` | `optimized` | `slim`, default `optimized` — the
read tool's compression mode; `full` = passthrough).

## Try it

New install? Open the **Get started with Compressor** walkthrough (VS Code
Welcome page, or run `Welcome: Open Walkthrough`).

After **Compressor: Enable Copilot Steering**, in an agent-mode chat:

```
Read #compressorRead src/server/router.ts and explain the route table.
```
```
Summarize the failures in #compressorRead logs/test-run.txt — just the failing
assertions and the final count.
```

With steering on, the agent also tends to pick `compressor_read` on its own for
large or log files. More examples and the full command list are in
[`docs/USAGE.md`](docs/USAGE.md).

## What it does NOT do

- It **cannot compress VS Code Copilot's built-in tool output**. VS Code hooks
  cannot replace tool output (doc-verified 2026-06-12); in-IDE compression
  happens only when the agent uses `#compressorRead`. Instruction packs reach
  Copilot via `.github/copilot-instructions.md` / `AGENTS.md` — see the
  [compressor docs](https://github.com/anvanster/compressor).
- It makes no network calls and reads no file contents beyond the ledger
  JSONL, this project's Claude Code session transcripts (for the usage report),
  and files explicitly requested through `compressor_read` / the preview and
  count commands.
- It shows no percentage claims; measured savings come from
  `compressor benchmark`, not this view.

## Install (from VSIX)

Not on the marketplace. Package locally and install:

```sh
npm run package            # produces compressor-vscode-0.3.0.vsix
code --install-extension compressor-vscode-0.3.0.vsix
```

Usage guide and example prompts: `docs/USAGE.md`.

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
