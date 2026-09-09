# Steer Copilot to the compressed tools

Enabling steering writes three extension-owned files. VS Code can't force the
agent to pick a tool or override the built-in read, so the reliable lever is a
**custom agent** whose toolset leaves the built-in read out:

- `.github/agents/compressor.agent.md` — the **compressor** agent. Pick it from
  the Chat agents dropdown and every read/search in that session goes through
  `#compressorRead` / `#compressorSearch` / `#compressorOutline` — the built-in
  read isn't available to it.
- `.github/prompts/compressor.prompt.md` — the **/compressor** prompt: the same
  scoping for a one-shot task.
- a marker-fenced section in `.github/copilot-instructions.md` — a best-effort
  nudge for the *default* agent (advisory only — the agent/prompt are what make
  it deterministic). It is fenced in distinct `compressor-vscode:steering`
  comments, so it updates/removes cleanly and coexists with a `compressor init`
  pack section.

The allowlist also includes `#compressorExecute` and `#compressorLog` for commands
and retained output. File omissions carry recovery guidance, but files can
change and retained logs expire. Do not treat summaries as complete snapshots.
Remove all three any time with **Compressor: Disable Copilot Steering**.

After installing a development update, reload the window and start a new chat.
Regenerate steering explicitly to update an older tool allowlist; installation
does not rewrite existing agent/prompt files. Multi-root setup asks which folder
to configure.

> Tip: while the compressor agent is selected, open **Configure Tools** to
> confirm the built-in read isn't listed.
