# Two more tools: search and outline

Beyond reading, the agent has two companion tools — reference them by name in
an agent-mode chat, or let steering pick them for you.

**`#compressorSearch`** — find where something lives without reading whole
files. It returns compressed grep-style results (file, line, match), and takes
a regex, an `include` glob, and a result cap.

> Find every call site of `parseConfig` with #compressorSearch and list the
> files.

> Search #compressorSearch for the regex `TODO|FIXME` in src/**/*.ts.

**`#compressorOutline`** — understand a large file's shape before reading it.
It returns imports and signatures with the bodies collapsed into recoverable
markers (TypeScript/JavaScript, Rust, Python, Go).

> Outline #compressorOutline src/engine/index.ts, then read the body of
> compress() with #compressorRead at the offset/limit the marker shows.

That last prompt is the pattern worth remembering: **outline to find the part
you need, then read just that part.**
