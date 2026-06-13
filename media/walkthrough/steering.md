# Steer Copilot to the compressed read

Enabling steering writes a small file —
`.github/instructions/compressor-vscode.instructions.md` — that nudges Copilot
agent mode to prefer `#compressorRead` for files longer than ~200 lines and for
logs or build output.

It's a nudge, not a rule: the built-in read still works, and short files come
back unchanged either way. Remove it any time with **Compressor: Disable
Copilot Steering**.
