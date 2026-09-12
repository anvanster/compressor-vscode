# Using Compressor in VS Code

A practical guide for the current development build. Compressor can reduce
tool-output traffic before it reaches the model. Source reads preserve comments;
search and command summaries can omit content with recovery guidance. Output
reduction is not a measurement of net chat or billed-token savings.

The tools do not upload workspace content themselves. Commands you approve can
modify files and access the network. Marketplace releases may lag this guide.

New here? Run **Welcome: Open Walkthrough** → **Get started with Compressor**
for an in-editor tour of the steps below.

## 1. One-time setup

1. Install the extension (from the Marketplace, or `code --install-extension
   compressor-vscode-<version>.vsix`).
2. Run **Compressor: Enable Copilot Steering** (Command Palette → type
   "Compressor"). This writes a **compressor** custom agent
   (`.github/agents/compressor.agent.md`) and a **/compressor** prompt
   (`.github/prompts/compressor.prompt.md`) whose toolset leaves the built-in
   read out — pick the agent from the Chat agents dropdown (or run /compressor)
   and every read goes through the compressor tools. It also adds a marker-fenced
   nudge to `.github/copilot-instructions.md` for the default agent (advisory —
   VS Code can't force tool choice, so the agent/prompt are the real lever).
   The command asks for a scope.
   **All workspaces (user profile)** installs the agent alone to
   `~/.copilot/agents/compressor.agent.md`, VS Code's documented user-level
   agent folder, so **compressor** appears in the agents dropdown in every
   workspace without writing into any repo.
   It stays opt-in per chat: the toolset binds only in sessions where you pick
   the agent.
   The `/compressor` prompt and the instructions nudge stay workspace-only,
   because user prompts live in VS Code profile storage with no documented path
   and an always-on instructions file should not be switched on for every
   workspace at once.
   Custom agents share a single namespace, so a user-scope install asks before
   replacing a `compressor` agent it did not write, and **Compressor: Status**
   reports both scopes and warns when both define one.
   If the agent does not appear in the dropdown, VS Code has an open issue
   discovering user-level agents; workspace scope is unaffected.
3. (Optional) Pick a compression level with the status-bar **`compressor: <mode>`**
  item, or **Compressor: Select Read Compression Mode**: `optimized` (default,
  preserve source and dedupe repeated log lines), `slim` (preserve source and
  compact search), or `full` (uncompressed reads/search). Explicit outline and
  command-summary tools still summarize in full mode.
4. After installing a development VSIX, run **Developer: Reload Window** and
  start a new chat.
  Updating the extension does not rewrite steering files already on disk, so
  re-run **Compressor: Enable Copilot Steering** to pick up a newer agent or
  prompt.
  Owned files carry a revision stamp: re-running updates them in place and
  reports what it replaced, or says the install is already up to date.
  **Compressor: Status** flags an out-of-date install so you do not have to
  guess.

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

Returned content keeps original line numbers. Source code and comments are
preserved; repeated log lines may collapse into a marker with an exact
`offset`/`limit` recovery range. A tool invocation labeled “compressed” does not
mean the response actually shrank. Whole-file reads can honor a host budget;
explicit ranges and symbol reads remain exact.

### Find things with `#compressorSearch`

To locate where something is defined or used without reading whole files, the
agent can search the workspace and get compressed grep-style results:

```
Find every call site of `parseConfig` with #compressorSearch and list the files.
```

```
Search #compressorSearch for the regex `TODO|FIXME` in src/**/*.ts and group
them by file.
```

It accepts `query`, `isRegex`, `ignoreCase`, `include`, `root`, `maxResults`,
`skip`, `output` (`content`, `files`, `count`), and `contextLines` (0-5, default 0).
Use an absolute open workspace root when folder names are ambiguous.

```text
Use #compressorSearch with query="fitMatchPage", root="compressor-vscode",
include="src/tools/search.ts", contextLines=2, and maxResults=5.
Explain the matching code using the returned context before requesting reads.
```

```text
Use #compressorSearch with query="TODO|FIXME", isRegex=true,
root="compressor-vscode", include="src/**/*.ts", and output="files".
Report only the files found in the scanned scope.
```

```text
Find "fitMatchPage" with #compressorSearch in compressor-vscode,
include="src/tools/search.ts", maxResults=1. Follow the returned skip value
with unchanged inputs to retrieve the next page; do not guess the next offset.
```

Context windows merge where they overlap. `→` marks selected matching lines;
`|` marks surrounding lines, which do not increase match counts or advance
`skip`. Files/count output ignores context. Compact counts are page-local and
one file can appear on multiple pages. Pagination assumes unchanged files.

Regex evaluation runs in a worker with a one-second per-file deadline and
cancellation. A timeout is an error, not a no-match result. Narrow the pattern
or use literal matching if it times out. Discovery is bounded and excludes
generated/dependency directories; partial-scan warnings mean counts are not
exhaustive.

Host-budget trimming preserves complete match windows and gives a continuation
based on represented matches. If no window fits, reduce context or use an exact
read. Other compression markers may instead ask you to narrow the search.
Follow the response's recovery guidance rather than advancing past omitted
matches. Budgets are optional host hints, not a `compressorSearch` input.

### Understand a file with `#compressorOutline`

Outlines prefer the installed language provider's symbols, including nested
methods, details and exact ranges. Without a provider, a basic outline fallback
supports TypeScript/JavaScript, Rust, Python and Go. Provider availability varies
by language extension; an outline is not guaranteed to contain every symbol.

```
Outline #compressorOutline src/engine/index.ts, then read the body of compress()
with #compressorRead at the offset/limit the marker shows.
```

```text
Use #compressorOutline on src/tools/regex-scanner.ts in compressor-vscode.
Then use #compressorRead with symbol="RegexScanner.scan" to inspect its body.
If the symbol provider is unavailable, use an exact offset/limit range instead.
```

Symbol names must resolve uniquely. Do not combine `symbol` with `offset` or
`limit`; use a qualified name when multiple methods have the same name.

### Reading an exact range

When you (or the agent) need a span verbatim, pass `offset` (1-based start line)
and `limit` (line count) — that range comes back uncompressed:

```
Read #compressorRead src/engine/tiers/logs.ts lines 40 to 80 and quote the
truncation rule exactly.
```

### Recovering an omitted span

If a `[compressor: …]` marker hides something the agent needs, it can call the
tool again with the offset/limit the marker states. Recovery reads the current
file, not a snapshot, so intervening edits can change the contents. You can also
nudge it:

```
That section was compressed — re-read #compressorRead src/big.ts at the offset
and limit the marker gave, and show me those lines.
```

## 3. Commands and retained logs

Use `#compressorExecute` for noninteractive tests/builds in a trusted workspace.
Reads stay inside the open workspace folders, with one deliberate exception:
files under VS Code's own `GitHub.copilot-chat/chat-session-resources` folder,
where it spills a tool result that was too large to pass inline.
That file is this extension's own output being handed back, and refusing it only
drove the model to read the file uncompressed through the shell instead.
No other path outside the workspace is readable.

Review the command and working directory at confirmation: workspace validation
is not a process sandbox. `timeoutSeconds` defaults to 120 and accepts 1-600.

```text
Use #compressorExecute to run
"env -u COMPRESSOR_NO_LEDGER npm test -- tests/search-tool.test.ts" in the
workspace root with timeoutSeconds=120. Inspect the exit status. If diagnostics
were omitted, use #compressorLog with the returned ID instead of rerunning the
command.
```

The response includes exit status and a retained log ID. The **Compressor
Commands** Output channel shows captured output without adding it to chat.
Summaries remove passing-test rows when a supported test summary is detected;
short command output may grow because of status and recovery metadata.

```text
Use #compressorLog with the ID returned by the previous command, offset=1,
limit=100. Inspect the original failure block and report its file and line.
If the selected range is character-capped, follow its characterOffset guidance.
```

Logs are held in this window's memory for up to 30 minutes and the last five
commands. Reloading clears them. Output capture stops at 2 MB, so a capped log
is only the captured portion. Retrieval accepts `offset` >= 1, `limit` 1-500
and optional `characterOffset` >= 0. Retrieving a log adds traffic; it is not
recorded as savings. Linux cancellation is tested; Windows process-tree cleanup
remains a limitation.

## 4. Understand the report

- The status bar shows **`≈<n> tok reduced`** for the configured lookback. Click it
  (or run **Compressor: Show Savings**) to open the report.
- The report's bars are two-tone: the **full bar is the total original tokens**,
  the **bright segment is estimated output reduction**, broken down by day, agent,
  tool, and mode. The **by agent** view separates Copilot (VS Code) from Claude
  Code and any other surfaces sharing the ledger. Hover a bar for the exact
  chars breakdown.
- Optionally (set `compressor.showActualUsage`, off by default), an **actual
  usage** section below the charts reports authoritative token counts from this
  project's Claude Code session transcripts — real usage, *not savings* and not
  billable dollars (Claude Code only).

Ledger token figures use the cheap chars/3.5 estimator; recorded character
counts are exact. The ledger can include other agents and sessions. Window-local
operation counters track calls, output size, duration and errors, not chat
identity, and reset on reload. Reopen Show Savings to refresh an open report.
Neither view measures net context growth or billed savings; those require
controlled task comparisons including follow-up reads and log retrieval.

## 5. Other commands

| Command | What it does |
|---|---|
| **Count Tokens** | Exact chars + estimated tokens for the active file or selection. |
| **Preview Compression** | Side-by-side diff of the active file/selection vs. what `compressor_read` would return. No file writes. |
| **Status** | Per-adapter install status, steering state, and ledger recency. |
| **Init / Set Instruction-Pack Mode / Uninstall** | Install/switch/remove the compressor instruction packs for agents, with a confirmation diff. |
| **Enable / Disable Copilot Steering** | Manage extension-owned agent/prompt files and the fenced instructions section; select a root in multi-root workspaces. |

Example: select a noisy log region in the editor, run **Preview Compression**,
and compare numbered output. Preview uses the same read content policy, but
does not simulate the model host's token budget or tokenizer.

## 6. Limits

- It **cannot compress Copilot's built-in tool output**. VS Code hooks can't
  replace tool results (verified), so in-editor compression happens only when
  the agent uses Compressor tools. Built-in terminal commands bypass command
  summaries and their reduction records.
- Read/outline access is confined to canonical workspace paths and regular text
  files up to 8 MB. Search reads discovered files in the selected scope and
  applies additional file/size caps. Approved commands can access resources
  outside that scope; do not treat them as confined file reads.
- Instruction packs reach Copilot through `.github/copilot-instructions.md` /
  `AGENTS.md` — see the [compressor docs](https://github.com/anvanster/compressor).

## Settings

- `compressor.projectLabel` — `hashed` | `name` (default `hashed`): how the
  ledger records which workspace a reduction came from, so the savings report can
  show a per-project breakdown.
  `hashed` records a keyed digest of the workspace path.
  The key is generated on first use at `~/.compressor/project-salt`, owner-only,
  deliberately outside the ledger directory so it never travels with a shared
  ledger, and never written into the ledger itself, so a report you share cannot
  be tested against guessed project names.
  The key and the labelling come from the compressor library itself, shared with
  the CLI, so a folder gets one label whichever tool recorded the event.
  Delete the file to rotate it; existing events keep their old labels and show as
  a separate group.
  `name` records the workspace folder name in clear text.
  The absolute path is never recorded in either mode, and events written by other
  agents or before this setting existed group under `unattributed`.
- `compressor.mode` — `full` | `optimized` | `slim` (default `optimized`): the
  read/search output policy.
  `slim` bounds search results about twice as tightly as `optimized`.
  `full` disables automatic bounding.
- `compressor.savingsWindow` — `7d` | `30d` | `all` (default `30d`): lookback for
  the ticker and report.
