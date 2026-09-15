# Read a file through compressor

In an **agent-mode** chat, reference the tool by name:

> Read #compressorRead src/server/router.ts and explain the route table.

> Summarize the failures in #compressorRead logs/test-run.txt — just the
> failing assertions and the final count.

With steering enabled, the agent also tends to pick `compressor_read` on its
own for large or log files.

Need an exact slice? Ask for specific lines — the tool takes an `offset` and
`limit` and returns that range verbatim as far as the token budget allows,
naming the line to resume from. If a `[compressor: …]` marker
hides something, the agent can re-read at the offset/limit the marker states —
recovery reads the current file, so intervening edits can change the contents.

Source comments are preserved. For provider-backed symbols, use a unique
qualified name such as `RegexScanner.scan` instead of offsets; do not combine
`symbol` with `offset`/`limit`.
