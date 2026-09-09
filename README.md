# Compressor — AI Token Savings (VS Code)

> Development build: five tools now include confirmed command execution and
> retained-log retrieval. Source reads preserve comments; outlines use language
> providers when available. This README and [usage guide](docs/USAGE.md)
> describe version 0.4.0; the Marketplace release may not yet include it.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/aStudioPlus.compressor-vscode?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=aStudioPlus.compressor-vscode)

Companion extension for
[compressor](https://github.com/anvanster/compressor): compressed
read/search/outline/execute/log tools for Copilot agent mode, a reduction report over
the compressor ledger (`~/.compressor/ledger`, override with
`COMPRESSOR_LEDGER_DIR`), and manage commands for instruction packs. The extension
does not upload workspace content itself; approved commands can access the network.

## Features

- **Five language-model tools** for Copilot agent mode. File reads, outlines and
  search are workspace-scoped; command execution requires trust and confirmation:
  - **`#compressorRead`** — preserves source code, comments and line numbers;
    repeated log lines can be deduplicated with recoverable
    `[compressor:]` markers stating the exact `offset`/`limit` to retrieve
    omitted lines. Pass `offset`/`limit` or a unique qualified `symbol` for an
    exact uncompressed read.
  - **`#compressorSearch`** — workspace text/regex search returning compressed
    grep-style results (file, line, match). Accepts `isRegex`, `ignoreCase`,
    an `include` glob, `root`, `maxResults`, `skip`, compact `output=files|count`,
    and optional `contextLines: 0-5`. Overlapping context windows merge. Regex
    evaluation has cancellation and a one-second per-file worker deadline.
    Partial scans are labeled; budget-trimmed pages advance only past represented
    matches. Counts and continuation exclude context lines.
  - **`#compressorOutline`** — provider-backed symbols, nested methods and exact
    ranges, with a basic TS/JS, Python, Rust or Go fallback. Read implementation
    with `#compressorRead` using a qualified symbol or line range.
  - **`#compressorExecute`** — confirmed noninteractive commands with exit status,
    time/output limits, summaries and a retained log ID. The **Compressor Commands**
    Output channel shows captured output. Commands are not sandboxed.
  - **`#compressorLog`** — retrieve retained output without rerunning commands.
    Logs last up to 30 minutes and the last five commands in window memory;
    reload clears them. Capture is capped at 2 MB and marked partial if exceeded.
- **Copilot steering** — **Compressor: Enable/Disable Copilot Steering**
  installs/removes three extension-owned files. VS Code has no API to force tool
  choice or override the built-in read, and instructions don't route tools, so
  the deterministic lever is a `tools:` allowlist that omits the built-in read:
  - `.github/agents/compressor.agent.md` — a **custom agent** ("compressor")
    whose toolset is the five compressor tools plus edit, with
    the built-in read/codebase-search left out. Pick it from the Chat agents
    dropdown and every read in that session goes through the compressor tools.
  - `.github/prompts/compressor.prompt.md` — the **`/compressor`** prompt, the
    same scoping for one-shot tasks.
  - a marker-fenced section in `.github/copilot-instructions.md` — a best-effort
    nudge for the *default* agent (instructions are advisory for tool routing,
    so this alone is unreliable; the agent/prompt are the real lever). It is
    fenced in distinct `compressor-vscode:steering` comments so it updates and
    removes cleanly and coexists with a `compressor init` pack section in the
    same file.
- **Ticker** (status bar): `≈12.3k tok reduced (30d)` — estimated output reduction
  in the configured window. Chars are exact; token figures are estimates from
  the cheap estimator, never billable counts or net session savings. Click it
  for the report. Operation metrics are window-local, not chat-local.
- **Compressor: Show Savings** — the savings report (by day / agent / tool / mode) in
  a webview, themed to the active color scheme. Static HTML, scripts disabled.
  Optionally (set `compressor.showActualUsage`, off by default) appends an
  **actual-usage** section parsed from this project's Claude Code session
  transcripts (`~/.claude`) — authoritative token counts, clearly labeled
  *not savings* and not billable dollars (Claude Code only).
- **Mode indicator** (status bar): `$(fold) compressor: <mode>` — click to
  switch the read tool's compression mode without the command palette.
- **Compressor: Count Tokens** — exact chars and an estimated token count for
  the active file or selection (chars/3.5; never billable).
- **Compressor: Preview Compression** — applies the read content policy to the
  active file or selection and opens a side-by-side diff
  (numbered original vs compressed). No file writes; host budgets are not simulated.
- **Compressor: Status** — per-adapter install status for the first workspace
  folder, steering state, and ledger recency.
- **Compressor: Init / Set Instruction-Pack Mode / Uninstall** — plan
  instruction-pack changes with the library adapters, review the rendered diff,
  confirm, apply. Changed files are backed up first (under `~/.compressor/backups`)
  — undo from a terminal with `compressor restore`. claude-code/copilot
  (hook-bearing) are offered only when `compressor-hook` resolves on PATH;
  otherwise use the `compressor` CLI.

Settings: `compressor.savingsWindow` (`7d` | `30d` | `all`, default `30d`),
`compressor.mode` (`full` | `optimized` | `slim`, default `optimized` — the
read tool's compression mode; `full` = passthrough), and
`compressor.showActualUsage` (default `false` — show the Claude Code
transcript usage section in the report).

## Try it

New install? Open the **Get started with Compressor** walkthrough (VS Code
Welcome page, or run `Welcome: Open Walkthrough`).

After **Compressor: Enable Copilot Steering**, the strongest path is to pick the
**compressor** agent from the Chat agents dropdown (or run **/compressor**) — the
built-in read is out of scope there, so the agent must use the compressor tools.
You can also `#`-reference them explicitly in any agent-mode chat:

```
Read #compressorRead src/server/router.ts and explain the route table.
```
```
Summarize the failures in #compressorRead logs/test-run.txt — just the failing
assertions and the final count.
```

```text
Use #compressorSearch with query="fitMatchPage", root="compressor-vscode",
include="src/tools/search.ts", contextLines=2, maxResults=5.
Explain the matches using the returned context. Follow any recovery guidance.
```

```text
Use #compressorExecute in /home/jason/projects/compressor-vscode to run
"npm test -- tests/search-tool.test.ts". Check the exit status and retrieve
omitted diagnostics with #compressorLog using the returned ID, not another run.
```

Adapt these repository-specific paths to your workspace. Search context is off
by default; `→` marks selected matches and `|` marks context. Host budgets are
optional hints, not user tool inputs. Exact reads and full-mode search are not
budget-trimmed; explicit outline and command-summary tools still summarize.

In the *default* agent the model only *tends* to pick `compressor_read` on its
own (no API forces it); the compressor agent and `/compressor` make it
deterministic. More examples and the full command list are in
[`docs/USAGE.md`](docs/USAGE.md).

## What it does NOT do

- It **cannot compress VS Code Copilot's built-in tool output**. VS Code hooks
  cannot replace tool output (doc-verified 2026-06-12); in-IDE compression
  happens only when the agent uses Compressor tools. Instruction packs reach
  Copilot via `.github/copilot-instructions.md` / `AGENTS.md` — see the
  [compressor docs](https://github.com/anvanster/compressor).
- Search reads files in its discovered scope. Outlines use language providers;
  the optional usage report reads local Claude Code transcripts. Approved
  commands can modify files or access resources outside the workspace.
- Output reduction is not net session savings. Follow-up reads, log retrieval,
  prompts and model replies all affect total usage. See the
  [usage guide](docs/USAGE.md) for operational limits and recovery behavior.

## Install

From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=aStudioPlus.compressor-vscode)
— search **"Compressor — AI Token Savings"** in the Extensions view, or from a
terminal:

```sh
code --install-extension aStudioPlus.compressor-vscode
```

Or build and install the VSIX locally:

```sh
npm run package            # produces compressor-vscode-<version>.vsix
code --install-extension compressor-vscode-<version>.vsix
```

After a development update, run **Developer: Reload Window** and start a new
chat. Existing steering artifacts are not rewritten on install; explicitly run
**Compressor: Enable Copilot Steering** to regenerate an outdated tool allowlist.

Usage guide and example prompts: [`docs/USAGE.md`](docs/USAGE.md).

## Development

Requires VS Code ≥ 1.95 (LanguageModelTool API), Node.js and npm. Install the
declared compressor library dependency with npm:

```sh
npm install
npm run typecheck
npm run build      # esbuild bundle → out/extension.js
npm test           # vitest ('vscode' is aliased to a local mock)
npm run package    # vsce → .vsix
```
