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
import MarkdownIt = require('markdown-it');
const sevenBin = require('7zip-bin');

const pipelineAsync = promisify(pipeline);

type PreviewResult =
    | { kind: 'text'; content: string }
    | { kind: 'image'; base64: string; mimeType: string }
    | { kind: 'markdown'; html: string };

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

    /** 直近のプレビューリクエストID — 連続リクエスト時に古い結果を破棄するため */
    private previewRequestId: number = 0;

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
                    const requestId = ++this.previewRequestId;

                    const result = await this.previewFile(fileUri);

                    // より新しいリクエストが来ていた場合は破棄
                    if (requestId !== this.previewRequestId) {
                        return;
                    }

                    if (result) {
                        this.showPreviewPanel(fileUri, result);
                    }
                } else if (message.command === 'closePreview') {
                    this.previewRequestId++; // 読み込み中のプレビューをキャンセル
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

        const md = new MarkdownIt({ html: false, linkify: true });
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

    private async loadImageFromZip(imagePath: string, password?: string): Promise<{ base64: string; mimeType: string } | null> {
        try {
            const directory = await unzipper.Open.file(this.archiveFilePath!);
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

    private async readTextFromTar(fileUri: string): Promise<string | null> {
        return new Promise<string | null>((resolve, reject) => {
            const extension = this.getExtension(this.archiveFilePath!);
            const decompressedStream = this.getDecompressionStream(extension, this.archiveFilePath!);
            decompressedStream.pipe(
                tar.t({
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

    private async loadImagesFromTar(imagePaths: string[]): Promise<Map<string, { base64: string; mimeType: string }>> {
        const result = new Map<string, { base64: string; mimeType: string }>();
        if (imagePaths.length === 0) return result;
        const remaining = new Set(imagePaths);
        await new Promise<void>((resolve, reject) => {
            const extension = this.getExtension(this.archiveFilePath!);
            const decompressedStream = this.getDecompressionStream(extension, this.archiveFilePath!);
            decompressedStream.pipe(
                tar.t({
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

            const produceResult = async (pw: string | undefined): Promise<PreviewResult> => {
                if (this.isMarkdownFile(fileUri)) {
                    const content = await this.readZipFileAsText(file, pw);
                    const html = await this.renderMarkdownWithImages(content, fileUri,
                        imgPath => this.loadImageFromZip(imgPath, pw));
                    return { kind: 'markdown', html };
                }
                return this.loadFilePreview(file, fileUri, pw);
            };

            let password: string | undefined = this.savedPasswords[this.archiveFilePath!];
            if (await this.checkPassword(file, password ?? '')) {
                return await produceResult(password);
            }

            while (true) {
                password = await this.promptForPassword();
                if (!password) {
                    return null;
                }

                if (await this.checkPassword(file, password)) {
                    this.savedPasswords[this.archiveFilePath!] = password;
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

    private async preview7zFile(fileUri: string): Promise<PreviewResult | null> {
        try {
            const config = vscode.workspace.getConfiguration('zipViewer');
            const previewLineCount = config.get<number>('previewLineCount') ?? 20;

            let password: string | undefined = this.savedPasswords[this.archiveFilePath!];

            while (true) {
                const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), '7z-preview-'));
                let extractFailed = false;

                try {
                    // Always pass -p<password> — even empty — to prevent 7z from
                    // waiting for interactive stdin input on encrypted archives.
                    const sevenZip = Seven.extractFull(this.archiveFilePath!, tempDir, {
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
                    if (password) this.savedPasswords[this.archiveFilePath!] = password;

                    let result: PreviewResult;
                    if (this.isImageFile(fileUri)) {
                        const buf = fs.readFileSync(extractedFilePath);
                        result = { kind: 'image', base64: buf.toString('base64'), mimeType: this.getMimeType(fileUri) };
                    } else if (this.isMarkdownFile(fileUri)) {
                        const mdContent = fs.readFileSync(extractedFilePath, 'utf8');
                        const imageRefs = this.extractImageRefs(mdContent, fileUri);
                        if (imageRefs.length > 0) {
                            await new Promise<void>(res => {
                                const sz = Seven.extractFull(this.archiveFilePath!, tempDir, {
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
                    // Extraction succeeded but file was not found in the archive
                    return null;
                }

                // Extraction failed — treat as a password error
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

    private async previewTarFile(fileUri: string): Promise<PreviewResult | null> {
        if (!this.archiveFilePath) {
            vscode.window.showErrorMessage('File path is not available.');
            return null;
        }

        if (this.isMarkdownFile(fileUri)) {
            const content = await this.readTextFromTar(fileUri);
            if (content === null) return null;
            const imagePaths = this.extractImageRefs(content, fileUri);
            const imageMap = await this.loadImagesFromTar(imagePaths);
            const html = await this.renderMarkdownWithImages(content, fileUri,
                async archivePath => imageMap.get(archivePath) ?? null);
            return { kind: 'markdown', html };
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
            ).on('finish', () => resolve(null)).on('error', reject);
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
        } else if (result.kind === 'markdown') {
            this.previewPanel.webview.html = `<!DOCTYPE html>
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

        // Map lowercase suffix → canonical extension (preserving uppercase Z in .tar.Z)
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
                        margin-top: 24px;
                        padding: 10px 14px;
                        border: 1px dashed var(--vscode-panel-border);
                        border-radius: 4px;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        opacity: 0.5;
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

    // Click on a file row to toggle preview
    document.querySelector('.file-tree').addEventListener('click', (event) => {
        if (event.target.closest('input')) return; // ignore checkbox clicks
        const row = event.target.closest('.file-info-row');
        if (!row) return;
        const fileUri = row.getAttribute('data-uri');
        if (!fileUri) return;

        if (activePreviewUri === fileUri) {
            setActiveRow(null);
            vscode.postMessage({ command: 'closePreview' });
        } else {
            setActiveRow(fileUri);
            vscode.postMessage({ command: 'previewFile', fileUri: fileUri });
        }
    });

    // Click outside file rows to close preview
    document.addEventListener('click', (event) => {
        if (!event.target.closest('.file-info-row') && activePreviewUri) {
            setActiveRow(null);
            vscode.postMessage({ command: 'closePreview' });
        }
    });

    // Arrow key navigation through visible file rows
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