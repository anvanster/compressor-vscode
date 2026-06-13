# Using Compressor in VS Code

A practical guide with example prompts. Compressor saves tokens by reading
large files through a compression engine before they reach the model, and it
shows you what was saved. It makes no network calls.

New here? Run **Welcome: Open Walkthrough** → **Get started with Compressor**
for an in-editor tour of the steps below.

## 1. One-time setup

1. Install the extension (from the Marketplace, or `code --install-extension
   compressor-vscode-<version>.vsix`).
2. Run **Compressor: Enable Copilot Steering** (Command Palette → type
   "Compressor"). This writes `.github/instructions/compressor-vscode.instructions.md`,
   which nudges Copilot agent mode to reach for the compressed read tool on
   large files. It's steering, not enforcement — the built-in read still works.
3. (Optional) Pick a compression level with the status-bar **`compressor: <mode>`**
   item, or **Compressor: Select Read Compression Mode**: `optimized` (default —
   strip comments + dedupe repeated lines), `slim` (also filter logs), or `full`
   (off).

## 2. The `#compressorRead` tool (Copilot agent mode)

This is the core feature. In an **agent-mode** chat, the model can read a file
through compressor instead of the built-in read. Two ways to trigger it:

**Explicitly** — reference the tool by name:

```
Read #compressorRead src/server/router.ts and explain the route table.
```

```
Summarize the failures in #compressorRead logs/test-run.txt — just the failing
assertions and the final count.
```

```
Using #compressorRead, review src/auth/session.ts for problems. Pull the exact
lines you flag.
```

**Naturally** — with steering enabled, just ask, and the agent tends to choose
`compressor_read` for large/log files on its own:

```
Read logs/build.log and tell me why the build failed.
```

```
Open src/engine/index.ts and walk me through compress().
```

What you'll see: the tool invocation reads `... (compressed)`, and the returned
content keeps original line numbers with comments/repeats collapsed. Any omitted
span appears inline as a recoverable marker, e.g.
`[compressor: lines 120-980 omitted — offset=120 limit=860 to retrieve]`.

### Reading an exact range

When you (or the agent) need a span verbatim, pass `offset` (1-based start line)
and `limit` (line count) — that range comes back uncompressed:

```
Read #compressorRead src/engine/tiers/logs.ts lines 40 to 80 and quote the
truncation rule exactly.
```

### Recovering an omitted span

If a `[compressor: …]` marker hides something the agent needs, it can call the
tool again with the offset/limit the marker states — no information is lost,
just deferred. You can also nudge it:

```
That section was compressed — re-read #compressorRead src/big.ts at the offset
and limit the marker gave, and show me those lines.
```

## 3. See what you're saving

- The status bar shows **`≈<n> tok saved`** for the configured window. Click it
  (or run **Compressor: Show Savings**) to open the report.
- The report's bars are two-tone: the **full bar is the total original tokens**,
  the **bright segment is what compressor saved**. Hover a bar for the exact
  chars breakdown.
- Below the savings charts, an **actual usage** section reports authoritative
  token counts from this project's Claude Code session transcripts — real usage,
  *not savings* and not billable dollars (Claude Code only).

Token figures from compressor are estimates (the cheap chars/3.5 estimator);
character counts are exact. Measured savings come from `compressor benchmark`,
not this view — and there are no percentage claims anywhere.

## 4. Other commands

| Command | What it does |
|---|---|
| **Count Tokens** | Exact chars + estimated tokens for the active file or selection. |
| **Preview Compression** | Side-by-side diff of the active file/selection vs. what `compressor_read` would return. No file writes. |
| **Status** | Per-adapter install status, steering state, and ledger recency. |
| **Init / Set Instruction-Pack Mode / Uninstall** | Install/switch/remove the compressor instruction packs for agents, with a confirmation diff. |
| **Enable / Disable Copilot Steering** | Add/remove the steering instructions file. |

Example: select a noisy log region in the editor, run **Preview Compression**,
and watch the right pane shrink — that's exactly what the agent would receive.

## 5. What it can't do

- It **cannot compress Copilot's built-in tool output**. VS Code hooks can't
  replace tool results (verified), so in-editor compression happens only when
  the agent uses `#compressorRead`.
- It reads no file contents beyond the ledger, this project's Claude Code
  transcripts (for the usage report), and files you/the agent request through
  `compressor_read`, Preview, or Count.
- Instruction packs reach Copilot through `.github/copilot-instructions.md` /
  `AGENTS.md` — see the [compressor docs](https://github.com/anvanster/compressor).

## Settings

- `compressor.mode` — `full` | `optimized` | `slim` (default `optimized`): the
  read tool's compression level.
- `compressor.savingsWindow` — `7d` | `30d` | `all` (default `30d`): lookback for
  the ticker and report.
