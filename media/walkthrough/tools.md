# The agent tools

Compressor gives the agent five tools in agent-mode chat. Reference any of them
by name, or let steering pick them for you.

**`#compressorRead`** preserves source and comments. Use `offset`/`limit` or a
unique qualified `symbol` for a verbatim range; it stops at the token budget and
names the line to resume from. Repeated log lines may collapse.

**`#compressorSearch`** — find where something lives without reading whole
files. Narrow with `root` and `include`; use `output=files` or `count` for compact
results. Optional `contextLines=2` adds surrounding lines and merges overlapping
windows. Arrows mark selected matches; `|` marks context. Follow returned `skip`
guidance with unchanged inputs; counts exclude context and may be partial.

> Find every call site of `parseConfig` with #compressorSearch and list the
> files.

> Use #compressorSearch with query="fitMatchPage", root="compressor-vscode",
> include="src/tools/search.ts", contextLines=2. Explain the matching code.

**`#compressorOutline`** — understand a large file's shape before reading it.
Language-provider symbols and exact ranges, with a basic fallback for
TypeScript/JavaScript, Rust, Python and Go.

> Outline #compressorOutline src/engine/index.ts, then read the body of
> compress() with #compressorRead at the offset/limit the marker shows.

That last prompt is the pattern worth remembering: **search or outline to find
the part you need, then read just that part.**

**`#compressorExecute`** runs a confirmed command and returns its exit status,
summary and retained log ID. Inspect the command carefully: it is not sandboxed.

> Use #compressorExecute in the compressor-vscode workspace to run
> "npm test -- tests/search-tool.test.ts". Inspect the exit status.

**`#compressorLog`** retrieves exact captured output by ID and `offset`/`limit`.

> Retrieve omitted diagnostics with #compressorLog using the previous command's
> ID, offset=1, limit=100. Do not rerun the command just to recover output.

Logs last up to 30 minutes and the last five commands; reload clears them.
Capture stops at 2 MB and is marked partial. Adapt example paths to your project.
