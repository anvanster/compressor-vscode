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

Both commands ask where to install. **All workspaces (user profile)** writes
only the agent, to `~/.copilot/agents/compressor.agent.md`, so **compressor** is
offered in the dropdown in every workspace without touching any repo. It is
still opt-in per chat. If it does not appear there, VS Code has an open issue
discovering user-level agents; workspace scope is unaffected.

After installing a development update, reload the window and start a new chat.
Updating the extension leaves steering files already on disk alone, so re-run
**Compressor: Enable Copilot Steering** to pick up a newer tool allowlist. Owned
files carry a revision stamp, so re-running updates them in place and tells you
what it replaced, and **Compressor: Status** flags an out-of-date install.
Multi-root setup asks which folder to configure.

> Tip: while the compressor agent is selected, open **Configure Tools** to
> confirm the built-in read isn't listed.
