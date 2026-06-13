import * as vscode from 'vscode';
import { createLedgerSource } from './ledger-source';
import { SavingsTicker } from './ticker';
import { SavingsPanel } from './savings-panel';
import { registerStatusCommand } from './status';
import { registerReadTool } from './tools/read';
import { registerSteeringCommands } from './steering';
import { registerManageCommands } from './manage';

// P2 MVP: savings ticker + report webview + status command.
// P3: compressor_read languageModelTools tool + Copilot steering file.
// P4: manage commands (init / set-mode / uninstall via library adapters).
// The extension makes no network calls; it reads the ledger JSONL and — only
// when the compressor_read tool is invoked — workspace files.

export function activate(context: vscode.ExtensionContext): void {
  const source = createLedgerSource();
  const ticker = new SavingsTicker(source);
  const panel = new SavingsPanel(source);
  const channel = vscode.window.createOutputChannel('Compressor');

  context.subscriptions.push(
    ticker,
    panel,
    channel,
    vscode.commands.registerCommand('compressor.showSavings', () => panel.show()),
    registerStatusCommand(source, channel),
    registerReadTool(),
    registerSteeringCommands(),
    registerManageCommands(channel),
  );

  ticker.start();
}

export function deactivate(): void {
  // everything is registered in context.subscriptions; VS Code disposes it
}
