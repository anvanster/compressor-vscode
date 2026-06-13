import * as vscode from 'vscode';
import { createLedgerSource } from './ledger-source';
import { SavingsTicker } from './ticker';
import { SavingsPanel } from './savings-panel';
import { registerStatusCommand } from './status';
import { registerReadTool } from './tools/read';
import { registerSearchTool } from './tools/search';
import { registerOutlineTool } from './tools/outline';
import { registerSteeringCommands } from './steering';
import { registerManageCommands } from './manage';
import { ModeStatusItem, registerSelectModeCommand } from './mode-status';
import { registerCountCommand } from './count-tokens';
import { registerCompressSelectionCommand } from './compress-preview';

// P2 MVP: savings ticker + report webview + status command.
// P3: compressor_read languageModelTools tool + Copilot steering file.
// P4: manage commands (init / set-mode / uninstall via library adapters).
// P5: CLI-parity commands — count tokens, compress preview, transcript usage in
//     the report — plus a click-to-toggle mode indicator in the status bar.
// The extension makes no network calls; it reads the ledger JSONL, Claude Code
// session transcripts (for the usage report), and — only when the
// compressor_read tool is invoked — workspace files.

export function activate(context: vscode.ExtensionContext): void {
  const source = createLedgerSource();
  const ticker = new SavingsTicker(source);
  const mode = new ModeStatusItem();
  const panel = new SavingsPanel(source);
  const channel = vscode.window.createOutputChannel('Compressor');

  context.subscriptions.push(
    ticker,
    mode,
    panel,
    channel,
    vscode.commands.registerCommand('compressor.showSavings', () => panel.show()),
    registerStatusCommand(source, channel),
    registerReadTool(),
    registerSearchTool(),
    registerOutlineTool(),
    registerSteeringCommands(),
    registerManageCommands(channel),
    registerSelectModeCommand(),
    registerCountCommand(),
    registerCompressSelectionCommand(),
  );

  ticker.start();
  mode.start();
}

export function deactivate(): void {
  // everything is registered in context.subscriptions; VS Code disposes it
}
