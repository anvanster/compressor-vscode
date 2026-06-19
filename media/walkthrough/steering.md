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

The compressor tools are lossless: omissions carry a recoverable `[compressor:
…]` marker, line numbers are preserved, and short files come back unchanged.
Remove all three any time with **Compressor: Disable Copilot Steering**.

> Tip: while the compressor agent is selected, open **Configure Tools** to
> confirm the built-in read isn't listed.
