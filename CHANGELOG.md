# Changelog

## 0.3.0 — 2026-06-12

- **Two more language-model tools** for Copilot agent mode:
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
- **Actual-usage section in the savings report**: the report now appends
  authoritative token usage parsed from this project's Claude Code session
  transcripts (`~/.claude`) — the CLI `compressor stats` view. Clearly labeled
  actual usage, **not savings** and not billable dollars; Claude Code only.
- The savings report adapts to the active VS Code color theme (colors and font
  from `--vscode-*` variables; standalone `--html` unchanged in a browser).
- **Two-tone savings bars**: each bar's full length is the total original
  tokens, with the saved portion highlighted; the value column no longer
  truncates. Hover a bar for the chars breakdown.
- **Marketplace icon** (`assets/icon.png`) from the brand mark.
- **Getting Started walkthrough** (Welcome page → "Get started with
  Compressor", or run `Welcome: Open Walkthrough`): five steps — what it does,
  enable steering, read with `#compressorRead`, see your savings, tune/inspect
  — with buttons that run the matching commands and auto-check as you go.
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
