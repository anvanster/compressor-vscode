# Compressor — fewer tokens, same work

Compressor saves tokens by routing the agent's file work through a compression
engine before the text reaches the model: comments and repeated lines collapse,
line numbers stay intact, and anything omitted is marked inline so it can be
retrieved.

- **In Copilot agent mode**, three tools do the work — `#compressorRead`
  (read a file), `#compressorSearch` (search the workspace), and
  `#compressorOutline` (a file's structure).
- **A status-bar ticker** shows the estimated tokens saved — click it for the
  full report.

One honest caveat: VS Code does not let an extension rewrite Copilot's built-in
tool output, so in-editor compression happens only when the agent uses these
compressor tools. No network calls; character counts are exact and token
figures are estimates.
