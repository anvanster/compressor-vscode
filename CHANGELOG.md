# Changelog

## 0.5.0 — 2026-09-11

- **Fixed: oversized search results could attribute a match to the wrong file.**
  Trimming ran through the generic compression pipeline, whose head-and-tail
  truncation cuts numbered text without regard for file boundaries, so a trimmed
  result could strand later files' matches under an earlier file's header and
  report them at that line number in the wrong file.
  `#compressorSearch` no longer uses that pipeline, whose tiers all assume a
  single file's contents, and instead bounds itself in whole matches,
  re-rendering from the match list so every match keeps its own file header and
  continuing with `skip=` rather than shell-oriented recovery advice.
  `slim` now bounds search results about twice as tightly as `optimized`, where
  the two previously produced identical search output.
- Added confirmed `#compressorExecute` commands with exit status, bounded
  capture, diagnostic test summaries, an Output channel, and in-memory retained
  logs recoverable through `#compressorLog` without rerunning commands.
  Timed-out and cancelled commands terminate the whole process tree: the POSIX
  process-group kill is verified end to end (no surviving grandchildren after a
  timeout), and the Windows `taskkill /t /f` path is implemented but has not
  been run on Windows, so treat it as untested there.
  The Commands panel is revealed only when a command fails, and a run no longer
  interrupts with a notification.
- Source reads now preserve code and semantic comments, reject output growth,
  support exact qualified-symbol reads, and use canonical workspace paths.
  Outlines prefer language-provider symbols and exact ranges.
  A host token budget is a hard cap: when one is too small to fit a recovery
  marker, the read returns a short recovery notice instead of the whole file.
  A budget-trimmed read now names the line to resume from
  (`continue with offset=N`) instead of only saying it was partial; without it
  the model cannot tell what it is missing and re-reads the file by other means,
  spending the saving immediately.
  Read paths are trimmed, and a path that misses because the workspace folder's
  own name was prefixed now suggests the corrected path rather than echoing a
  raw ENOENT.
- The project label now recovers instead of being lost for a whole window. The
  shared key is read asynchronously, and attempting it once at activation left
  any window that started too fast, or lost the creation race with another
  window, recording unlabelled events for its entire lifetime — measured at 101
  of 144 events in one session, 70% of the savings landing in `unattributed`.
  Loading is now retried on demand, so a failure costs only the labels until the
  next attempt succeeds.
- Reads now accept files under VS Code's own
  `GitHub.copilot-chat/chat-session-resources` folder, the single exception to
  the workspace boundary. VS Code spills a tool result that is too large to pass
  inline into that folder and hands the model the path; the file is this
  extension's own output coming back, so refusing it protected nothing and only
  drove the model to read the file uncompressed through the shell. Scoped to
  that segment pair beneath VS Code's own per-user storage directory once that
  directory is known, and to the segment pair alone before activation resolves
  it or on layouts it cannot be derived from, with the size, regular-file and
  binary checks still applied; nothing else outside the workspace became
  readable.
- `#compressorExecute` refuses a command whose only effect is to print a file
  (`cat`, `head`, `sed -n`, including inside a `bash -lc` wrapper) and names the
  `#compressorRead` call to use instead. Command output is summarized for
  diagnostics, so reading a file through the shell returned a scattered sample
  of it rather than the file: one observed `sed -n '1,240p' package.json` came
  back as 45 of the 240 lines requested. Every part of a compound command is
  checked, since the observed case hid `cat` and `sed` between two `printf`
  calls; a part that pipes, redirects or substitutes is processing its input
  rather than merely reading it, and `tail -f` is a follow, so those are left
  alone. Steering revision is now v3.
- Steering now tells the model, in the agent, the prompt and the instructions
  section alike, to state only what the tools actually returned: what each
  coverage marker means, to fetch the rest with the offset the marker names
  rather than substituting another tool, and that a symbol name is not evidence
  of behaviour. The structural fixes below make the output honest about its own
  coverage; this is what makes a model act on it. Existing installs
  report as out of date until re-run.
- **Reads degrade by level of detail instead of cutting the content.** A
  truncated prefix loses either way: a weaker model describes the part it never
  received, and a stronger one notices the gap and re-reads the file by other
  means, spending more than if nothing had been compressed at all. When a whole
  file will not fit, `#compressorRead` now returns the COMPLETE list of its
  declarations with exact ranges (measured 84-93% smaller than the source)
  instead of the first N lines. Nothing is missing at that level, so there is no
  symbol to invent and no reason to re-read; the next step is one named range.
  Cutting the file is now the last resort, used only when no symbol provider can
  describe it.
- A range read that stops short of the end of the file now says so
  (`showing lines 1-60 of 291; continue with offset=61`). A prefix read used to
  look identical to the whole file, so a model that read the first lines went on
  to describe declarations it never saw. The continuation is offered only for a
  range starting at line 1: a symbol or mid-file range was asked for on purpose,
  and nudging a follow-up there only invites a read nobody needed.
- Outlines now say up front that they are signatures with the bodies removed.
  Without that, a model that outlines a file answers questions about its
  behaviour from names alone, and produces a confident, wrong description
  instead of reading the ranges it was handed.
  The fallback outline's recovery markers also pointed at the built-in `Read`
  and an absolute path; they now name `#compressorRead` and the workspace
  relative path the caller used, which matters because the compressor agent's
  allowlist removes the built-in read entirely.
- Expanded `#compressorSearch` with multi-root scoping, files/count modes,
  recoverable pagination, optional merged context windows, host-budget-aware
  complete-match pages, and cancellable regex workers with per-file deadlines.
- **Fixed: an absent host budget was treated as no budget at all.**
  `tokenizationOptions` is optional in the language-model tool API, and
  `#compressorRead` and `#compressorOutline` passed the host's value straight
  through, so a host that sent none got whole files back uncapped. Only
  `#compressorSearch` had a backstop. Observed in Copilot: an outline of
  `package.json` fell back to the source, because a JSON provider reports one
  symbol per key and its outline is larger than the file; the uncapped source
  overflowed the host's inline limit; VS Code spilled the result to a
  chat-session resource file; the model read that file, and the read spilled in
  turn. Nine calls, no file contents, and the model ended by asking the user
  what it should summarize. The backstop is now shared by all three tools —
  5,000 tokens in `optimized`, 2,500 in `slim` — and the cap now applies to
  whichever of source or outline is selected, rather than only to the outline.
  `full` mode is still never trimmed.
- **Fixed: an explicit `offset`/`limit` was exempt from the budget.** The
  exemption was meant to keep a range verbatim, so a read stays citable and
  editable by line. The host disproves the premise: it spills any result over
  its own inline limit to a chat-session resource file, so an oversized range
  never reached the model verbatim anyway — it arrived as a path to re-read,
  and that read spilled in turn. A range is still verbatim as far as it goes;
  it now stops at the budget and says where to resume. Observed in Copilot: a
  capped read was answered by re-requesting `offset=1` with the limit raised
  400, then 2000, then 4000, receiving the same bytes each time, because the
  budget bounds the output and the limit does not. The recovery marker now says
  so outright. The coverage note counts the lines actually returned rather than
  the lines requested, and its cost is reserved out of the budget instead of
  added on top, since a cap that overshoots by the width of its own coverage
  line is what makes a host spill in the first place.
- Outlines and complete-structure listings now mark declarations that are
  visible outside their file with a leading `*`, and explain the mark in their
  own preamble whenever one appears. An outline previously listed every symbol
  the language provider reported with nothing to separate a module-local helper
  from the file's public surface, and models read the whole list as the API:
  `resolveProject`, a module-local variable, and `describeSteering`, internal to
  its file, were both reported as part of the extension's public interface.
  The provider cannot supply this — `SymbolTag` has one member, `Deprecated` —
  so the mark is read from the declaration line: `export`, `pub`, a capitalised
  Go name, an absent Python underscore, `public`, and for C and C++ the absence
  of file-scope `static` or an enclosing anonymous namespace. It is inherited,
  so a public method of a class the file never exports stays unmarked, and
  languages without a rule are left unmarked with no preamble claiming
  otherwise. Verified against the compiler for both families: symbol positions
  from the TypeScript compiler over five of this extension's own files agree
  with their `export` lines exactly, and every file-scope verdict on a compiled
  C++ translation unit agrees with `nm`'s own internal/external linkage.
  The mark reports declared visibility, not linkage: a `private:` C++ member
  has external linkage but is not marked, which is the distinction a caller
  reading the outline needs.
  Visibility is read from `selectionRange`, the name, rather than `range`:
  `range` covers "everything else, e.g. comments and code", so for a documented
  symbol it begins at the opening comment and a rule reading its first line
  sees `/**` instead of the declaration. Caught only after a Copilot run still
  called module-local helpers public API; checked against every source file in
  this extension, where reading from `range` marked 0 of 170 exports and
  reading from `selectionRange` marks all 170 and nothing else.
  Steering now describes the mark alongside the other coverage markers, so an
  unmarked symbol is not presented as public API, and says a missing `*` means
  "not shown to be public" rather than proof of privacy, since a one-line read
  under-marks rather than over-marks. The same pass corrects the agent's claim
  that `compressorOutline` "Supports TS/JS, Python, Rust, and Go": that is the
  no-provider fallback's list, and stating it as the tool's own capability
  steered models away from outlining C++, Java and C# files that VS Code has a
  symbol provider for. Steering revision is now v6; existing installs report as
  out of date until re-run.
- Two error messages that sent callers away from the tools. A workspace root, or
  `.`, was reported as "outside the open workspace folder(s)" — the root was
  excluded from its own containment check — and a directory was reported as
  "Only regular text files up to 8 MB can be read", which reads as a size limit.
  Observed together: a model outlined the workspace root, concluded from the
  message that the extension could not see the project, and described the
  repository from filenames rather than calling the tools again. A root now
  resolves, and a directory says it is a directory and points at the files
  inside it. `#compressorSearch` has no listing mode — it requires a query and
  reports only the files that match one — so the message names a text search
  scoped with `include=<dir>/**` rather than claiming a directory can be listed.
- `COMPRESSOR_NO_LEDGER=1` stops the extension recording anything. The switch is
  read from the extension host's own environment, so it has to be set for the
  VS Code process itself; exporting it in an integrated terminal does not reach
  the host, and there is no equivalent `compressor.*` setting. Resolving a
  project label reads, and on a fresh machine creates,
  `~/.compressor/project-salt`, and that ran before `appendLedger` got to check
  the switch — so a user who had explicitly opted out still got a directory and
  a key written into their home. The switch is now honoured at the top of the
  recording path and before the key is loaded at activation. The library fixed
  the same defect for the CLI hooks in 0.5.2; the extension has its own write
  path and needed its own guard.
- The ledger now records which workspace each reduction came from, and the
  savings report gained a per-project breakdown.
  `compressor.projectLabel` defaults to `hashed`: the label is a keyed digest of
  the workspace path.
  The key is created on first use at `~/.compressor/project-salt`, owner-only and
  outside the ledger directory so it never travels with a shared ledger.
  The key and the labelling come from the compressor library (0.5.2), shared
  with the CLI hooks, which populate the same label from the agent's working
  directory — so a folder gets one label whichever tool records the event, and
  the library renders the `by project` breakdown in the report itself.
  Set it to `name` for clear-text folder names; the absolute path is never
  recorded either way.
- Steering older than the running build is surfaced passively: a warning on the
  savings ticker and a banner in the report, alongside the existing
  **Compressor: Status** line. No notification interrupts a session.
- Steering files now carry a revision stamp, so re-running **Compressor: Enable
  Copilot Steering** updates an install written by an older version in place and
  reports what it replaced, rather than silently rewriting or silently doing
  nothing.
  An up-to-date install is left untouched, and **Compressor: Status** flags one
  that has fallen behind.
- **Compressor: Enable/Disable Copilot Steering** now asks for a scope.
  **All workspaces (user profile)** installs the compressor agent alone to
  `~/.copilot/agents/compressor.agent.md`, VS Code's documented user-level agent
  folder, so the agent is offered in every workspace without writing into any
  repo; it stays opt-in per chat.
  The `/compressor` prompt and the instructions section remain workspace-only.
  Because custom agents share one unqualified namespace, the agent now carries
  an explicit `name`, a user-scope install asks before replacing a `compressor`
  agent it did not write, and **Compressor: Status** reports both scopes and
  warns when both define one.
- Reframed the ticker and report as estimated tool-output reduction rather than
  net session savings, and added private window-local operation metrics.
  The operation-metrics table is omitted until a tool has run, and its cells
  carry spacing so the headers no longer run together in the report.
- Updated Copilot steering for all five tools, refreshed usage examples and the
  walkthrough, and added regression coverage for tools, policies and packaging.

## 0.3.4 — 2026-06-18

- **Copilot steering now forces the compressor tools, not just nudges.**
  **Compressor: Enable Copilot Steering** installs a custom **compressor** agent
  (`.github/agents/compressor.agent.md`) and a **/compressor** prompt
  (`.github/prompts/compressor.prompt.md`) whose `tools:` allowlist leaves the
  built-in file read and codebase search out of scope — pick the agent from the
  Chat agents dropdown (or run `/compressor`) and every read/search goes through
  `#compressorRead` / `#compressorSearch` / `#compressorOutline`. VS Code has no
  API to force tool choice in the default agent, so this is the deterministic
  path; the default agent is still only nudged.
- **The always-on nudge moved into a marker-fenced section of
  `.github/copilot-instructions.md`** (replacing the separate, routinely-ignored
  `.github/instructions/compressor-vscode.instructions.md`). The section is
  fenced in distinct `compressor-vscode:steering` comments, so it updates and
  removes cleanly and coexists with a `compressor init` instruction-pack section
  in the same file. **Disable Copilot Steering** removes all three artifacts.
- Tightened the three tools' `modelDescription`s so the default agent reaches
  for them more readily.

## 0.3.3 — 2026-06-14

- **Manage commands back up before changing files.** Init / Set Instruction-Pack
  Mode / Uninstall now save the prior state of every file they change (via the
  library's `applyWithBackup`, under `~/.compressor/backups`) before writing —
  undo a change from a terminal with `compressor restore`. The modal
  confirmation is unchanged.
- Depend on `@astudioplus/compressor` `^0.3.3` (adds the backup/restore APIs and
  the `compressor restore` CLI command).

## 0.3.0 — 2026-06-12

- **Two more language-model tools** for Copilot agent mode, joining
  `#compressorRead` (three tools total):
  - **`#compressorSearch`** — workspace text/regex search returning compressed
    grep-style results (file, line, match), with `isRegex`, `ignoreCase`,
    `include` glob, and `maxResults`. Oversized result sets are deduped and
    truncated with a recoverable marker; workspace-confined.
  - **`#compressorOutline`** — a file's imports and signatures with bodies
    collapsed into recoverable `[compressor: …]` markers (TypeScript/JavaScript,
    Rust, Python, Go; other types return a note to use `#compressorRead`).
  The Copilot steering file now describes all three tools.
- **Click-to-toggle mode indicator**: a status-bar item (`$(fold) compressor:
  <mode>`) shows the read-tool compression mode and opens a quickpick to change
  it — sets `compressor.mode` at the workspace level (global when no folder is
  open). Distinct from `Set Instruction-Pack Mode`, which writes agent config.
- **`Compressor: Count Tokens`**: counts the active file (or selection) — exact
  chars and an estimated token figure (chars/3.5, the ledger's estimator; never
  billable). Keeps js-tiktoken out of the bundle on purpose.
- **`Compressor: Preview Compression`**: runs the engine over the active file
  (or selection) exactly as `compressor_read` would and opens a side-by-side
  diff (numbered original vs compressed) with the saved-chars summary in the
  title. No file writes. Honors `compressor.mode` (`full` is a no-op).
- **Actual-usage section in the savings report** *(opt-in, off by default —
  `compressor.showActualUsage`)*: authoritative token usage parsed from this
  project's Claude Code session transcripts (`~/.claude`) — the CLI `compressor
  stats` view. Clearly labeled actual usage, **not savings** and not billable
  dollars; Claude Code only. Off by default since it covers Claude Code, not
  Copilot.
- The savings report adapts to the active VS Code color theme (colors and font
  from `--vscode-*` variables; standalone `--html` unchanged in a browser).
- **By-agent breakdown in the savings report** — a section grouping savings by
  surface (Copilot (VS Code), Claude Code, Copilot CLI, OpenCode), so the
  shared ledger shows which agent saved what.
- **Two-tone savings bars**: each bar's full length is the total original
  tokens, with the saved portion highlighted; the value column no longer
  truncates. Hover a bar for the chars breakdown.
- **Marketplace icon** (`assets/icon.png`) from the brand mark.
- **Getting Started walkthrough** (Welcome page → "Get started with
  Compressor", or run `Welcome: Open Walkthrough`): six steps — what it does,
  enable steering, read with `#compressorRead`, search & outline, see your
  savings, tune/inspect — with buttons that run the matching commands and
  auto-check as you go.
- **Usage guide with example prompts** (`docs/USAGE.md`), and sharper model
  guidance for tool invocation — the `compressor_read` `modelDescription` and
  the Copilot steering file now explain when to prefer the tool, how to read an
  exact range (offset/limit), and how to recover an omitted `[compressor: …]`
  span. Validation checklist moved to the gitignored `internal/`.

## 0.2.0 — 2026-06-12

- **`compressor_read` language-model tool** (`#compressorRead` in Copilot
  agent-mode chat): reads a workspace file and runs the compressor engine
  in-process — comment-stripping with preserved line numbers, repeated-line
  dedupe, recoverable `[compressor:]` omission markers. `offset`/`limit`
  retrieve an exact range uncompressed. Worthwhile compressions are recorded
  in the ledger as agent `vscode` (estimated token figures only). Reads are
  confined to the open workspace folders.
- **Copilot steering** (`Compressor: Enable/Disable Copilot Steering`):
  extension-owned `.github/instructions/compressor-vscode.instructions.md`
  nudging agent mode toward `#compressorRead` for large files.
- **Manage commands** (`Compressor: Init / Set Mode / Uninstall`): plan with
  the library adapters, review the rendered diff in the Compressor output
  channel, confirm, apply. Hook-bearing agents (claude-code, copilot) are
  offered only when `compressor-hook` resolves on PATH; otherwise the
  compressor CLI is the way.
- **`compressor.mode` setting** (`full` | `optimized` | `slim`, default
  `optimized`) for the read tool.
- **import.meta CJS shim** in the esbuild bundle: the bundled ESM library now
  sees a real `import.meta.url`. Absolute-path hook installs still cannot be
  claimed from inside the bundle (no compressor package root above the
  extension) — the Status command keeps saying so.
- Engines floor raised to VS Code `^1.95.0` (LanguageModelTool API
  finalization).

## 0.1.0 — 2026-06-12

- MVP: status-bar savings ticker, savings report webview, `Compressor: Status`
  command. Read-only; no network calls.
