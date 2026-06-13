# The agent tools

Compressor gives the agent three tools in agent-mode chat. Reference any of them
by name, or let steering pick them for you.

**`#compressorRead`** (from the previous step) — read a file through the engine,
with comments and bodies collapsed and recoverable `[compressor: …]` markers.

**`#compressorSearch`** — find where something lives without reading whole
files. Compressed grep-style results (file, line, match); takes a regex, an
`include` glob, and a result cap.

> Find every call site of `parseConfig` with #compressorSearch and list the
> files.

**`#compressorOutline`** — understand a large file's shape before reading it.
Imports and signatures with the bodies collapsed into recoverable markers
(TypeScript/JavaScript, Rust, Python, Go).

> Outline #compressorOutline src/engine/index.ts, then read the body of
> compress() with #compressorRead at the offset/limit the marker shows.

That last prompt is the pattern worth remembering: **search or outline to find
the part you need, then read just that part.**
