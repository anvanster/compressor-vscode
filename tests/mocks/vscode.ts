// Minimal stand-in for the 'vscode' module so src modules can be imported
// under vitest (the real module only exists inside the extension host).
// Wired via the `vscode` alias in vitest.config.ts; only the members the
// sources touch exist, and tests exercise the pure helpers, not the host.

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ViewColumn = { One: 1, Two: 2, Active: -1 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

interface DisposableLike {
  dispose(): unknown;
}

export class Disposable {
  static from(...items: DisposableLike[]): Disposable {
    return new Disposable(() => {
      for (const item of items) {
        item.dispose();
      }
    });
  }

  constructor(private readonly callOnDispose?: () => void) {}

  dispose(): void {
    this.callOnDispose?.();
  }
}

const noopDisposable: DisposableLike = { dispose(): void {} };

export const window = {
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: undefined as string | undefined,
    show(): void {},
    hide(): void {},
    dispose(): void {},
  }),
  onDidChangeWindowState: () => noopDisposable,
  createWebviewPanel: () => ({
    webview: { html: '' },
    reveal(): void {},
    onDidDispose: () => noopDisposable,
    dispose(): void {},
  }),
  createOutputChannel: () => ({
    appendLine(): void {},
    clear(): void {},
    show(): void {},
    dispose(): void {},
  }),
  showQuickPick: async (): Promise<undefined> => undefined,
  showInformationMessage: async (): Promise<undefined> => undefined,
  showWarningMessage: async (): Promise<undefined> => undefined,
  showErrorMessage: async (): Promise<undefined> => undefined,
  activeTextEditor: undefined as unknown,
};

export const workspace = {
  workspaceFolders: undefined as undefined,
  getConfiguration: () => ({
    get: <T>(_section: string, defaultValue?: T): T | undefined => defaultValue,
    update: async (): Promise<void> => undefined,
  }),
  onDidChangeConfiguration: () => noopDisposable,
  openTextDocument: async (): Promise<{ uri: unknown }> => ({ uri: undefined }),
};

export const commands = {
  registerCommand: () => noopDisposable,
  executeCommand: async (): Promise<undefined> => undefined,
};

// LanguageModelTool API (finalized in VS Code 1.95) — value shapes only.
export class LanguageModelTextPart {
  constructor(public readonly value: string) {}
}

export class LanguageModelToolResult {
  constructor(public readonly content: unknown[]) {}
}

export const lm = {
  registerTool: () => noopDisposable,
};
