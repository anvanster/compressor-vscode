import * as vscode from 'vscode';
import { createLedgerSource } from './ledger-source';
import { setProjectResolver } from './ledger';
import { createProjectResolver } from './project-resolver';
import {
  ensureProjectSalt,
  ledgerDisabled,
  normalizeProjectLabelMode,
  projectLabel,
} from '@astudioplus/compressor';
import { SavingsTicker } from './ticker';
import { SavingsPanel } from './savings-panel';
import { registerStatusCommand } from './status';
import { registerReadTool } from './tools/read';
import { registerSearchTool } from './tools/search';
import { registerOutlineTool } from './tools/outline';
import { registerExecuteTools } from './tools/execute';
import {
  STEERING_REVISION,
  registerSteeringCommands,
  steeringStatus,
  userSteeringStatus,
} from './steering';
import { registerManageCommands } from './manage';
import { ModeStatusItem, registerSelectModeCommand } from './mode-status';
import { registerCountCommand } from './count-tokens';
import { registerCompressSelectionCommand } from './compress-preview';
import { setChatResourceRoot } from './tools/workspace-file';

// P2 MVP: savings ticker + report webview + status command.
// P3: compressor_read languageModelTools tool + Copilot steering file.
// P4: manage commands (init / set-mode / uninstall via library adapters).
// P5: CLI-parity commands — count tokens, compress preview, transcript usage in
//     the report — plus a click-to-toggle mode indicator in the status bar.
// The extension makes no network calls; it reads the ledger JSONL, Claude Code
// session transcripts (for the usage report), and — only when the
// compressor_read tool is invoked — workspace files.

export function activate(context: vscode.ExtensionContext): void {
  // Reading a tool result VS Code spilled to its own storage is the one
  // exception to the workspace boundary; it is anchored to the storage area
  // this extension was given rather than to the segment names alone.
  void setChatResourceRoot(context.globalStorageUri.fsPath);
  // Labelling comes from the library, so this extension and the CLI hooks
  // cannot drift: one key (~/.compressor/project-salt), one algorithm. The key
  // is never written to the ledger, so a shared report cannot be tested against
  // candidate project names.
  const resolveProjectLabel = createProjectResolver({
    salt: ensureProjectSalt,
    disabled: ledgerDisabled,
    folder: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    mode: () => normalizeProjectLabelMode(
      vscode.workspace.getConfiguration('compressor').get('projectLabel'),
    ),
    label: projectLabel,
  });
  setProjectResolver(resolveProjectLabel);

  // Steering that this build would rewrite is surfaced passively: a warning on
  // the ticker, a banner in the report, and a line in "Compressor: Status".
  // Never a notification — an agent loop should not be interrupted by one.
  const staleScopes = async (): Promise<string[]> => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const [workspace, user] = await Promise.all([
      folder === undefined ? Promise.resolve(undefined) : steeringStatus(folder),
      userSteeringStatus(),
    ]);
    const scopes: string[] = [];
    if (workspace?.state === 'outdated') scopes.push('this workspace');
    if (user.state === 'outdated') scopes.push('your user profile');
    return scopes;
  };
  const steeringNotice = async (): Promise<string | undefined> => {
    const scopes = await staleScopes().catch(() => []);
    return scopes.length === 0 ? undefined : `Copilot steering in ${scopes.join(' and ')} is older ` +
      `than this build writes (v${STEERING_REVISION}). Run "Compressor: Enable Copilot Steering" to update it.`;
  };

  const source = createLedgerSource();
  const ticker = new SavingsTicker(source, async () => (await staleScopes()).length > 0);
  const mode = new ModeStatusItem();
  const panel = new SavingsPanel(source, steeringNotice, context.storageUri?.fsPath, resolveProjectLabel);
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
    registerExecuteTools(() => { void ticker.refresh(); }),
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
