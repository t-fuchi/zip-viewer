// Minimal VS Code API mock for unit testing

export const window = {
    showErrorMessage: (_msg: string) => Promise.resolve(undefined),
    showInformationMessage: (_msg: string) => Promise.resolve(undefined),
    showInputBox: (_opts?: any) => Promise.resolve(undefined),
    showSaveDialog: (_opts?: any) => Promise.resolve(undefined),
    showOpenDialog: (_opts?: any) => Promise.resolve(undefined),
    withProgress: (_opts: any, task: (progress: any, token: any) => Promise<any>) =>
        task({ report: () => {} }, { isCancellationRequested: false }),
    createWebviewPanel: (_viewType: string, title: string, _column: any, _opts?: any) => ({
        webview: { html: '', options: {}, onDidReceiveMessage: () => ({ dispose: () => {} }) },
        title,
        onDidDispose: (_cb: () => void) => ({ dispose: () => {} }),
        dispose: () => {},
        reveal: () => {}
    })
};

export const workspace = {
    getConfiguration: (_section?: string) => ({
        get: (_key: string, defaultValue?: any) => defaultValue
    })
};

export const Uri = {
    file: (path: string) => ({ fsPath: path, scheme: 'file', toString: () => path })
};

export const ViewColumn = { Beside: 2, One: 1 };
export const ProgressLocation = { Notification: 15 };

export const CancellationToken = {};
