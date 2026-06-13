# Compressor — fewer tokens, same work

Compressor saves tokens by reading large files through a compression engine
before they reach the model: comments and repeated lines collapse, line numbers
stay intact, and anything omitted is marked inline so it can be retrieved.

- **In Copilot agent mode**, the model reads files with the `#compressorRead`
  tool.
- **A status-bar ticker** shows the estimated tokens saved — click it for the
  full report.

One honest caveat: VS Code does not let an extension rewrite Copilot's built-in
tool output, so in-editor compression happens only through `#compressorRead`.
No network calls; character counts are exact and token figures are estimates.
