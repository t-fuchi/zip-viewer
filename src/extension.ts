import * as vscode from 'vscode';
import * as unzipper from 'unzipper';
import * as tar from 'tar';
import * as path from 'path';
import * as fs from 'fs';
import * as lzma from 'lzma-native';
import * as zlib from 'zlib';
import { pipeline, Readable, Transform } from 'stream';
import { promisify } from 'util';
import bz2 = require('unbzip2-stream');
import * as Seven from 'node-7z';
import * as zstd from '@mongodb-js/zstd';
const sevenBin = require('7zip-bin');

const pipelineAsync = promisify(pipeline);

type PreviewResult =
    | { kind: 'text'; content: string }
    | { kind: 'image'; base64: string; mimeType: string };

interface ArchiveEntry {
    name: string;
    size: number;
    time: number;
    isDirectory: boolean;
    children?: ArchiveEntry[];
    date?: Date;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'zipViewer.viewer',
            new ArchiveFileEditorProvider(context),
            {
                supportsMultipleEditorsPerDocument: false
            }
        )
    );
}

class ArchiveFileEditorProvider implements vscode.CustomReadonlyEditorProvider {
    private archiveFilePath: string | undefined;
    private previewPanel: vscode.WebviewPanel | undefined;
    private archiveEntries: ArchiveEntry[] = [];
    private savedPasswords: { [archiveFilePath: string]: string } = {};
    private previewStartTime: number = 0;
    private minPreviewDuration: number = 300; // 最小300ms表示

    /** 直近のプレビューリクエストID(増加するカウンタ) */
    private previewRequestId: number = 0;
    /** 現在プレビューすべき状態かどうか(マウス押下中など) */
    private isPreviewActive: boolean = false;

    constructor(private readonly context: vscode.ExtensionContext) { }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        this.archiveFilePath = uri.fsPath;
        const extension = this.getExtension(this.archiveFilePath);

        const stats = fs.statSync(this.archiveFilePath);
        const fileSizeMB = stats.size / (1024 * 1024);

        if (fileSizeMB > 10) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Loading archive... (${fileSizeMB.toFixed(1)} MB)`,
                cancellable: true
            }, async (progress, cancellationToken) => {
                if (extension === '.zip') {
                    await this.loadZipEntries(this.archiveFilePath!, progress, cancellationToken);
                } else if (extension === '.7z') {
                    await this.load7zEntries(this.archiveFilePath!, progress, cancellationToken);
                } else if (this.isTarFormat(extension)) {
                    await this.loadTarEntries(this.archiveFilePath!, progress, cancellationToken);
                }
            });
        } else {
            if (extension === '.zip') {
                await this.loadZipEntries(this.archiveFilePath);
            } else if (extension === '.7z') {
                await this.load7zEntries(this.archiveFilePath);
            } else if (this.isTarFormat(extension)) {
                await this.loadTarEntries(this.archiveFilePath);
            }
        }

        return { uri, dispose: () => this.dispose() };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getWebviewContent(this.archiveEntries);

        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === 'previewFile') {
                    const fileUri = message.fileUri;

                    // 新しいプレビューリクエストを発行
                    const requestId = ++this.previewRequestId;
                    this.isPreviewActive = true;

                    const result = await this.previewFile(fileUri);

                    // マウスがすでに離れている(= closePreview 済み)場合や、
                    // これより新しいリクエストがある場合は何もしない
                    if (!this.isPreviewActive || requestId !== this.previewRequestId) {
                        return;
                    }

                    if (result) {
                        this.showPreviewPanel(fileUri, result);
                    }
                } else if (message.command === 'closePreview') {
                    // 現在のプレビューはもう無効
                    this.isPreviewActive = false;
                    this.closePreviewPanel();
                } else if (message.command === 'extractFile') {
                    await this.extractFile(message.fileUri);

                } else if (message.command === 'extractFolder') {
                    await this.extractFolder(message.folderUri);
                } else if (message.command === 'extractSelected') {
                    await this.extractSelected(message.selectedPaths);
                }
            },
            undefined,
            this.context.subscriptions
        );
    }

    private isTarFormat(extension: string): boolean {
        const tarFormats = [
            '.tar', '.tar.gz', '.tgz', '.tar.xz', '.tar.bz2', '.tbz2', '.tz2',
            '.tar.Z', '.taz', '.taZ', '.tar.lz', '.tlz', '.tar.lzma',
            '.tar.zst', '.tzst'
        ];
        return tarFormats.includes(extension);
    }

    private getDecompressionStream(extension: string, filePath: string): Readable {
        const fileStream = fs.createReadStream(filePath);

        switch (extension) {
            case '.tar.gz':
            case '.tgz':
                return fileStream.pipe(zlib.createGunzip());

            case '.tar.bz2':
            case '.tbz2':
            case '.tz2':
                return fileStream.pipe(bz2());

            case '.tar.xz':
                return fileStream.pipe(lzma.createDecompressor());

            case '.tar.Z':
            case '.taz':
            case '.taZ':
                return fileStream.pipe(zlib.createUnzip());

            case '.tar.lz':
            case '.tlz':
                return fileStream.pipe(lzma.createDecompressor());

            case '.tar.lzma':
                return fileStream.pipe(lzma.createDecompressor());

            case '.tar.zst': {
                const chunks: Buffer[] = [];
                const transform = new Transform({
                    transform(chunk: Buffer, _enc: string, cb: (err?: Error) => void) {
                        chunks.push(chunk);
                        cb();
                    },
                    flush(cb: (err?: Error | null) => void) {
                        zstd.decompress(Buffer.concat(chunks))
                            .then(decompressed => { this.push(decompressed); cb(); })
                            .catch(cb);
                    }
                });
                return fileStream.pipe(transform);
            }

            case '.tar':
            default:
                return fileStream;
        }
    }

    private async loadZipEntries(
        zipFilePath: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        cancellationToken?: vscode.CancellationToken
    ) {
        try {
            progress?.report({ message: 'Reading ZIP file directory...' });

            const directory = await unzipper.Open.file(zipFilePath);

            if (cancellationToken?.isCancellationRequested) {
                this.archiveEntries = [];
                return;
            }

            progress?.report({ message: 'Building file tree...', increment: 50 });
            this.archiveEntries = this.buildTree(directory.files);

            progress?.report({ message: 'Complete', increment: 50 });
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Error reading ZIP file: ${error.message}`);
            }
            this.archiveEntries = [];
        }
    }

    private async load7zEntries(
        sevenZipFilePath: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        cancellationToken?: vscode.CancellationToken
    ) {
        try {
            progress?.report({ message: 'Reading 7Z file...' });

            const entries: ArchiveEntry[] = [];
            const sevenZip = Seven.list(sevenZipFilePath, { $bin: this.get7zPath() });

            await new Promise<void>((resolve, reject) => {
                sevenZip.on('data', (data: any) => {
                    if (cancellationToken?.isCancellationRequested) {
                        sevenZip.kill();
                        reject(new Error('Cancelled'));
                        return;
                    }

                    const entry: ArchiveEntry = {
                        name: path.basename(data.file),
                        size: parseInt(data.size) || 0,
                        time: data.date ? new Date(data.date).getTime() : Date.now(),
                        date: data.date ? new Date(data.date) : new Date(),
                        isDirectory: data.attr && data.attr.includes('D')
                    };

                    this.process7zEntry(entries, data.file, entry);
                    progress?.report({ increment: 1 });
                });

                sevenZip.on('end', () => resolve());
                sevenZip.on('error', reject);
            });

            if (cancellationToken?.isCancellationRequested) {
                this.archiveEntries = [];
                return;
            }

            this.archiveEntries = entries;
            progress?.report({ message: 'Complete' });
        } catch (error) {
            if (error instanceof Error && error.message !== 'Cancelled') {
                vscode.window.showErrorMessage(`Error reading 7Z file: ${error.message}`);
            }
            this.archiveEntries = [];
        }
    }

    private process7zEntry(entries: ArchiveEntry[], filePath: string, entry: ArchiveEntry) {
        const parts = filePath.split(/[/\\]/);
        let currentLevel = entries;

        parts.forEach((part, index) => {
            if (!part.trim()) return;

            let existing = currentLevel.find(e => e.name === part);
            if (!existing) {
                if (index === parts.length - 1) {
                    // 最後の部分 = 実際のファイル/フォルダ
                    currentLevel.push(entry);
                } else {
                    // 中間ディレクトリ
                    existing = {
                        name: part,
                        size: 0,
                        time: Date.now(),
                        date: new Date(),
                        isDirectory: true,
                        children: []
                    };
                    currentLevel.push(existing);
                }
            }

            if (existing && existing.isDirectory && index < parts.length - 1) {
                if (!existing.children) existing.children = [];
                currentLevel = existing.children;
            }
        });
    }

    private get7zPath(): string {
        // 7zip-bin package binary
        const binaryPath = sevenBin.path7za;

        // Check and set execution permission (first time only)
        try {
            fs.accessSync(binaryPath, fs.constants.X_OK);
        } catch (error) {
            // Grant execution permission if not present
            try {
                fs.chmodSync(binaryPath, 0o755);
                vscode.window.showInformationMessage('Set execution permission for 7-Zip binary');
            } catch (chmodError) {
                vscode.window.showErrorMessage('Failed to set execution permission for 7-Zip binary. Please run manually: chmod +x ' + binaryPath);
            }
        }

        return binaryPath;
    }

    private async loadTarEntries(
        tarFilePath: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        cancellationToken?: vscode.CancellationToken
    ) {
        const entries: ArchiveEntry[] = [];
        const extension = this.getExtension(tarFilePath);

        const stats = fs.statSync(tarFilePath);
        const totalSize = stats.size;
        let processedSize = 0;
        let lastReportedProgress = 0;

        try {
            progress?.report({ message: `Scanning ${extension} file...` });

            const decompressedStream = this.getDecompressionStream(extension, tarFilePath);

            const progressTrackingStream = new Transform({
                transform(chunk: Buffer, encoding, callback) {
                    if (cancellationToken?.isCancellationRequested) {
                        callback(new Error('Cancelled'));
                        return;
                    }

                    processedSize += chunk.length;
                    const currentProgress = Math.floor((processedSize / totalSize) * 100);

                    if (currentProgress >= lastReportedProgress + 10) {
                        lastReportedProgress = currentProgress;
                        progress?.report({
                            message: `Scanning... ${currentProgress}%`,
                            increment: 10
                        });
                    }

                    callback(null, chunk);
                }
            });

            await pipelineAsync(
                decompressedStream,
                progressTrackingStream,
                tar.t({
                    onentry: entry => {
                        if (!cancellationToken?.isCancellationRequested) {
                            this.processTarEntry(entries, entry);
                        }
                    }
                })
            );

            if (cancellationToken?.isCancellationRequested) {
                this.archiveEntries = [];
                return;
            }

            this.archiveEntries = entries;
            progress?.report({ message: 'Complete' });
        } catch (error) {
            if (error instanceof Error && error.message !== 'Cancelled') {
                vscode.window.showErrorMessage(`Error reading TAR file: ${error.message}`);
            }
            this.archiveEntries = [];
        }
    }

    private processTarEntry(entries: ArchiveEntry[], entry: tar.ReadEntry) {
        const parts = entry.path.split('/');
        let currentLevel = entries;

        parts.forEach((part, index) => {
            if (!part.trim()) return;

            let existing = currentLevel.find(e => e.name === part);
            if (!existing) {
                const mtime = entry.mtime && typeof entry.mtime === 'object' ? entry.mtime : new Date();
                existing = {
                    name: part,
                    size: entry.size || 0,
                    time: mtime.getTime(),
                    date: mtime,
                    isDirectory: entry.type === 'Directory',
                    children: []
                };
                currentLevel.push(existing);
            }

            if (existing.isDirectory && index < parts.length - 1) {
                currentLevel = existing.children!;
            }
        });
    }

    private buildTree(files: any[]): ArchiveEntry[] {
        const root: ArchiveEntry[] = [];

        for (const file of files) {
            const parts = file.path.split('/');
            let currentLevel = root;

            parts.forEach((part: string, index: number) => {
                if (!part.trim()) {
                    return;
                }

                let existing = currentLevel.find(entry => entry.name === part);

                if (!existing) {
                    existing = {
                        name: part,
                        size: file.uncompressedSize,
                        time: new Date(file.lastModifiedDateTime).getTime(),
                        date: new Date(file.lastModifiedDateTime),
                        isDirectory: index < parts.length - 1 || file.type === 'Directory',
                        children: []
                    };
                    currentLevel.push(existing);
                }

                if (existing.isDirectory && index < parts.length - 1) {
                    currentLevel = existing.children!;
                }
            });
        }

        return root;
    }

    private dispose() {
        this.closePreviewPanel();
    }

    private isImageFile(filename: string): boolean {
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico', '.tif', '.tiff', '.avif'];
        const ext = path.extname(filename).toLowerCase();
        return imageExts.includes(ext);
    }

    private getMimeType(filename: string): string {
        const ext = path.extname(filename).toLowerCase();
        const map: { [key: string]: string } = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.gif': 'image/gif',
            '.webp': 'image/webp', '.bmp': 'image/bmp',
            '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
            '.tif': 'image/tiff', '.tiff': 'image/tiff',
            '.avif': 'image/avif'
        };
        return map[ext] ?? 'application/octet-stream';
    }

    private async previewFile(fileUri: string): Promise<PreviewResult | null> {
        if (!this.archiveFilePath) {
            return null;
        }

        const extension = this.getExtension(this.archiveFilePath);
        if (extension === '.zip') {
            return this.previewZipFile(fileUri);
        } else if (extension === '.7z') {
            return this.preview7zFile(fileUri);
        } else if (this.isTarFormat(extension)) {
            return this.previewTarFile(fileUri);
        }
        return null;
    }

    private async previewZipFile(fileUri: string): Promise<PreviewResult | null> {
        try {
            const directory = await unzipper.Open.file(this.archiveFilePath!);
            const file = directory.files.find((f: any) => f.path === fileUri);
            if (!file) {
                return null;
            }

            let password: string | undefined = this.savedPasswords[this.archiveFilePath!];
            if (await this.checkPassword(file, password ?? '')) {
                return await this.loadFilePreview(file, fileUri, password);
            }

            while (true) {
                password = await this.promptForPassword();
                if (!password) {
                    return null;
                }

                if (await this.checkPassword(file, password)) {
                    this.savedPasswords[this.archiveFilePath!] = password;
                    return await this.loadFilePreview(file, fileUri, password);
                } else {
                    vscode.window.showErrorMessage('Password is incorrect. Please try again.');
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Preview error: ${error.message}`);
            }
            return null;
        }
    }

    private async preview7zFile(fileUri: string): Promise<PreviewResult | null> {
        try {
            const config = vscode.workspace.getConfiguration('zipViewer');
            const previewLineCount = config.get<number>('previewLineCount') ?? 20;

            const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), '7z-preview-'));
            const sevenZip = Seven.extractFull(this.archiveFilePath!, tempDir, {
                $bin: this.get7zPath(),
                $raw: [fileUri]
            });

            await new Promise<void>((resolve, reject) => {
                sevenZip.on('end', () => resolve());
                sevenZip.on('error', reject);
            });

            const extractedFilePath = path.join(tempDir, fileUri);
            if (fs.existsSync(extractedFilePath)) {
                let result: PreviewResult;
                if (this.isImageFile(fileUri)) {
                    const buf = fs.readFileSync(extractedFilePath);
                    result = { kind: 'image', base64: buf.toString('base64'), mimeType: this.getMimeType(fileUri) };
                } else {
                    const content = fs.readFileSync(extractedFilePath, 'utf8');
                    result = { kind: 'text', content: content.split('\n').slice(0, previewLineCount).join('\n') };
                }
                fs.rmSync(tempDir, { recursive: true, force: true });
                return result;
            }

            fs.rmSync(tempDir, { recursive: true, force: true });
            return null;
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`7Z preview error: ${error.message}`);
            }
            return null;
        }
    }

    private async previewTarFile(fileUri: string): Promise<PreviewResult | null> {
        if (!this.archiveFilePath) {
            vscode.window.showErrorMessage('File path is not available.');
            return null;
        }

        const isImage = this.isImageFile(fileUri);
        const mimeType = this.getMimeType(fileUri);

        return new Promise<PreviewResult | null>((resolve, reject) => {
            const extension = this.getExtension(this.archiveFilePath!);
            const decompressedStream = this.getDecompressionStream(extension, this.archiveFilePath!);

            decompressedStream.pipe(
                tar.t({
                    onentry: entry => {
                        if (entry.path === fileUri) {
                            const config = vscode.workspace.getConfiguration('zipViewer');
                            const previewLineCount = config.get<number>('previewLineCount') ?? 20;

                            if (isImage) {
                                const chunks: Buffer[] = [];
                                entry.on('data', (chunk: Buffer) => chunks.push(chunk));
                                entry.on('end', () => {
                                    const buf = Buffer.concat(chunks);
                                    resolve({ kind: 'image', base64: buf.toString('base64'), mimeType });
                                });
                                entry.on('error', reject);
                            } else {
                                let content = '';
                                let lines = 0;
                                entry.on('data', (chunk: Buffer) => {
                                    content += chunk.toString();
                                    lines = (content.match(/\n/g) || []).length;
                                    if (lines >= previewLineCount) {
                                        entry.destroy();
                                        resolve({ kind: 'text', content: content.split('\n').slice(0, previewLineCount).join('\n') });
                                    }
                                });
                                entry.on('end', () => {
                                    resolve({ kind: 'text', content: content.split('\n').slice(0, previewLineCount).join('\n') });
                                });
                                entry.on('error', reject);
                            }
                        }
                    }
                }) as any
            ).on('error', reject);
        });
    }

    private async loadFilePreview(file: any, fileUri: string, password: string | undefined): Promise<PreviewResult> {
        const config = vscode.workspace.getConfiguration('zipViewer');
        const previewLineCount = config.get<number>('previewLineCount') ?? 20;
        const stream = file.stream(password ?? '');

        if (this.isImageFile(fileUri)) {
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                stream.on('data', (chunk: Buffer) => chunks.push(chunk));
                stream.on('error', (error: unknown) => {
                    if (error instanceof Error && error.message !== 'unexpected end of file') {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
                stream.on('end', resolve);
            });
            const buf = Buffer.concat(chunks);
            return { kind: 'image', base64: buf.toString('base64'), mimeType: this.getMimeType(fileUri) };
        }

        let content = '';
        let lines = 0;

        try {
            await new Promise<void>((resolve, reject) => {
                stream.on('data', (chunk: any) => {
                    content += chunk.toString();
                    lines = (content.match(/\n/g) || []).length;
                    if (lines >= previewLineCount) {
                        stream.destroy();
                        resolve();
                    }
                });

                stream.on('error', (error: unknown) => {
                    if (error instanceof Error && error.message !== 'unexpected end of file') {
                        reject(error);
                    } else {
                        resolve();
                    }
                });

                stream.on('end', resolve);
            });
        } catch (error: unknown) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Error loading file preview: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('An unknown error occurred while loading file preview.');
            }
        }

        return { kind: 'text', content: content.split('\n').slice(0, previewLineCount).join('\n') };
    }

    private async checkPassword(file: any, password: string): Promise<boolean> {
        try {
            const stream = file.stream(password);
            await new Promise<void>((resolve, reject) => {
                let chunk = '';
                stream.on('data', (data: any) => {
                    chunk += data.toString();
                    if (chunk.includes('\n')) {
                        stream.destroy();
                        resolve();
                    }
                });
                stream.on('error', reject);
                stream.on('end', resolve);
            });
            return true;
        } catch (error: unknown) {
            if (error instanceof Error && error.message === 'MISSING_PASSWORD') {
                return false;
            }
            throw error;
        }
    }

    private async promptForPassword(): Promise<string | undefined> {
        return await vscode.window.showInputBox({
            prompt: 'Enter password for archive file',
            password: true,
            ignoreFocusOut: true
        });
    }

    private showPreviewPanel(title: string, result: PreviewResult) {
        if (!this.previewPanel) {
            this.previewPanel = vscode.window.createWebviewPanel(
                'filePreview',
                `Preview: ${title}`,
                vscode.ViewColumn.Beside,
                {}
            );

            this.previewPanel.onDidDispose(() => {
                this.previewPanel = undefined;
            });
        }

        this.previewPanel.title = `Preview: ${title}`;
        if (result.kind === 'image') {
            this.previewPanel.webview.html = `<html><body style="margin:0;background:#1e1e1e;display:flex;justify-content:center;align-items:center;min-height:100vh;"><img src="data:${result.mimeType};base64,${result.base64}" style="max-width:100%;max-height:100vh;object-fit:contain;"></body></html>`;
        } else {
            this.previewPanel.webview.html = `<html><body><pre>${this.escapeHtml(result.content)}</pre></body></html>`;
        }
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private closePreviewPanel() {
        if (this.previewPanel) {
            this.previewPanel.dispose();
            this.previewPanel = undefined;
        }
    }

    private async extractFile(fileUri: string) {
        if (!this.archiveFilePath) {
            return;
        }

        const extension = this.getExtension(this.archiveFilePath);
        if (extension === '.zip') {
            await this.extractZipFile(fileUri);
        } else if (extension === '.7z') {
            await this.extract7zFile(fileUri);
        } else if (this.isTarFormat(extension)) {
            await this.extractTarFile(fileUri);
        }
    }

    private async extractZipFile(fileUri: string) {
        try {
            const directory = await unzipper.Open.file(this.archiveFilePath!);
            const file = directory.files.find((f: any) => f.path === fileUri);
            if (!file) {
                return;
            }

            let password: string | undefined = this.savedPasswords[this.archiveFilePath!];

            if (!(await this.checkPassword(file, password ?? ''))) {
                password = await this.promptForPassword();
                if (!password || !(await this.checkPassword(file, password))) {
                    vscode.window.showErrorMessage('Extraction failed. Password is invalid or not provided.');
                    return;
                }
                this.savedPasswords[this.archiveFilePath!] = password;
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(this.archiveFilePath!), path.basename(file.path ?? 'default.zip'))),
            });

            if (!saveUri) return;

            const stream = file.stream(password);
            const writeStream = fs.createWriteStream(saveUri.fsPath);
            stream.pipe(writeStream);
            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            vscode.window.showInformationMessage(`File successfully extracted to ${saveUri.fsPath}`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to extract file: ${error.message}`);
            }
        }
    }

    private async extract7zFile(fileUri: string) {
        try {
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(this.archiveFilePath!), path.basename(fileUri))),
            });

            if (!saveUri) return;

            const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), '7z-extract-'));
            const sevenZip = Seven.extractFull(this.archiveFilePath!, tempDir, {
                $bin: this.get7zPath(),
                $raw: [fileUri]
            });

            await new Promise<void>((resolve, reject) => {
                sevenZip.on('end', () => resolve());
                sevenZip.on('error', reject);
            });

            const extractedFilePath = path.join(tempDir, fileUri);
            if (fs.existsSync(extractedFilePath)) {
                fs.copyFileSync(extractedFilePath, saveUri.fsPath);
                fs.rmSync(tempDir, { recursive: true, force: true });
                vscode.window.showInformationMessage(`File successfully extracted to ${saveUri.fsPath}`);
            } else {
                fs.rmSync(tempDir, { recursive: true, force: true });
                vscode.window.showErrorMessage('File not found');
            }
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to extract file: ${error.message}`);
            }
        }
    }

    private async extractTarFile(fileUri: string) {
        if (!this.archiveFilePath) {
            return;
        }

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(this.archiveFilePath!), path.basename(fileUri))),
        });

        if (!saveUri) return;

        const extension = this.getExtension(this.archiveFilePath);

        try {
            const decompressedStream = this.getDecompressionStream(extension, this.archiveFilePath!);

            const extractStream = tar.extract({
                cwd: path.dirname(saveUri.fsPath),
                strip: 1,
                filter: (p: string) => p === fileUri
            });

            await pipelineAsync(decompressedStream, extractStream);
            vscode.window.showInformationMessage(`File successfully extracted to ${saveUri.fsPath}`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to extract file: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Failed to extract file due to an unknown error.');
            }
        }
    }

    private async extractFolder(folderUri: string) {
        if (!this.archiveFilePath) {
            return;
        }

        const extension = this.getExtension(this.archiveFilePath);
        if (extension === '.zip') {
            await this.extractZipFolder(folderUri);
        } else if (extension === '.7z') {
            await this.extract7zFolder(folderUri);
        } else if (this.isTarFormat(extension)) {
            await this.extractTarFolder(folderUri);
        }
    }

    private async extractZipFolder(folderUri: string) {
        try {
            const directory = await unzipper.Open.file(this.archiveFilePath!);
            const folderFiles = directory.files.filter((f: any) => f.path.startsWith(folderUri + '/'));
            let password: string | undefined = this.savedPasswords[this.archiveFilePath!];

            for (const file of folderFiles) {
                if (!(await this.checkPassword(file, password ?? ''))) {
                    password = await this.promptForPassword();
                    if (!password || !(await this.checkPassword(file, password))) {
                        vscode.window.showErrorMessage('Extraction failed. Password is invalid or not provided.');
                        return;
                    }
                    this.savedPasswords[this.archiveFilePath!] = password;
                    break;
                }
            }

            const saveUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(path.dirname(this.archiveFilePath!))
            });

            if (!saveUri || saveUri.length === 0) return;

            const basePath = path.join(saveUri[0].fsPath, path.basename(folderUri));
            for (const file of folderFiles) {
                const relativePath = path.relative(folderUri, file.path);
                const destinationPath = path.join(basePath, relativePath);

                if (file.type === 'Directory') {
                    fs.mkdirSync(destinationPath, { recursive: true });
                } else {
                    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
                    const stream = file.stream(password);
                    const writeStream = fs.createWriteStream(destinationPath);
                    stream.pipe(writeStream);
                    await new Promise((resolve, reject) => {
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });
                }
            }

            vscode.window.showInformationMessage(`Folder successfully extracted to ${saveUri[0].fsPath}`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to extract folder: ${error.message}`);
            }
        }
    }

    private async extractTarFolder(folderUri: string) {
        if (!this.archiveFilePath) {
            return;
        }

        const saveUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(path.dirname(this.archiveFilePath!))
        });

        if (!saveUri || saveUri.length === 0) return;

        const extension = this.getExtension(this.archiveFilePath);

        try {
            const decompressedStream = this.getDecompressionStream(extension, this.archiveFilePath!);

            const extractStream = tar.extract({
                cwd: saveUri[0].fsPath,
                strip: 1,
                filter: (p: string) => p.startsWith(folderUri)
            });

            await pipelineAsync(decompressedStream, extractStream);
            vscode.window.showInformationMessage(`Folder successfully extracted to ${saveUri[0].fsPath}`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to extract folder: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('Failed to extract folder due to an unknown error.');
            }
        }
    }

    private async extract7zFolder(folderUri: string) {
        try {
            const saveUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(path.dirname(this.archiveFilePath!))
            });

            if (!saveUri || saveUri.length === 0) return;

            const sevenZip = Seven.extractFull(this.archiveFilePath!, saveUri[0].fsPath, {
                $bin: this.get7zPath(),
                $raw: [folderUri + '/*']
            });

            await new Promise<void>((resolve, reject) => {
                sevenZip.on('end', () => resolve());
                sevenZip.on('error', reject);
            });

            vscode.window.showInformationMessage(`Folder successfully extracted to ${saveUri[0].fsPath}`);
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Failed to extract folder: ${error.message}`);
            }
        }
    }

    private async extractSelected(selectedPaths: string[]) {
        if (!this.archiveFilePath || selectedPaths.length === 0) {
            return;
        }

        const saveUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(path.dirname(this.archiveFilePath)),
            title: `Extract ${selectedPaths.length} selected items`
        });

        if (!saveUri || saveUri.length === 0) return;

        const extension = this.getExtension(this.archiveFilePath);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Extracting ${selectedPaths.length} items...`,
            cancellable: false
        }, async (progress) => {
            try {
                if (extension === '.zip') {
                    await this.extractSelectedZip(selectedPaths, saveUri[0].fsPath, progress);
                } else if (extension === '.7z') {
                    await this.extractSelected7z(selectedPaths, saveUri[0].fsPath, progress);
                } else if (this.isTarFormat(extension)) {
                    await this.extractSelectedTar(selectedPaths, saveUri[0].fsPath, progress);
                }
                vscode.window.showInformationMessage(`${selectedPaths.length} items successfully extracted to ${saveUri[0].fsPath}`);
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Extraction failed: ${error.message}`);
                }
            }
        });
    }

    private async extractSelectedZip(selectedPaths: string[], destinationPath: string, progress: vscode.Progress<{ message?: string; increment?: number }>) {
        const directory = await unzipper.Open.file(this.archiveFilePath!);
        let password: string | undefined = this.savedPasswords[this.archiveFilePath!];

        const filesToExtract = directory.files.filter(f =>
            selectedPaths.some(selected => f.path === selected || f.path.startsWith(selected + '/'))
        );

        for (let i = 0; i < filesToExtract.length; i++) {
            const file = filesToExtract[i];
            progress.report({
                message: `Extracting... (${i + 1}/${filesToExtract.length})`,
                increment: (100 / filesToExtract.length)
            });

            if (file.type !== 'Directory') {
                if (password === undefined || !(await this.checkPassword(file, password))) {
                    password = await this.promptForPassword();
                    if (!password || !(await this.checkPassword(file, password))) {
                        throw new Error('Invalid password');
                    }
                    this.savedPasswords[this.archiveFilePath!] = password;
                }

                const filePath = path.join(destinationPath, file.path);
                fs.mkdirSync(path.dirname(filePath), { recursive: true });

                const stream = file.stream(password);
                const writeStream = fs.createWriteStream(filePath);
                stream.pipe(writeStream);
                await new Promise((resolve, reject) => {
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });
            }
        }
    }

    private async extractSelectedTar(selectedPaths: string[], destinationPath: string, progress: vscode.Progress<{ message?: string; increment?: number }>) {
        const extension = this.getExtension(this.archiveFilePath!);
        const decompressedStream = this.getDecompressionStream(extension, this.archiveFilePath!);

        let extractedCount = 0;

        await pipelineAsync(
            decompressedStream,
            tar.extract({
                cwd: destinationPath,
                filter: (entryPath: string) => {
                    return selectedPaths.some(selected =>
                        entryPath === selected || entryPath.startsWith(selected + '/')
                    );
                },
                onentry: () => {
                    extractedCount++;
                    progress.report({
                        message: `Extracting... (${extractedCount} items)`,
                        increment: 10
                    });
                }
            })
        );
    }

    private async extractSelected7z(selectedPaths: string[], destinationPath: string, progress: vscode.Progress<{ message?: string; increment?: number }>) {
        for (let i = 0; i < selectedPaths.length; i++) {
            const selectedPath = selectedPaths[i];
            progress.report({
                message: `Extracting... (${i + 1}/${selectedPaths.length})`,
                increment: (100 / selectedPaths.length)
            });

            const sevenZip = Seven.extractFull(this.archiveFilePath!, destinationPath, {
                $bin: this.get7zPath(),
                $raw: [selectedPath]
            });

            await new Promise<void>((resolve, reject) => {
                sevenZip.on('end', () => resolve());
                sevenZip.on('error', reject);
            });
        }
    }

    private getExtension(filePath: string): string {
        const lowerPath = filePath.toLowerCase();

        const compoundExtensions = [
            '.tar.gz', '.tar.xz', '.tar.bz2', '.tar.Z', '.tar.lz', '.tar.lzma', '.tar.zst'
        ];

        for (const ext of compoundExtensions) {
            if (lowerPath.endsWith(ext)) {
                return ext;
            }
        }

        const shortExtensions: { [key: string]: string } = {
            '.tgz': '.tar.gz',
            '.taz': '.tar.Z',
            '.taZ': '.tar.Z',
            '.tz2': '.tar.bz2',
            '.tbz2': '.tar.bz2',
            '.tlz': '.tar.lz',
            '.tzst': '.tar.zst'
        };

        for (const [short, full] of Object.entries(shortExtensions)) {
            if (lowerPath.endsWith(short)) {
                return full;
            }
        }

        return path.extname(filePath).toLowerCase();
    }

    private getTotalSize(entries: ArchiveEntry[], selectedPaths: string[]): number {
        let total = 0;
        const calculateSize = (items: ArchiveEntry[], parentPath: string = '') => {
            for (const item of items) {
                const fullPath = parentPath ? `${parentPath}/${item.name}` : item.name;
                if (selectedPaths.includes(fullPath)) {
                    if (item.isDirectory && item.children) {
                        calculateSize(item.children, fullPath);
                    } else {
                        total += item.size;
                    }
                }
            }
        };
        calculateSize(entries);
        return total;
    }

    private getWebviewContent(files: ArchiveEntry[]): string {
        const renderTree = (files: ArchiveEntry[], depth = 0, parentPath = ''): string => {
            return files.map(file => {
                const fullPath = parentPath ? `${parentPath}/${file.name}` : file.name;
                const indent = `padding-left: ${depth * 20 + 30}px;`;
                const dateStr = file.date ? file.date.toLocaleString('ja-JP') : '';

                if (file.isDirectory) {
                    return `
                        <div style="padding-left: ${depth * 20}px;" class="folder" data-uri="${this.escapeHtml(fullPath)}">
                            <div class="file-info" oncontextmenu="handleFolderRightClick(event, '${this.escapeHtml(fullPath)}')">
                                <input type="checkbox" class="checkbox" data-path="${this.escapeHtml(fullPath)}" onchange="handleCheckboxChange(event)">
                                <span class="caret" onclick="toggleFolder(event)">${this.escapeHtml(file.name)}</span>
                            </div>
                            <div class="nested">${renderTree(file.children!, depth + 1, fullPath)}</div>
                        </div>`;
                } else {
                    return `
                        <div style="${indent}" class="file" data-uri="${this.escapeHtml(fullPath)}" oncontextmenu="handleFileRightClick(event, '${this.escapeHtml(fullPath)}')">
                            <div class="file-info-row" data-uri="${this.escapeHtml(fullPath)}">
                                <input type="checkbox" class="checkbox" data-path="${this.escapeHtml(fullPath)}" data-size="${file.size}" onchange="handleCheckboxChange(event)">
                                <span class="file-name">${this.escapeHtml(file.name)}</span>
                                <span class="file-size">${file.size.toLocaleString()} bytes</span>
                                <span class="file-date">${dateStr}</span>
                            </div>
                        </div>`;
                }
            }).join('');
        };

        return `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Zip Viewer</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                        font-size: 12px;
                        padding: 0;
                        margin: 0;
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    .toolbar {
                        position: sticky;
                        top: 0;
                        background: var(--vscode-editor-background);
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding: 8px 10px;
                        display: flex;
                        gap: 8px;
                        align-items: center;
                        z-index: 100;
                    }
                    .button {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 6px 12px;
                        border-radius: 2px;
                        cursor: pointer;
                        font-size: 11px;
                        font-family: inherit;
                    }
                    .button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .button:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                    .button.secondary {
                        background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                    }
                    .button.secondary:hover {
                        background: var(--vscode-button-secondaryHoverBackground);
                    }
                    .selection-info {
                        margin-left: auto;
                        padding: 6px 12px;
                        background: var(--vscode-inputOption-activeBackground);
                        color: var(--vscode-inputOption-activeForeground);
                        border-radius: 2px;
                        font-size: 11px;
                    }
                    .file-tree {
                        padding: 10px;
                    }
                    .folder, .file {
                        margin: 2px 0;
                    }
                    .file-info, .file-info-row {
                        display: flex;
                        align-items: center;
                        padding: 4px 0;
                        gap: 8px;
                    }
                    .file-info-row {
                        border-bottom: 1px solid var(--vscode-panel-border);
                        padding: 5px 0;
                    }
                    .checkbox {
                        width: 16px;
                        height: 16px;
                        cursor: pointer;
                        flex-shrink: 0;
                    }
                    .file-name {
                        flex: 1;
                        cursor: pointer;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        user-select: none;
                    }
                    .file-name:hover {
                        color: var(--vscode-textLink-foreground);
                    }
                    .file-size {
                        width: 120px;
                        text-align: right;
                        color: var(--vscode-descriptionForeground);
                        flex-shrink: 0;
                    }
                    .file-date {
                        width: 120px;
                        text-align: right;
                        color: var(--vscode-descriptionForeground);
                        flex-shrink: 0;
                    }
                    .nested {
                        display: none;
                        margin-left: 20px;
                    }
                    .caret {
                        cursor: pointer;
                        user-select: none;
                        padding: 4px;
                        margin-left: 4px;
                    }
                    .caret::before {
                        content: "▶";
                        display: inline-block;
                        margin-right: 6px;
                        transform: rotate(0deg);
                        transition: transform 0.2s ease;
                    }
                    .caret-down::before {
                        transform: rotate(90deg);
                    }
                    .active {
                        display: block;
                    }
                </style>
            </head>
            <body>
                <div class="toolbar">
                    <button class="button" id="extractBtn" onclick="extractSelected()" disabled>
                        📦 Extract Selected (<span id="selectedCount">0</span>)
                    </button>
                    <button class="button secondary" onclick="selectAll()">☑️ Select All</button>
                    <button class="button secondary" onclick="clearSelection()">◻️ Clear Selection</button>
                    <div class="selection-info" id="selectionInfo" style="display: none;">
                        <span id="fileCount">0</span> files selected (Total: <span id="totalSize">0</span>)
                    </div>
                </div>
                <div class="file-tree">
                    ${renderTree(files)}
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    let selectedPaths = new Set();
                    let selectedSize = 0;

                    function handleFileRightClick(event, fileUri) {
                        event.stopPropagation();
                        event.preventDefault();
                        vscode.postMessage({ command: 'extractFile', fileUri: fileUri });
                    }

                    function handleFolderRightClick(event, folderUri) {
                        event.stopPropagation();
                        event.preventDefault();
                        vscode.postMessage({ command: 'extractFolder', folderUri: folderUri });
                    }

                    function toggleFolder(event) {
                        event.stopPropagation();
                        const caret = event.target;
                        const folder = caret.closest('.folder');
                        const nested = folder.querySelector('.nested');
                        if (nested) {
                            nested.classList.toggle('active');
                            caret.classList.toggle('caret-down');
                        }
                    }

                    function handleCheckboxChange(event) {
                        const checkbox = event.target;
                        const path = checkbox.dataset.path;
                        const size = parseInt(checkbox.dataset.size || '0');

                        if (checkbox.checked) {
                            selectedPaths.add(path);
                            selectedSize += size;
                            
                            // Check child elements too
                            const parent = checkbox.closest('.folder');
                            if (parent) {
                                const children = parent.querySelectorAll('.nested .checkbox');
                                children.forEach(child => {
                                    if (!child.checked) {
                                        child.checked = true;
                                        selectedPaths.add(child.dataset.path);
                                        selectedSize += parseInt(child.dataset.size || '0');
                                    }
                                });
                            }
                        } else {
                            selectedPaths.delete(path);
                            selectedSize -= size;
                            
                            // Uncheck child elements too
                            const parent = checkbox.closest('.folder');
                            if (parent) {
                                const children = parent.querySelectorAll('.nested .checkbox');
                                children.forEach(child => {
                                    if (child.checked) {
                                        child.checked = false;
                                        selectedPaths.delete(child.dataset.path);
                                        selectedSize -= parseInt(child.dataset.size || '0');
                                    }
                                });
                            }
                        }

                        updateSelectionInfo();
                    }

                    function updateSelectionInfo() {
                        const count = selectedPaths.size;
                        document.getElementById('selectedCount').textContent = count;
                        document.getElementById('fileCount').textContent = count;
                        document.getElementById('totalSize').textContent = formatSize(selectedSize);
                        document.getElementById('extractBtn').disabled = count === 0;
                        document.getElementById('selectionInfo').style.display = count > 0 ? 'block' : 'none';
                    }

                    function formatSize(bytes) {
                        if (bytes < 1024) return bytes + ' B';
                        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
                        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
                        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
                    }

                    function selectAll() {
                        selectedPaths.clear();
                        selectedSize = 0;
                        document.querySelectorAll('.checkbox').forEach(checkbox => {
                            checkbox.checked = true;
                            selectedPaths.add(checkbox.dataset.path);
                            selectedSize += parseInt(checkbox.dataset.size || '0');
                        });
                        updateSelectionInfo();
                    }

                    function clearSelection() {
                        selectedPaths.clear();
                        selectedSize = 0;
                        document.querySelectorAll('.checkbox').forEach(checkbox => {
                            checkbox.checked = false;
                        });
                        updateSelectionInfo();
                    }

                    function extractSelected() {
                        if (selectedPaths.size > 0) {
                            vscode.postMessage({ 
                                command: 'extractSelected', 
                                selectedPaths: Array.from(selectedPaths)
                            });
                        }
                    }

document.addEventListener('DOMContentLoaded', () => {
    const files = document.querySelectorAll('.file-name');

    files.forEach(element => {
        element.addEventListener('mousedown', function (event) {
            const row = this.parentElement; // Should be .file-info
            const fileUri = row && row.getAttribute('data-uri');
            if (fileUri) {
                // Request preview the moment mouse button is pressed
                vscode.postMessage({
                    command: 'previewFile',
                    fileUri: fileUri
                });
            }
        });
    });

    // Close preview when mouse button is released anywhere on the screen
    window.addEventListener('mouseup', function () {
        vscode.postMessage({
            command: 'closePreview'
        });
    });
});

                </script>
            </body>
            </html>`;
    }
}

export function deactivate() { }