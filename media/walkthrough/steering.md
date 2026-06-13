# Steer Copilot to the compressed tools

Enabling steering writes a small file —
`.github/instructions/compressor-vscode.instructions.md` — that nudges Copilot
agent mode to prefer compressor's tools:

- `#compressorRead` for files longer than ~200 lines and for logs/build output,
- `#compressorSearch` to find where code is defined or used, and
- `#compressorOutline` to grasp a large file's shape before reading it.

It's a nudge, not a rule: the built-in tools still work, and short files come
back unchanged either way. Remove it any time with **Compressor: Disable
Copilot Steering**.
