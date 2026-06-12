# Compressor — AI Token Savings (VS Code)

Status-bar ticker and report for the estimated token savings recorded by the
[compressor](https://github.com/anvanster/compressor) ledger
(`~/.compressor/ledger`, override with `COMPRESSOR_LEDGER_DIR`).

## What it shows

- **Ticker** (status bar): `≈12.3k tok saved (30d)` — estimated tokens saved by
  the compression hook in the configured window. Chars are exact; token figures
  are estimates from the cheap estimator, never billable counts. Click it for
  the report.
- **Compressor: Show Savings** — the savings report (by day / tool / mode) in a
  webview. Static HTML, scripts disabled.
- **Compressor: Status** — per-adapter install status for the first workspace
  folder plus ledger recency, in the `Compressor` output channel.

Setting: `compressor.savingsWindow` (`7d` | `30d` | `all`, default `30d`).

## What it does NOT do

- It **cannot compress VS Code Copilot's tool output**. VS Code hooks cannot
  replace tool output (doc-verified 2026-06-12), so hook-side compression is
  not possible in VS Code; instruction packs reach Copilot via
  `.github/copilot-instructions.md` / `AGENTS.md` — see the
  [compressor docs](https://github.com/anvanster/compressor).
- It makes no network calls and reads no file contents beyond the ledger JSONL.
- It shows no percentage claims; measured savings come from
  `compressor benchmark`, not this view.

## Install (from VSIX)

Not on the marketplace. Package locally and install:

```sh
npx @vscode/vsce package        # produces compressor-vscode-0.1.0.vsix
code --install-extension compressor-vscode-0.1.0.vsix
```

## Development

Requires a built `../compressor` checkout next to this directory (the library
is a `file:` dependency):

```sh
(cd ../compressor && npm install && npm run build)
npm install
npm run typecheck
npm run build      # esbuild bundle → out/extension.js
npm test           # vitest ('vscode' is aliased to a local mock)
```
