# Changelog

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
