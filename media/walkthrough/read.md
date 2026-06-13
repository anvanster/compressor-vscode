# Read a file through compressor

In an **agent-mode** chat, reference the tool by name:

> Read #compressorRead src/server/router.ts and explain the route table.

> Summarize the failures in #compressorRead logs/test-run.txt — just the
> failing assertions and the final count.

With steering enabled, the agent also tends to pick `compressor_read` on its
own for large or log files.

Need an exact slice? Ask for specific lines — the tool takes an `offset` and
`limit` and returns that range uncompressed. If a `[compressor: …]` marker
hides something, the agent can re-read at the offset/limit the marker states —
nothing is lost, only deferred.

Two companion tools round it out:

- **`#compressorSearch`** — workspace text/regex search with compressed
  grep-style results. Find where something is used without reading whole files.
- **`#compressorOutline`** — a file's imports and signatures with bodies
  collapsed. Understand a large file's shape, then expand a body with
  `#compressorRead`.
