# Watch your savings

Every time a compressor tool (`#compressorRead`, `#compressorSearch`, or
`#compressorOutline`) shrinks text, the extension records one ledger event —
sizes and transform names only, never file contents or paths.

The status-bar item shows the estimated tokens saved in your window. Open the
report (**Compressor: Show Savings**) to see:

- **Totals** — exact characters saved, estimated tokens saved, and the event
  count for the window.
- **Two-tone bars** — the full bar is the total original tokens; the bright
  part is what compressor saved — broken down by day, agent, tool, and mode.
  The **by agent** view separates Copilot (VS Code) from Claude Code and the
  other surfaces sharing the ledger. Hover any bar for the exact character
  breakdown.
- **Actual usage** *(optional — off by default; enable
  `compressor.showActualUsage`)* — authoritative token counts (input / output /
  cache, by model) parsed from this project's Claude Code transcripts. Real
  usage, *not savings* and not billable dollars; Claude Code only.

Character counts are exact; token figures are estimates (chars / 3.5). No
percentage claims — measured savings come from `compressor benchmark`. The
ledger lives in `~/.compressor/ledger`; disable recording with
`COMPRESSOR_NO_LEDGER=1`.
