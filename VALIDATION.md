# Manual local validation — compressor-vscode 0.3.0

Step-by-step checklist for validating the packaged extension on a real
machine. Run from this repo unless noted. Every token figure you see should be
marked `≈` or "estimated"; if you ever see a percentage claim, that is a bug.

## 1. Install the VSIX

```sh
code --install-extension compressor-vscode-0.3.0.vsix
```

**Pass:** install completes; `code --list-extensions` shows
`aStudioPlus.compressor-vscode`.

## 2. Reload and check the ticker

Reload the VS Code window (Developer: Reload Window).

**Pass:** the status bar (right side) shows either
`≈<n> tok saved (30d)` built from your real ledger
(`~/.compressor/ledger`, or `$COMPRESSOR_LEDGER_DIR`), or
`compressor: no savings yet` when the ledger is empty. Hovering shows the
tooltip with "chars are exact" and the events count.

## 3. Savings panel

Run **Compressor: Show Savings** (or click the ticker).

**Pass:** a static webview opens with the by-day/tool/mode tables; numbers
match `compressor savings` in a terminal; no scripts, no network.

## 4. Status command in this repo

Open this repo (or any repo with a compressor install) and run
**Compressor: Status**.

**Pass:**
- one line per adapter (claude-code, copilot, cursor, agents-md, opencode);
- the `copilot steering (#compressorRead)` line says installed / not installed;
- the relocatable-detection note appears (absolute-path installs may show as
  not installed — `compressor status` in a terminal is authoritative; this
  repo's dogfood install is absolute-style, so expect exactly that);
- the honesty line about VS Code hooks closes the report.

**Known limitation:** with an absolute-style hook install (source-checkout
dogfooding), claude-code may report the output style but not the hook — by
design; the terminal CLI is authoritative.

## 5. compressor_read in a Copilot agent-mode chat

Enable steering first: **Compressor: Enable Copilot Steering** (creates
`.github/instructions/compressor-vscode.instructions.md`).

a) In an agent-mode chat, reference the tool explicitly on a large file
   (>200 lines, comment-heavy is best):
   `Read #compressorRead src/some-big-file.ts and summarize it.`

**Pass:** the tool invocation says "Reading … (compressed)"; expanding the
tool output shows a `[compressor:` marker line and line-numbered content.

b) Ask the agent naturally ("read src/some-big-file.ts and explain it") and
   observe which read tool it picks.

**Pass (soft):** with steering enabled the agent picks `compressor_read` at
least sometimes for large files. This is steering, not enforcement — the
built-in read tool remains available, and the model may still choose it.
Record what you observe; do not claim more than observed.

## 6. Ledger event landed

In a terminal:

```sh
compressor savings --window 7d
```

**Pass:** the by-agent table (or raw JSONL in `~/.compressor/ledger/`) now
contains `"agent":"vscode"` events from step 5 with estimated token figures.

## 7. Uninstall path

```sh
code --uninstall-extension aStudioPlus.compressor-vscode
```

**Pass:** extension gone after reload; ticker disappears. Note: the steering
file is intentionally left in the repo (it is workspace content, not extension
state) — remove it beforehand with **Compressor: Disable Copilot Steering**
if you do not want it.

## 8. 0.3.0 additions

**Mode indicator (click-to-toggle).** The status bar shows
`$(fold) compressor: <mode>` next to the savings ticker.

**Pass:** clicking it opens a quickpick (optimized / slim / full, current one
marked); choosing one updates `compressor.mode` (workspace settings when a
folder is open) and the indicator text changes.

**Count Tokens.** Open a file (or select a region) and run
**Compressor: Count Tokens**.

**Pass:** an info message reports exact chars and `≈<n> tokens (estimated,
chars/3.5 — not billable)`, with scope `file` or `selection`. No percentage.

**Preview Compression.** With `compressor.mode` not `full`, run
**Compressor: Preview Compression** on a large comment-heavy file.

**Pass:** a side-by-side diff opens (numbered original vs compressed); the
title states `saved ≈<n> chars (exact)` or, below the floor, that
`compressor_read` returns it unchanged. Nothing is written to disk. With mode
`full` the command says compression is off.

**Actual-usage report section.** Open this repo (it has Claude Code
transcripts) and run **Compressor: Show Savings**.

**Pass:** below the savings charts, an **actual usage (Claude Code
transcripts)** section lists sessions/turns and input/output/cache token totals
with a by-model breakdown, labeled *not savings* and not billable dollars.
Numbers match `compressor stats` in a terminal. In a repo with no Claude Code
history the section is absent (not an error).

## Known limitations to expect

- The tool only reads files inside the open workspace folders (privacy
  boundary) — absolute paths outside them return an error string.
- Compression below the worthwhile floor (saving <200 chars or <10%) returns
  the file unchanged and records nothing.
- `compressor.mode: full` disables compression (passthrough, no events).
- Manage commands offer claude-code/copilot only when `compressor-hook` is on
  PATH (npm install -g @astudioplus/compressor); otherwise use the CLI.
- All token figures are estimates from the cheap estimator, never billable
  counts; chars are exact.
