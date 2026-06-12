import * as vscode from 'vscode';
import { createLedgerSource } from './ledger-source';
import { SavingsTicker } from './ticker';
import { SavingsPanel } from './savings-panel';
import { registerStatusCommand } from './status';

// P2 MVP: savings ticker + report webview + status command. The extension
// makes no network calls and reads no file contents beyond the ledger JSONL.

export function activate(context: vscode.ExtensionContext): void {
  const source = createLedgerSource();
  const ticker = new SavingsTicker(source);
  const panel = new SavingsPanel(source);

  context.subscriptions.push(
    ticker,
    panel,
    vscode.commands.registerCommand('compressor.showSavings', () => panel.show()),
    registerStatusCommand(source),
  );

  ticker.start();
}

export function deactivate(): void {
  // everything is registered in context.subscriptions; VS Code disposes it
}
