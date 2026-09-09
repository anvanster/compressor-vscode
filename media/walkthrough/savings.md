# Inspect output reduction

Eligible read, search, outline and command reductions record ledger events:
sizes and transform names, not source contents or paths. Short commands may
grow after status metadata; log retrieval adds traffic and records no savings.

The status-bar item shows estimated output reduction over the selected lookback. Open the
report (**Compressor: Show Savings**) to see:

- **Totals** — recorded character reduction, estimated token reduction, and event
  count for the window.
- **Two-tone bars** — the full bar is the total original tokens; the bright
  part is output reduction — broken down by day, agent, tool, and mode.
  The **by agent** view separates Copilot (VS Code) from Claude Code and the
  other surfaces sharing the ledger. Hover any bar for the exact character
  breakdown.
- **Actual usage** *(optional — off by default; enable
  `compressor.showActualUsage`)* — authoritative token counts (input / output /
  cache, by model) parsed from this project's Claude Code transcripts. Real
  usage, *not savings* and not billable dollars; Claude Code only.

Character counts are exact; token figures are estimates (chars / 3.5), not net
chat or billed-token savings. Window-local operation counters reset on reload
and do not identify individual chats. Reopen the report to refresh it. The
ledger lives in `~/.compressor/ledger`; disable recording with
`COMPRESSOR_NO_LEDGER=1`.
