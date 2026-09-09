# Compressor — fewer tokens, same work

Compressor reduces tool-output traffic before it reaches the model. Source
code and comments are preserved; repeated logs and large search results can
be compacted with recovery guidance. Original file line numbers stay intact.

- **In Copilot agent mode**, five tools do the work — `#compressorRead`
  (read a file), `#compressorSearch` (search the workspace), and
  `#compressorOutline` (symbols), `#compressorExecute` (confirmed commands),
  and `#compressorLog` (retained output).
- **A status-bar ticker** shows estimated output reduction — click it for the
  full report.

One honest caveat: VS Code does not let an extension rewrite Copilot's built-in
tool output, so in-editor compression happens only when the agent uses these
compressor tools. Approved commands can modify files and access the network.
Recorded character counts are exact; token figures are estimates, not net chat
or billed-token savings.
