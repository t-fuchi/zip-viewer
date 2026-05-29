import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { pipeline, Readable, Transform } from 'stream';
import { promisify } from 'util';
import { spawn } from 'child_process';
import type * as tarType from 'tar';
import type * as unzipperType from 'unzipper';
import type * as SevenType from 'node-7z';

// Heavy/native modules — lazy-loaded on first use to keep activation fast.
let _sevenBinPath: string | null = null;
let _tar: typeof tarType | null = null;
let _unzipper: typeof unzipperType | null = null;
let _Seven: typeof SevenType | null = null;
let _lzma: any = null;
let _zstd: any = null;
let _bz2: any = null;
let _MarkdownIt: any = null;
let _sevenBin: any = null;
function getTar() { return _tar ?? (_tar = require('tar')); }
function getUnzipper() { return _unzipper ?? (_unzipper = require('unzipper')); }
function getSeven() { return _Seven ?? (_Seven = require('node-7z')); }
function getLzma() { return _lzma ?? (_lzma = require('lzma-native')); }
function getZstd() { return _zstd ?? (_zstd = require('@mongodb-js/zstd')); }
function getBz2() { return _bz2 ?? (_bz2 = require('unbzip2-stream')); }
function getMarkdownIt() { return _MarkdownIt ?? (_MarkdownIt = require('markdown-it')); }
function getSevenBin() { return _sevenBin ?? (_sevenBin = require('7zip-bin')); }

const pipelineAsync = promisify(pipeline);

type ArchiveListEntry = { path: string; size: number; isDir: boolean };

type PreviewResult =
    | { kind: 'text'; content: string }
    | { kind: 'image'; base64: string; mimeType: string }
    | { kind: 'markdown'; html: string }
    | { kind: 'archive-list'; archiveName: string; entries: ArchiveListEntry[] };

interface ArchiveEntry {
    name: string;
    size: number;
    time: number;
    isDirectory: boolean;
    children?: ArchiveEntry[];
    date?: Date;
}

interface DocumentState {
    archiveFilePath: string;
    archiveEntries: ArchiveEntry[];
    previewPanel: vscode.WebviewPanel | undefined;
    previewRequestId: number;
    zipDirectory?: any;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'zipViewer.viewer',
            new ArchiveFileEditorProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true }
            }
        )
    );

    // Eagerly load unzipper here so the first ZIP open is instant.
    // activate() runs at onStartupFinished, after VS Code is already responsive,
    // so this ~150ms one-time cost is invisible to the user.
    try { getUnzipper(); } catch { /* ignore */ }
}

class ArchiveFileEditorProvider implements vscode.CustomReadonlyEditorProvider {
    private readonly documentStates = new Map<string, DocumentState>();
    private readonly savedPasswords: { [archiveFilePath: string]: string } = {};

    constructor(private readonly context: vscode.ExtensionContext) { }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        const state: DocumentState = {
            archiveFilePath: uri.fsPath,
            archiveEntries: [],
            previewPanel: undefined,
            previewRequestId: 0
        };
        this.documentStates.set(uri.toString(), state);

        return {
            uri,
            dispose: () => {
                const s = this.documentStates.get(uri.toString());
                if (s?.previewPanel) {
                    s.previewPanel.dispose();
                }
                this.documentStates.delete(uri.toString());
            }
        };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        let state = this.documentStates.get(document.uri.toString());
        if (!state) {
            state = {
                archiveFilePath: document.uri.fsPath,
                archiveEntries: [],
                previewPanel: undefined,
                previewRequestId: 0
            };
            this.documentStates.set(document.uri.toString(), state);
        }

        webviewPanel.webview.options = { enableScripts: true };
        // Show loading UI immediately so the panel appears without delay
        webviewPanel.webview.html = this.getWebviewContent([], webviewPanel.webview, true);

        webviewPanel.webview.onDidReceiveMessage(
            async (message) => {
                if (message.command === 'previewFile') {
                    const fileUri = message.fileUri;
                    const requestId = ++state!.previewRequestId;

                    let result: PreviewResult | null = null;
                    try {
                        result = await this.previewFile(fileUri, state!.archiveFilePath, state!);
                    } catch (err) {
                        vscode.window.showErrorMessage(`Preview error: ${err instanceof Error ? err.message : String(err)}`);
                        return;
                    }

                    if (requestId !== state!.previewRequestId) {
                        return;
                    }

                    if (result) {
                        this.showPreviewPanel(fileUri, result, state!);
                    }
                } else if (message.command === 'closePreview') {
                    state!.previewRequestId++;
                    this.closePreviewPanel(state!);
                } else if (message.command === 'extractFile') {
                    await this.extractFile(message.fileUri, state!.archiveFilePath);

                } else if (message.command === 'extractFolder') {
                    await this.extractFolder(message.folderUri, state!.archiveFilePath);
                } else if (message.command === 'extractSelected') {
                    await this.extractSelected(message.selectedPaths, state!.archiveFilePath);
                }
            },
            undefined,
            this.context.subscriptions
        );

        // Fire-and-forget: do NOT await here — resolveCustomEditor must return
        // quickly so VS Code renders the webview immediately with the loading state.
        void this.loadAndPostTree(state!, webviewPanel);
    }

    private async loadAndPostTree(state: DocumentState, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const archiveFilePath = state.archiveFilePath;
        const extension = this.getExtension(archiveFilePath);
        const stats = fs.statSync(archiveFilePath);
        const fileSizeMB = stats.size / (1024 * 1024);

        const doLoad = async (
            progress?: vscode.Progress<{ message?: string; increment?: number }>,
            cancellationToken?: vscode.CancellationToken
        ): Promise<ArchiveEntry[]> => {
            if (extension === '.zip') {
                return this.loadZipEntries(archiveFilePath, state, progress, cancellationToken);
            } else if (extension === '.7z') {
                return this.load7zEntries(archiveFilePath, progress, cancellationToken);
            } else if (this.isTarFormat(extension)) {
                return this.loadTarEntries(archiveFilePath, progress, cancellationToken);
            }
            return [];
        };

        let entries: ArchiveEntry[];
        if (fileSizeMB > 10) {
            entries = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Loading archive... (${fileSizeMB.toFixed(1)} MB)`,
                cancellable: true
            }, (progress, cancellationToken) => doLoad(progress, cancellationToken));
        } else {
            entries = await doLoad();
        }

        state.archiveEntries = entries;
        webviewPanel.webview.postMessage({
            command: 'updateTree',
            html: this.renderTreeHtml(entries)
        });
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
                return fileStream.pipe(getBz2()());

            case '.tar.xz':
                return fileStream.pipe(getLzma().createDecompressor());

            case '.tar.Z':
            case '.taz':
            case '.taZ': {
                fileStream.destroy();
                const child = spawn(this.get7zPath(), ['e', '-so', filePath]);
                return child.stdout as unknown as Readable;
            }

            case '.tar.lz':
            case '.tlz':
                return fileStream.pipe(getLzma().createDecompressor());

            case '.tar.lzma':
                return fileStream.pipe(getLzma().createDecompressor());

            case '.tar.zst': {
                const chunks: Buffer[] = [];
                const transform = new Transform({
                    transform(chunk: Buffer, _enc: string, cb: (err?: Error) => void) {
                        chunks.push(chunk);
                        cb();
                    },
                    flush(cb: (err?: Error | null) => void) {
                        getZstd().decompress(Buffer.concat(chunks))
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
        state?: DocumentState,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        cancellationToken?: vscode.CancellationToken
    ): Promise<ArchiveEntry[]> {
        try {
            progress?.report({ message: 'Reading ZIP file directory...' });

            const directory = await getUnzipper().Open.file(zipFilePath);
            if (state) state.zipDirectory = directory;

            if (cancellationToken?.isCancellationRequested) {
                return [];
            }

            progress?.report({ message: 'Building file tree...', increment: 50 });
            const entries = this.buildTree(directory.files);

            progress?.report({ message: 'Complete', increment: 50 });
            return entries;
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`Error reading ZIP file: ${error.message}`);
            }
            return [];
        }
    }

    private async load7zEntries(
        sevenZipFilePath: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        cancellationToken?: vscode.CancellationToken
    ): Promise<ArchiveEntry[]> {
        try {
            progress?.report({ message: 'Reading 7Z file...' });

            const entries: ArchiveEntry[] = [];
            const sevenZip = getSeven().list(sevenZipFilePath, { $bin: this.get7zPath() });

            await new Promise<void>((resolve, reject) => {
                sevenZip.on('data', (data: any) => {
                    if (cancellationToken?.isCancellationRequested) {
                        (sevenZip as any).destroy();
                        reject(new Error('Cancelled'));
                        return;
                    }

                    const entry: ArchiveEntry = {
                        name: path.basename(data.file),
                        size: data.size || 0,
                        time: data.datetime ? data.datetime.getTime() : Date.now(),
                        date: data.datetime ?? new Date(),
                        isDirectory: data.attributes ? data.attributes.includes('D') : false
                    };

                    this.process7zEntry(entries, data.file, entry);
                    progress?.report({ increment: 1 });
                });

                sevenZip.on('end', () => resolve());
                sevenZip.on('error', reject);
            });

            if (cancellationToken?.isCancellationRequested) {
                return [];
            }

            progress?.report({ message: 'Complete' });
            return entries;
        } catch (error) {
            if (error instanceof Error && error.message !== 'Cancelled') {
                vscode.window.showErrorMessage(`Error reading 7Z file: ${error.message}`);
            }
            return [];
        }
    }

    private isSystemFile(pathParts: string[]): boolean {
        return pathParts.some(part =>
            part === '.DS_Store' ||
            part === '__MACOSX' ||
            part === 'Thumbs.db' ||
            part === 'desktop.ini' ||
            part.startsWith('._')
        );
    }

    private process7zEntry(entries: ArchiveEntry[], filePath: string, entry: ArchiveEntry) {
        const parts = filePath.split(/[/\\]/);
        if (this.isSystemFile(parts)) return;
        let currentLevel = entries;

        parts.forEach((part, index) => {
            if (!part.trim()) return;

            let existing = currentLevel.find(e => e.name === part);
            if (!existing) {
                if (index === parts.length - 1) {
                    currentLevel.push(entry);
                } else {
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
        if (_sevenBinPath) return _sevenBinPath;
        const binaryPath = getSevenBin().path7za;
        try {
            fs.accessSync(binaryPath, fs.constants.X_OK);
        } catch (error) {
            try {
                fs.chmodSync(binaryPath, 0o755);
                vscode.window.showInformationMessage('Set execution permission for 7-Zip binary');
            } catch (chmodError) {
                vscode.window.showErrorMessage('Failed to set execution permission for 7-Zip binary. Please run manually: chmod +x ' + binaryPath);
            }
        }
        _sevenBinPath = binaryPath;
        return binaryPath;
    }

    private async loadTarEntries(
        tarFilePath: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        cancellationToken?: vscode.CancellationToken
    ): Promise<ArchiveEntry[]> {
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
                getTar().t({
                    onentry: entry => {
                        if (!cancellationToken?.isCancellationRequested) {
                            this.processTarEntry(entries, entry);
                        }
                    }
                })
            );

            if (cancellationToken?.isCancellationRequested) {
                return [];
            }

            progress?.report({ message: 'Complete' });
            return entries;
        } catch (error) {
            if (error instanceof Error && error.message !== 'Cancelled') {
                vscode.window.showErrorMessage(`Error reading TAR file: ${error.message}`);
            }
            return [];
        }
    }

    private processTarEntry(entries: ArchiveEntry[], entry: tarType.ReadEntry) {
        const parts = entry.path.split('/');
        if (this.isSystemFile(parts)) return;
        let currentLevel = entries;

        parts.forEach((part, index) => {
            if (!part.trim()) return;

            const isIntermediate = index < parts.length - 1;
            let existing = currentLevel.find(e => e.name === part);
            if (!existing) {
                const mtime = entry.mtime && typeof entry.mtime === 'object' ? entry.mtime : new Date();
                existing = {
                    name: part,
                    size: entry.size || 0,
                    time: mtime.getTime(),
                    date: mtime,
                    isDirectory: isIntermediate || entry.type === 'Directory',
                    children: []
                };
                currentLevel.push(existing);
            } else if (isIntermediate) {
                existing.isDirectory = true;
            }

            if (isIntermediate) {
                currentLevel = existing.children!;
            }
        });
    }

    private buildTree(files: any[]): ArchiveEntry[] {
        const root: ArchiveEntry[] = [];

        for (const file of files) {
            const parts = file.path.split('/');
            if (this.isSystemFile(parts)) continue;
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
        // Individual document cleanup is handled by the document's dispose() method
    }

    private isMarkdownFile(filename: string): boolean {
        return ['.md', '.markdown'].includes(path.extname(filename).toLowerCase());
    }

    private resolveArchivePath(mdFilePath: string, imgPath: string): string {
        if (imgPath.startsWith('http://') || imgPath.startsWith('https://') || imgPath.startsWith('data:')) {
            return imgPath;
        }
        const mdDir = mdFilePath.includes('/') ? mdFilePath.substring(0, mdFilePath.lastIndexOf('/')) : '';
        const combined = mdDir ? `${mdDir}/${imgPath}` : imgPath;
        const parts = combined.split('/');
        const resolved: string[] = [];
        for (const part of parts) {
            if (part === '..') resolved.pop();
            else if (part !== '.' && part !== '') resolved.push(part);
        }
        return resolved.join('/');
    }

    private extractImageRefs(content: string, mdFilePath: string): string[] {
        const regex = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
        const refs = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
            const rawSrc = match[1];
            if (!rawSrc.startsWith('http') && !rawSrc.startsWith('data:')) {
                refs.add(this.resolveArchivePath(mdFilePath, rawSrc));
            }
        }
        return [...refs];
    }

    private async renderMarkdownWithImages(
        content: string,
        mdFilePath: string,
        loadImage: (archivePath: string) => Promise<{ base64: string; mimeType: string } | null>
    ): Promise<string> {
        const regex = /!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g;
        const rawToDataUri = new Map<string, string>();

        let m: RegExpExecArray | null;
        while ((m = regex.exec(content)) !== null) {
            const rawSrc = m[2];
            if (!rawSrc.startsWith('http') && !rawSrc.startsWith('data:') && !rawToDataUri.has(rawSrc)) {
                const archivePath = this.resolveArchivePath(mdFilePath, rawSrc);
                const img = await loadImage(archivePath);
                rawToDataUri.set(rawSrc, img ? `data:${img.mimeType};base64,${img.base64}` : rawSrc);
            }
        }

        const processed = content.replace(/!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (_, alt, src, rest) => {
            const uri = rawToDataUri.get(src);
            return `![${alt}](${uri && uri !== src ? uri : src}${rest})`;
        });

        const md = new (getMarkdownIt())({ html: false, linkify: true });
        return md.render(processed);
    }

    private async readZipFileAsText(file: any, password?: string): Promise<string> {
        const stream = file.stream(password ?? '');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', resolve);
            stream.on('error', (err: Error) => {
                if (err.message !== 'unexpected end of file') reject(err); else resolve();
            });
        });
        return Buffer.concat(chunks).toString('utf8');
    }

    private async readZipFileAsBuffer(file: any, password?: string): Promise<Buffer> {
        const stream = file.stream(password ?? '');
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', resolve);
            stream.on('error', (err: Error) => {
                if (err.message !== 'unexpected end of file') reject(err); else resolve();
            });
        });
        return Buffer.concat(chunks);
    }

    private async loadImageFromZip(imagePath: string, archiveFilePath: string, password?: string): Promise<{ base64: string; mimeType: string } | null> {
        try {
            const directory = await getUnzipper().Open.file(archiveFilePath);
            const file = directory.files.find((f: any) => f.path === imagePath);
            if (!file) return null;
            const stream = file.stream(password ?? '');
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                stream.on('data', (c: Buffer) => chunks.push(c));
                stream.on('end', resolve);
                stream.on('error', (err: Error) => {
                    if (err.message !== 'unexpected end of file') reject(err); else resolve();
                });
            });
            return { base64: Buffer.concat(chunks).toString('base64'), mimeType: this.getMimeType(imagePath) };
        } catch { return null; }
    }

    private async readTextFromTar(fileUri: string, archiveFilePath: string): Promise<string | null> {
        return new Promise<string | null>((resolve, reject) => {
            const extension = this.getExtension(archiveFilePath);
            const decompressedStream = this.getDecompressionStream(extension, archiveFilePath);
            decompressedStream.on('error', reject);
            decompressedStream.pipe(
                getTar().t({
                    onentry: entry => {
                        if (entry.path === fileUri) {
                            const chunks: Buffer[] = [];
                            entry.on('data', (c: Buffer) => chunks.push(c));
                            entry.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                            entry.on('error', reject);
                        }
                    }
                }) as any
            ).on('finish', () => resolve(null)).on('error', reject);
        });
    }

    private async loadImagesFromTar(imagePaths: string[], archiveFilePath: string): Promise<Map<string, { base64: string; mimeType: string }>> {
        const result = new Map<string, { base64: string; mimeType: string }>();
        if (imagePaths.length === 0) return result;
        const remaining = new Set(imagePaths);
        await new Promise<void>((resolve, reject) => {
            const extension = this.getExtension(archiveFilePath);
            const decompressedStream = this.getDecompressionStream(extension, archiveFilePath);
            decompressedStream.on('error', reject);
            decompressedStream.pipe(
                getTar().t({
                    onentry: entry => {
                        if (remaining.has(entry.path)) {
                            remaining.delete(entry.path);
                            const chunks: Buffer[] = [];
                            entry.on('data', (c: Buffer) => chunks.push(c));
                            entry.on('end', () => {
                                result.set(entry.path, {
                                    base64: Buffer.concat(chunks).toString('base64'),
                                    mimeType: this.getMimeType(entry.path)
                                });
                            });
                        }
                    }
                }) as any
            ).on('finish', resolve).on('error', reject);
        });
        return result;
    }

    private isArchiveFile(filename: string): boolean {
        const ext = this.getExtension(filename);
        return ['.zip', '.7z', '.tar', '.tar.gz', '.tar.xz', '.tar.bz2',
                '.tar.Z', '.tar.lz', '.tar.lzma', '.tar.zst'].includes(ext);
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

    private async previewFile(fileUri: string, archiveFilePath: string, state?: DocumentState): Promise<PreviewResult | null> {
        const extension = this.getExtension(archiveFilePath);
        if (extension === '.zip') {
            return this.previewZipFile(fileUri, archiveFilePath, state);
        } else if (extension === '.7z') {
            return this.preview7zFile(fileUri, archiveFilePath);
        } else if (this.isTarFormat(extension)) {
            return this.previewTarFile(fileUri, archiveFilePath);
        }
        return null;
    }

    private async previewZipFile(fileUri: string, archiveFilePath: string, state?: DocumentState): Promise<PreviewResult | null> {
        try {
            const directory = state?.zipDirectory ?? await getUnzipper().Open.file(archiveFilePath);
            const file = directory.files.find((f: any) => f.path === fileUri);
            if (!file) {
                return null;
            }

            const produceResult = async (pw: string | undefined): Promise<PreviewResult> => {
                if (this.isMarkdownFile(fileUri)) {
                    const content = await this.readZipFileAsText(file, pw);
                    const html = await this.renderMarkdownWithImages(content, fileUri,
                        imgPath => this.loadImageFromZip(imgPath, archiveFilePath, pw));
                    return { kind: 'markdown', html };
                }
                if (this.isArchiveFile(fileUri)) {
                    const buf = await this.readZipFileAsBuffer(file, pw);
                    const innerExt = this.getExtension(fileUri);
                    const entries = await this.listNestedArchiveEntries(buf, innerExt);
                    return { kind: 'archive-list', archiveName: path.basename(fileUri), entries };
                }
                return this.loadFilePreview(file, fileUri, pw);
            };

            let password: string | undefined = this.savedPasswords[archiveFilePath];
            if (await this.checkPassword(file, password ?? '')) {
                return await produceResult(password);
            }

            while (true) {
                password = await this.promptForPassword();
                if (!password) {
                    return null;
                }

                if (await this.checkPassword(file, password)) {
                    this.savedPasswords[archiveFilePath] = password;
                    return await produceResult(password);
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

    private async preview7zFile(fileUri: string, archiveFilePath: string): Promise<PreviewResult | null> {
        try {
            const config = vscode.workspace.getConfiguration('zipViewer');
            const previewLineCount = config.get<number>('previewLineCount') ?? 20;

            let password: string | undefined = this.savedPasswords[archiveFilePath];

            while (true) {
                const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), '7z-preview-'));
                let extractFailed = false;

                try {
                    const sevenZip = getSeven().extractFull(archiveFilePath, tempDir, {
                        $bin: this.get7zPath(),
                        $raw: [fileUri, `-p${password ?? ''}`]
                    });
                    await new Promise<void>((resolve, reject) => {
                        sevenZip.on('end', resolve);
                        sevenZip.on('error', reject);
                    });
                } catch {
                    extractFailed = true;
                }

                const extractedFilePath = path.join(tempDir, fileUri);

                if (!extractFailed && fs.existsSync(extractedFilePath)) {
                    if (password) this.savedPasswords[archiveFilePath] = password;

                    let result: PreviewResult;
                    if (this.isArchiveFile(fileUri)) {
                        const innerExt = this.getExtension(fileUri);
                        const entries = await this.listNestedArchiveEntriesFromPath(extractedFilePath, innerExt);
                        result = { kind: 'archive-list', archiveName: path.basename(fileUri), entries };
                    } else if (this.isImageFile(fileUri)) {
                        const buf = fs.readFileSync(extractedFilePath);
                        result = { kind: 'image', base64: buf.toString('base64'), mimeType: this.getMimeType(fileUri) };
                    } else if (this.isMarkdownFile(fileUri)) {
                        const mdContent = fs.readFileSync(extractedFilePath, 'utf8');
                        const imageRefs = this.extractImageRefs(mdContent, fileUri);
                        if (imageRefs.length > 0) {
                            await new Promise<void>(res => {
                                const sz = getSeven().extractFull(archiveFilePath, tempDir, {
                                    $bin: this.get7zPath(),
                                    $raw: [...imageRefs, `-p${password ?? ''}`]
                                });
                                sz.on('end', res);
                                sz.on('error', () => res());
                            });
                        }
                        const html = await this.renderMarkdownWithImages(mdContent, fileUri, async archivePath => {
                            const p = path.join(tempDir, archivePath);
                            if (fs.existsSync(p)) {
                                const buf = fs.readFileSync(p);
                                return { base64: buf.toString('base64'), mimeType: this.getMimeType(archivePath) };
                            }
                            return null;
                        });
                        result = { kind: 'markdown', html };
                    } else {
                        const content = fs.readFileSync(extractedFilePath, 'utf8');
                        result = { kind: 'text', content: content.split('\n').slice(0, previewLineCount).join('\n') };
                    }
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    return result;
                }

                fs.rmSync(tempDir, { recursive: true, force: true });

                if (!extractFailed) {
                    return null;
                }

                if (password !== undefined) {
                    vscode.window.showErrorMessage('Password is incorrect. Please try again.');
                }

                const newPassword = await this.promptForPassword();
                if (!newPassword) return null;
                password = newPassword;
            }
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`7Z preview error: ${error.message}`);
            }
            return null;
        }
    }

    private async previewTarFile(fileUri: string, archiveFilePath: string): Promise<PreviewResult | null> {
        if (this.isMarkdownFile(fileUri)) {
            const content = await this.readTextFromTar(fileUri, archiveFilePath);
            if (content === null) return null;
            const imagePaths = this.extractImageRefs(content, fileUri);
            const imageMap = await this.loadImagesFromTar(imagePaths, archiveFilePath);
            const html = await this.renderMarkdownWithImages(content, fileUri,
                async archivePath => imageMap.get(archivePath) ?? null);
            return { kind: 'markdown', html };
        }

        const isImage = this.isImageFile(fileUri);
        const isArchive = this.isArchiveFile(fileUri);
        const mimeType = this.getMimeType(fileUri);

        return new Promise<PreviewResult | null>((resolve, reject) => {
            const extension = this.getExtension(archiveFilePath);
            const decompressedStream = this.getDecompressionStream(extension, archiveFilePath);
            decompressedStream.on('error', reject);
            let asyncPending = false;

            decompressedStream.pipe(
                getTar().t({
                    onentry: entry => {
                        if (entry.path === fileUri) {
                            const config = vscode.workspace.getConfiguration('zipViewer');
                            const previewLineCount = config.get<number>('previewLineCount') ?? 20;

                            if (isArchive || isImage) {
                                const chunks: Buffer[] = [];
                                entry.on('data', (chunk: Buffer) => chunks.push(chunk));
                                entry.on('end', async () => {
                                    const buf = Buffer.concat(chunks);
                                    if (isArchive) {
                                        asyncPending = true;
                                        try {
                                            const innerExt = this.getExtension(fileUri);
                                            const entries = await this.listNestedArchiveEntries(buf, innerExt);
                                            resolve({ kind: 'archive-list', archiveName: path.basename(fileUri), entries });
                                        } catch (err) {
                                            reject(err);
                                        }
                                    } else {
                                        resolve({ kind: 'image', base64: buf.toString('base64'), mimeType });
                                    }
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
            ).on('finish', () => { if (!asyncPending) resolve(null); }).on('error', reject);
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
            if (error instanceof Error &&
                (error.message === 'MISSING_PASSWORD' || error.message === 'BAD_PASSWORD')) {
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

    private showPreviewPanel(title: string, result: PreviewResult, state: DocumentState) {
        if (!state.previewPanel) {
            state.previewPanel = vscode.window.createWebviewPanel(
                'filePreview',
                `Preview: ${title}`,
                vscode.ViewColumn.Beside,
                { enableScripts: false }
            );

            state.previewPanel.onDidDispose(() => {
                state.previewPanel = undefined;
            });
        }

        state.previewPanel.title = `Preview: ${title}`;
        if (result.kind === 'image') {
            state.previewPanel.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;"></head><body style="margin:0;background:#1e1e1e;display:flex;justify-content:center;align-items:center;min-height:100vh;"><img src="data:${result.mimeType};base64,${result.base64}" style="max-width:100%;max-height:100vh;object-fit:contain;"></body></html>`;
        } else if (result.kind === 'markdown') {
            state.previewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;padding:20px 40px;max-width:860px;margin:0 auto;color:var(--vscode-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e)}
img{max-width:100%;height:auto}
pre{background:rgba(128,128,128,.12);padding:12px 16px;border-radius:4px;overflow-x:auto}
code{font-family:"SF Mono",Consolas,"Courier New",monospace;font-size:.9em}
pre code{font-size:.85em;background:none;padding:0}
blockquote{border-left:3px solid #555;margin:0;padding-left:16px;color:#999}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #555;padding:6px 12px}
th{background:rgba(128,128,128,.15)}
hr{border:none;border-top:1px solid #555}
a{color:var(--vscode-textLink-foreground,#4fc1ff)}
h1,h2{border-bottom:1px solid #444;padding-bottom:.3em}
</style></head><body>${result.html}</body></html>`;
        } else if (result.kind === 'archive-list') {
            const rows = result.entries.map(e => {
                const icon = e.isDir ? '📁' : '📄';
                const sizeStr = e.isDir ? '' : this.formatBytes(e.size);
                return `<tr><td style="padding:3px 8px;white-space:nowrap">${icon} ${this.escapeHtml(e.path)}</td><td style="padding:3px 8px;text-align:right;color:#888;white-space:nowrap">${sizeStr}</td></tr>`;
            }).join('');
            state.previewPanel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"></head><body style="margin:0;padding:16px;background:#1e1e1e;color:#ccc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px">
<div style="margin-bottom:12px;font-weight:600;font-size:14px">📦 ${this.escapeHtml(result.archiveName)}</div>
<div style="margin-bottom:8px;color:#888;font-size:12px">${result.entries.filter(e => !e.isDir).length} files, ${result.entries.filter(e => e.isDir).length} folders</div>
<table style="width:100%;border-collapse:collapse;font-size:12px">${rows}</table>
</body></html>`;
        } else {
            state.previewPanel.webview.html = `<html><body style="margin:0;padding:8px;background:#1e1e1e;color:#ccc;font-family:'SF Mono',Consolas,'Courier New',monospace;font-size:13px"><pre style="white-space:pre-wrap;word-break:break-all;margin:0">${this.escapeHtml(result.content)}</pre></body></html>`;
        }
    }

    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    private async listZipEntries(buf: Buffer): Promise<ArchiveListEntry[]> {
        const dir = await getUnzipper().Open.buffer(buf);
        return dir.files.map((f: any) => ({
            path: f.path,
            size: f.uncompressedSize ?? 0,
            isDir: f.type === 'Directory'
        }));
    }

    private async listZipEntriesFromPath(filePath: string): Promise<ArchiveListEntry[]> {
        const dir = await getUnzipper().Open.file(filePath);
        return dir.files.map((f: any) => ({
            path: f.path,
            size: f.uncompressedSize ?? 0,
            isDir: f.type === 'Directory'
        }));
    }

    private async list7zEntries(archivePath: string): Promise<ArchiveListEntry[]> {
        return new Promise((resolve, reject) => {
            const entries: ArchiveListEntry[] = [];
            const sevenZip = getSeven().list(archivePath, { $bin: this.get7zPath() });
            sevenZip.on('data', (data: any) => {
                entries.push({
                    path: data.file ?? '',
                    size: data.size ?? 0,
                    isDir: (data.attributes ?? '').startsWith('D')
                });
            });
            sevenZip.on('end', () => resolve(entries));
            sevenZip.on('error', reject);
        });
    }

    private listTarEntriesFromPath(filePath: string, ext: string): Promise<ArchiveListEntry[]> {
        return new Promise((resolve, reject) => {
            const entries: ArchiveListEntry[] = [];
            const decompressedStream = this.getDecompressionStream(ext, filePath);
            decompressedStream.on('error', reject);
            decompressedStream.pipe(
                getTar().t({
                    onentry: (entry: any) => {
                        entries.push({
                            path: entry.path,
                            size: entry.size ?? 0,
                            isDir: entry.type === 'Directory'
                        });
                        entry.resume();
                    }
                }) as any
            ).on('finish', () => resolve(entries)).on('error', reject);
        });
    }

    private async listNestedArchiveEntries(buf: Buffer, innerExt: string): Promise<ArchiveListEntry[]> {
        if (innerExt === '.zip') {
            return this.listZipEntries(buf);
        }
        const tempFile = path.join(require('os').tmpdir(), `nested-preview-${Date.now()}${innerExt === '.tar.gz' ? '.tar.gz' : innerExt}`);
        fs.writeFileSync(tempFile, buf);
        try {
            if (innerExt === '.7z') return await this.list7zEntries(tempFile);
            if (this.isTarFormat(innerExt)) return await this.listTarEntriesFromPath(tempFile, innerExt);
        } finally {
            try { fs.unlinkSync(tempFile); } catch (_) { /* ignore cleanup errors */ }
        }
        return [];
    }

    private async listNestedArchiveEntriesFromPath(filePath: string, innerExt: string): Promise<ArchiveListEntry[]> {
        if (innerExt === '.zip') return this.listZipEntriesFromPath(filePath);
        if (innerExt === '.7z') return this.list7zEntries(filePath);
        if (this.isTarFormat(innerExt)) return this.listTarEntriesFromPath(filePath, innerExt);
        return [];
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private closePreviewPanel(state: DocumentState) {
        if (state.previewPanel) {
            state.previewPanel.dispose();
            state.previewPanel = undefined;
        }
    }

    private async extractFile(fileUri: string, archiveFilePath: string) {
        const extension = this.getExtension(archiveFilePath);
        if (extension === '.zip') {
            await this.extractZipFile(fileUri, archiveFilePath);
        } else if (extension === '.7z') {
            await this.extract7zFile(fileUri, archiveFilePath);
        } else if (this.isTarFormat(extension)) {
            await this.extractTarFile(fileUri, archiveFilePath);
        }
    }

    private async extractZipFile(fileUri: string, archiveFilePath: string) {
        try {
            const directory = await getUnzipper().Open.file(archiveFilePath);
            const file = directory.files.find((f: any) => f.path === fileUri);
            if (!file) {
                return;
            }

            let password: string | undefined = this.savedPasswords[archiveFilePath];

            if (!(await this.checkPassword(file, password ?? ''))) {
                password = await this.promptForPassword();
                if (!password || !(await this.checkPassword(file, password))) {
                    vscode.window.showErrorMessage('Extraction failed. Password is invalid or not provided.');
                    return;
                }
                this.savedPasswords[archiveFilePath] = password;
            }

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(archiveFilePath), path.basename(file.path ?? 'default.zip'))),
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

    private async extract7zFile(fileUri: string, archiveFilePath: string) {
        try {
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(path.join(path.dirname(archiveFilePath), path.basename(fileUri))),
            });

            if (!saveUri) return;

            const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), '7z-extract-'));
            const sevenZip = getSeven().extractFull(archiveFilePath, tempDir, {
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

    private async extractTarFile(fileUri: string, archiveFilePath: string) {
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(archiveFilePath), path.basename(fileUri))),
        });

        if (!saveUri) return;

        const extension = this.getExtension(archiveFilePath);

        try {
            const decompressedStream = this.getDecompressionStream(extension, archiveFilePath);

            const extractStream = getTar().extract({
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

    private async extractFolder(folderUri: string, archiveFilePath: string) {
        const extension = this.getExtension(archiveFilePath);
        if (extension === '.zip') {
            await this.extractZipFolder(folderUri, archiveFilePath);
        } else if (extension === '.7z') {
            await this.extract7zFolder(folderUri, archiveFilePath);
        } else if (this.isTarFormat(extension)) {
            await this.extractTarFolder(folderUri, archiveFilePath);
        }
    }

    private async extractZipFolder(folderUri: string, archiveFilePath: string) {
        try {
            const directory = await getUnzipper().Open.file(archiveFilePath);
            const folderFiles = directory.files.filter((f: any) => f.path.startsWith(folderUri + '/'));
            let password: string | undefined = this.savedPasswords[archiveFilePath];

            for (const file of folderFiles) {
                if (!(await this.checkPassword(file, password ?? ''))) {
                    password = await this.promptForPassword();
                    if (!password || !(await this.checkPassword(file, password))) {
                        vscode.window.showErrorMessage('Extraction failed. Password is invalid or not provided.');
                        return;
                    }
                    this.savedPasswords[archiveFilePath] = password;
                    break;
                }
            }

            const saveUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(path.dirname(archiveFilePath))
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

    private async extractTarFolder(folderUri: string, archiveFilePath: string) {
        const saveUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(path.dirname(archiveFilePath))
        });

        if (!saveUri || saveUri.length === 0) return;

        const extension = this.getExtension(archiveFilePath);

        try {
            const decompressedStream = this.getDecompressionStream(extension, archiveFilePath);

            const extractStream = getTar().extract({
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

    private async extract7zFolder(folderUri: string, archiveFilePath: string) {
        try {
            const saveUri = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                defaultUri: vscode.Uri.file(path.dirname(archiveFilePath))
            });

            if (!saveUri || saveUri.length === 0) return;

            const sevenZip = getSeven().extractFull(archiveFilePath, saveUri[0].fsPath, {
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

    private async extractSelected(selectedPaths: string[], archiveFilePath: string) {
        if (selectedPaths.length === 0) {
            return;
        }

        const saveUri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(path.dirname(archiveFilePath)),
            title: `Extract ${selectedPaths.length} selected items`
        });

        if (!saveUri || saveUri.length === 0) return;

        const extension = this.getExtension(archiveFilePath);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Extracting ${selectedPaths.length} items...`,
            cancellable: false
        }, async (progress) => {
            try {
                if (extension === '.zip') {
                    await this.extractSelectedZip(selectedPaths, saveUri[0].fsPath, progress, archiveFilePath);
                } else if (extension === '.7z') {
                    await this.extractSelected7z(selectedPaths, saveUri[0].fsPath, progress, archiveFilePath);
                } else if (this.isTarFormat(extension)) {
                    await this.extractSelectedTar(selectedPaths, saveUri[0].fsPath, progress, archiveFilePath);
                }
                vscode.window.showInformationMessage(`${selectedPaths.length} items successfully extracted to ${saveUri[0].fsPath}`);
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Extraction failed: ${error.message}`);
                }
            }
        });
    }

    private async extractSelectedZip(selectedPaths: string[], destinationPath: string, progress: vscode.Progress<{ message?: string; increment?: number }>, archiveFilePath: string) {
        const directory = await getUnzipper().Open.file(archiveFilePath);
        let password: string | undefined = this.savedPasswords[archiveFilePath];

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
                if (!(await this.checkPassword(file, password ?? ''))) {
                    password = await this.promptForPassword();
                    if (!password || !(await this.checkPassword(file, password))) {
                        throw new Error('Invalid password');
                    }
                    this.savedPasswords[archiveFilePath] = password;
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

    private async extractSelectedTar(selectedPaths: string[], destinationPath: string, progress: vscode.Progress<{ message?: string; increment?: number }>, archiveFilePath: string) {
        const extension = this.getExtension(archiveFilePath);
        const decompressedStream = this.getDecompressionStream(extension, archiveFilePath);

        let extractedCount = 0;

        await pipelineAsync(
            decompressedStream,
            getTar().extract({
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

    private async extractSelected7z(selectedPaths: string[], destinationPath: string, progress: vscode.Progress<{ message?: string; increment?: number }>, archiveFilePath: string) {
        for (let i = 0; i < selectedPaths.length; i++) {
            const selectedPath = selectedPaths[i];
            progress.report({
                message: `Extracting... (${i + 1}/${selectedPaths.length})`,
                increment: (100 / selectedPaths.length)
            });

            const sevenZip = getSeven().extractFull(archiveFilePath, destinationPath, {
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

        const compoundExtensions: { [lower: string]: string } = {
            '.tar.gz': '.tar.gz', '.tar.xz': '.tar.xz', '.tar.bz2': '.tar.bz2',
            '.tar.z': '.tar.Z',   '.tar.lz': '.tar.lz',  '.tar.lzma': '.tar.lzma',
            '.tar.zst': '.tar.zst'
        };

        for (const [lower, canonical] of Object.entries(compoundExtensions)) {
            if (lowerPath.endsWith(lower)) {
                return canonical;
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

    private renderTreeHtml(files: ArchiveEntry[], depth = 0, parentPath = ''): string {
        const autoExpand = depth === 0 && files.length === 1 && files[0].isDirectory;
        return files.map(file => {
            const fullPath = parentPath ? `${parentPath}/${file.name}` : file.name;
            const indent = `padding-left: ${depth * 20 + 30}px;`;
            const dateStr = file.date ? file.date.toLocaleString('ja-JP') : '';

            if (file.isDirectory) {
                const expanded = autoExpand;
                return `
                    <div style="padding-left: ${depth * 20}px;" class="folder" data-uri="${this.escapeHtml(fullPath)}">
                        <div class="file-info" oncontextmenu="handleFolderRightClick(event, '${this.escapeHtml(fullPath)}')">
                            <input type="checkbox" class="checkbox" data-path="${this.escapeHtml(fullPath)}" onchange="handleCheckboxChange(event)">
                            <span class="caret${expanded ? ' caret-down' : ''}" onclick="toggleFolder(event)">${this.escapeHtml(file.name)}</span>
                        </div>
                        <div class="nested${expanded ? ' active' : ''}"${expanded ? ' style="display:block"' : ''}>${this.renderTreeHtml(file.children!, depth + 1, fullPath)}</div>
                    </div>`;
            } else {
                return `
                    <div style="${indent}" class="file" data-uri="${this.escapeHtml(fullPath)}" oncontextmenu="handleFileRightClick(event, '${this.escapeHtml(fullPath)}')">
                        <div class="file-info-row" data-uri="${this.escapeHtml(fullPath)}">
                            <input type="checkbox" class="checkbox" data-path="${this.escapeHtml(fullPath)}" data-size="${file.size}" onchange="handleCheckboxChange(event)">
                            <span class="file-name">${this.escapeHtml(file.name)}</span>
                            <span class="file-date">${dateStr}</span>
                            <span class="file-size">${file.size.toLocaleString()} bytes</span>
                        </div>
                    </div>`;
            }
        }).join('');
    }

    private getWebviewContent(files: ArchiveEntry[], webview: vscode.Webview, loading = false): string {
        const nonce = crypto.randomBytes(16).toString('hex');

        return `
            <!DOCTYPE html>
            <html lang="ja">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
                <title>Zip Viewer</title>
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                        font-size: 12px;
                        padding: 0;
                        margin: 0;
                        padding-bottom: 48px;
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
                        flex-wrap: nowrap;
                        overflow-x: auto;
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
                        white-space: nowrap;
                        flex-shrink: 0;
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
                        flex: 1 1 auto;
                        min-width: 80px;
                        cursor: pointer;
                        white-space: nowrap;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        user-select: none;
                    }
                    .file-info-row:not(.selected) .file-name:hover {
                        color: var(--vscode-textLink-foreground);
                    }
                    .file-size {
                        flex: 0 0 auto;
                        text-align: right;
                        color: var(--vscode-descriptionForeground);
                        white-space: nowrap;
                    }
                    .file-date {
                        flex: 0 0 auto;
                        text-align: right;
                        color: var(--vscode-descriptionForeground);
                        white-space: nowrap;
                    }
                    @container (max-width: 500px) {
                        .file-size { display: none; }
                    }
                    @media (max-width: 500px) {
                        .file-size { display: none; }
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
                    .file-info-row.selected {
                        background: var(--vscode-list-activeSelectionBackground);
                        color: var(--vscode-list-activeSelectionForeground);
                        border-radius: 2px;
                    }
                    .file-info-row.selected .file-size,
                    .file-info-row.selected .file-date {
                        color: var(--vscode-list-activeSelectionForeground);
                    }
                    .ad-space {
                        position: fixed;
                        bottom: 0;
                        left: 0;
                        right: 0;
                        padding: 10px 14px;
                        background: var(--vscode-editor-background);
                        border-top: 1px solid var(--vscode-panel-border);
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        opacity: 0.7;
                        z-index: 50;
                    }
                    .ad-label {
                        font-size: 9px;
                        font-weight: bold;
                        letter-spacing: 0.08em;
                        padding: 2px 5px;
                        border: 1px solid currentColor;
                        border-radius: 2px;
                        flex-shrink: 0;
                    }
                    .ad-message {
                        font-size: 11px;
                        font-style: italic;
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
                    ${loading
                        ? '<div style="padding: 20px; color: var(--vscode-descriptionForeground);">Loading...</div>'
                        : this.renderTreeHtml(files)}
                </div>
                <script nonce="${nonce}">
function autoExpandSingleRootFolder() {
    const tree = document.querySelector('.file-tree');
    const rootItems = Array.from(tree.children).filter(el => el.classList.contains('folder') || el.classList.contains('file'));
    console.log('autoExpand: rootItems count =', rootItems.length, rootItems.map(el => el.getAttribute('data-uri')));
    if (rootItems.length === 1 && rootItems[0].classList.contains('folder')) {
        const folder = rootItems[0];
        const nested = folder.querySelector('.nested');
        const caret = folder.querySelector('.caret');
        if (nested) {
            nested.style.display = 'block';
            if (caret) caret.classList.add('caret-down');
        }
    }
}

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'updateTree') {
        document.querySelector('.file-tree').innerHTML = msg.html;
        setTimeout(autoExpandSingleRootFolder, 0);
    }
});
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
                        const isFolderCheckbox = checkbox.parentElement.classList.contains('file-info');

                        if (checkbox.checked) {
                            selectedPaths.add(path);
                            selectedSize += size;

                            if (isFolderCheckbox) {
                                const folder = checkbox.closest('.folder');
                                folder.querySelectorAll('.nested .checkbox').forEach(child => {
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

                            if (isFolderCheckbox) {
                                const folder = checkbox.closest('.folder');
                                folder.querySelectorAll('.nested .checkbox').forEach(child => {
                                    if (child.checked) {
                                        child.checked = false;
                                        selectedPaths.delete(child.dataset.path);
                                        selectedSize -= parseInt(child.dataset.size || '0');
                                    }
                                });
                            }

                            // Uncheck every ancestor folder — they're no longer fully selected
                            let current = checkbox.closest('.folder, .file');
                            while (current) {
                                const ancestor = current.parentElement && current.parentElement.closest('.folder');
                                if (!ancestor) break;
                                const ancestorCheckbox = ancestor.querySelector(':scope > .file-info > .checkbox');
                                if (ancestorCheckbox && ancestorCheckbox.checked) {
                                    ancestorCheckbox.checked = false;
                                    selectedPaths.delete(ancestorCheckbox.dataset.path);
                                }
                                current = ancestor;
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
    let activePreviewUri = null;

    function setActiveRow(fileUri) {
        activePreviewUri = fileUri;
        document.querySelectorAll('.file-info-row').forEach(row => {
            row.classList.toggle('selected', row.getAttribute('data-uri') === fileUri);
        });
        if (fileUri) {
            const sel = document.querySelector('.file-info-row.selected');
            if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
        }
    }

    function isMarkdown(uri) {
        const lower = uri.toLowerCase();
        return lower.endsWith('.md') || lower.endsWith('.markdown');
    }

    document.querySelector('.file-tree').addEventListener('mousedown', (event) => {
        if (event.target.closest('input')) return;
        if (event.button !== 0) return;
        const row = event.target.closest('.file-info-row');
        if (!row) return;
        const fileUri = row.getAttribute('data-uri');
        if (!fileUri || isMarkdown(fileUri)) return;

        setActiveRow(fileUri);
        vscode.postMessage({ command: 'previewFile', fileUri: fileUri });
    });

    document.addEventListener('mouseup', () => {
        if (activePreviewUri && !isMarkdown(activePreviewUri)) {
            setActiveRow(null);
            vscode.postMessage({ command: 'closePreview' });
        }
    });

    document.querySelector('.file-tree').addEventListener('click', (event) => {
        if (event.target.closest('input')) return;
        const row = event.target.closest('.file-info-row');
        if (!row) return;
        const fileUri = row.getAttribute('data-uri');
        if (!fileUri || !isMarkdown(fileUri)) return;

        if (activePreviewUri === fileUri) {
            setActiveRow(null);
            vscode.postMessage({ command: 'closePreview' });
        } else {
            setActiveRow(fileUri);
            vscode.postMessage({ command: 'previewFile', fileUri: fileUri });
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

        const rows = Array.from(document.querySelectorAll('.file-info-row'))
            .filter(r => {
                let el = r.parentElement;
                while (el) {
                    if (el.classList.contains('nested') && !el.classList.contains('active')) return false;
                    el = el.parentElement;
                }
                return true;
            });
        if (rows.length === 0) return;
        event.preventDefault();

        const currentIdx = activePreviewUri
            ? rows.findIndex(r => r.getAttribute('data-uri') === activePreviewUri)
            : -1;

        const nextIdx = event.key === 'ArrowDown'
            ? Math.min(currentIdx + 1, rows.length - 1)
            : Math.max(currentIdx - 1, 0);

        if (nextIdx === currentIdx && currentIdx !== -1) return;

        const nextUri = rows[nextIdx].getAttribute('data-uri');
        if (nextUri) {
            setActiveRow(nextUri);
            vscode.postMessage({ command: 'previewFile', fileUri: nextUri });
        }
    });
});

                </script>
                <div class="ad-space">
                    <span class="ad-label">AD</span>
                    <span class="ad-message">Advertising space available — contact us to reach VS Code users</span>
                </div>
            </body>
            </html>`;
    }
}

export function deactivate() { }
