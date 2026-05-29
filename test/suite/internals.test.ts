/**
 * Tests for internal helper methods that are not exercised by higher-level tests.
 *
 * Covers:
 *  - getTotalSize()
 *  - get7zPath()
 *  - checkPassword()
 *  - readZipFileAsText()
 *  - loadImageFromZip()
 *  - readTextFromTar()
 *  - loadImagesFromTar()
 *  - showPreviewPanel() — image CSP
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';

const TEST_DIR = path.join(__dirname, '../../test');
const OUT_ZIP          = path.join(TEST_DIR, 'out.zip');
const PASS_ZIP         = path.join(TEST_DIR, 'out_pass.zip');
const OUT_TAR_GZ       = path.join(TEST_DIR, 'out.tar.gz');
const IMAGES_ZIP       = path.join(TEST_DIR, 'markdown-with-images.zip');
const IMAGES_TAR_GZ    = path.join(TEST_DIR, 'markdown-with-images.tar.gz');

const CORRECT_PASSWORD = 'pass';

let provider: any;

before(() => {
    const fakeVscode = require('vscode');
    const mod = require('../../src/extension');
    let captured: any;
    const orig = fakeVscode.window.registerCustomEditorProvider;
    fakeVscode.window.registerCustomEditorProvider = (_id: string, p: any) => {
        captured = p;
        return { dispose: () => {} };
    };
    mod.activate({ subscriptions: [] });
    fakeVscode.window.registerCustomEditorProvider = orig;
    provider = new captured.constructor({ subscriptions: [] });
});

// ── getTotalSize ─────────────────────────────────────────────────────────────

describe('getTotalSize', () => {
    const entries = [
        { name: 'a.txt', size: 100, time: 0, isDirectory: false },
        { name: 'b.txt', size: 200, time: 0, isDirectory: false },
        {
            name: 'dir', size: 0, time: 0, isDirectory: true,
            children: [
                { name: 'c.txt', size: 300, time: 0, isDirectory: false },
                { name: 'd.txt', size: 400, time: 0, isDirectory: false },
            ]
        }
    ];

    it('sums sizes for selected flat files', () => {
        assert.strictEqual(provider.getTotalSize(entries, ['a.txt', 'b.txt']), 300);
    });

    it('returns 0 for no selection', () => {
        assert.strictEqual(provider.getTotalSize(entries, []), 0);
    });

    it('returns size of a single file', () => {
        assert.strictEqual(provider.getTotalSize(entries, ['b.txt']), 200);
    });

    it('returns 0 for directory node itself (size lives in children)', () => {
        assert.strictEqual(provider.getTotalSize(entries, ['dir']), 0);
    });

    it('returns 0 when selected path does not exist in tree', () => {
        assert.strictEqual(provider.getTotalSize(entries, ['nonexistent.txt']), 0);
    });

    it('handles empty entries array', () => {
        assert.strictEqual(provider.getTotalSize([], ['a.txt']), 0);
    });
});

// ── get7zPath ────────────────────────────────────────────────────────────────

describe('get7zPath', () => {
    it('returns a non-empty string', () => {
        const p = provider.get7zPath();
        assert.ok(typeof p === 'string' && p.length > 0, 'should return a non-empty path');
    });

    it('returned path points to an existing file', () => {
        const p = provider.get7zPath();
        assert.ok(fs.existsSync(p), `7z binary not found at: ${p}`);
    });

    it('returned file is executable', () => {
        const p = provider.get7zPath();
        assert.doesNotThrow(() => fs.accessSync(p, fs.constants.X_OK), 'binary should be executable');
    });
});

// ── checkPassword ────────────────────────────────────────────────────────────

describe('checkPassword', () => {
    let directory: any;

    before(async () => {
        const unzipper = require('unzipper');
        directory = await unzipper.Open.file(OUT_ZIP);
    });

    it('returns true for empty password on unencrypted file', async () => {
        const file = directory.files.find((f: any) => f.path === 'out/extension.js');
        assert.ok(file, 'test file should exist in archive');
        const result = await provider.checkPassword(file, '');
        assert.strictEqual(result, true);
    });

    it('returns true for any password on unencrypted file', async () => {
        const file = directory.files.find((f: any) => f.path === 'out/extension.js');
        const result = await provider.checkPassword(file, 'anything');
        assert.strictEqual(result, true);
    });
});

describe('checkPassword — encrypted ZIP', () => {
    async function openPassFile(): Promise<any> {
        const unzipper = require('unzipper');
        const dir = await unzipper.Open.file(PASS_ZIP);
        return dir.files.find((f: any) => f.path === 'out/extension.js');
    }

    it('returns false for empty password on encrypted file', async () => {
        const file = await openPassFile();
        assert.ok(file);
        const result = await provider.checkPassword(file, '');
        assert.strictEqual(result, false);
    });

    it('returns false for wrong password', async () => {
        const file = await openPassFile();
        const result = await provider.checkPassword(file, 'wrongpassword');
        assert.strictEqual(result, false);
    });

    it('returns true for correct password', async () => {
        const file = await openPassFile();
        const result = await provider.checkPassword(file, CORRECT_PASSWORD);
        assert.strictEqual(result, true);
    });
});

// ── readZipFileAsText ────────────────────────────────────────────────────────

describe('readZipFileAsText', () => {
    it('reads text content from a mock file stream', async () => {
        const expected = 'hello\nworld\n';
        const mockFile = {
            stream: (_pw: string) => {
                const s = new Readable({ read() {} });
                s.push(Buffer.from(expected));
                s.push(null);
                return s;
            }
        };
        const result = await provider.readZipFileAsText(mockFile, '');
        assert.strictEqual(result, expected);
    });

    it('reads text from a real ZIP entry', async () => {
        const unzipper = require('unzipper');
        const dir = await unzipper.Open.file(OUT_ZIP);
        const file = dir.files.find((f: any) => f.path === 'out/extension.js');
        assert.ok(file);
        const text = await provider.readZipFileAsText(file, '');
        assert.ok(typeof text === 'string' && text.length > 0);
    });

    it('returns empty string for an empty stream', async () => {
        const mockFile = {
            stream: (_pw: string) => {
                const s = new Readable({ read() {} });
                s.push(null);
                return s;
            }
        };
        const result = await provider.readZipFileAsText(mockFile, '');
        assert.strictEqual(result, '');
    });

    it('handles multi-chunk stream correctly', async () => {
        const parts = ['chunk1', 'chunk2', 'chunk3'];
        const mockFile = {
            stream: (_pw: string) => {
                const s = new Readable({ read() {} });
                parts.forEach(p => s.push(Buffer.from(p)));
                s.push(null);
                return s;
            }
        };
        const result = await provider.readZipFileAsText(mockFile, '');
        assert.strictEqual(result, parts.join(''));
    });
});

// ── loadImageFromZip ─────────────────────────────────────────────────────────

describe('loadImageFromZip', () => {
    it('returns null for non-existent image path', async () => {
        const result = await provider.loadImageFromZip('docs/images/nonexistent.png', IMAGES_ZIP, '');
        assert.strictEqual(result, null);
    });

    it('returns base64 and mimeType for existing PNG', async () => {
        const result = await provider.loadImageFromZip('docs/images/logo.png', IMAGES_ZIP, '');
        assert.ok(result !== null, 'should return an image object');
        assert.ok(typeof result.base64 === 'string' && result.base64.length > 0);
        assert.strictEqual(result.mimeType, 'image/png');
    });

    it('base64 decodes to non-empty buffer', async () => {
        const result = await provider.loadImageFromZip('docs/images/icon.png', IMAGES_ZIP, '');
        assert.ok(result !== null);
        const buf = Buffer.from(result.base64, 'base64');
        assert.ok(buf.length > 0);
    });

    it('returns null when archiveFilePath is not set', async () => {
        const result = await provider.loadImageFromZip('docs/images/logo.png', undefined, '');
        assert.strictEqual(result, null);
    });
});

// ── readTextFromTar ──────────────────────────────────────────────────────────

describe('readTextFromTar', () => {
    it('reads text content from a known entry', async () => {
        const text = await provider.readTextFromTar('out/extension.js', OUT_TAR_GZ);
        assert.ok(text !== null, 'should return text');
        assert.ok(typeof text === 'string' && text.length > 0);
    });

    it('returns null for a non-existent entry', async () => {
        const text = await provider.readTextFromTar('no/such/file.txt', OUT_TAR_GZ);
        assert.strictEqual(text, null);
    });

    it('returned content is valid UTF-8 text', async () => {
        const text = await provider.readTextFromTar('out/extension.js', OUT_TAR_GZ);
        assert.ok(text !== null);
        assert.doesNotThrow(() => Buffer.from(text!, 'utf8'));
    });
});

// ── loadImagesFromTar ────────────────────────────────────────────────────────

describe('loadImagesFromTar', () => {
    it('returns empty map for empty input', async () => {
        const result = await provider.loadImagesFromTar([], IMAGES_TAR_GZ);
        assert.strictEqual(result.size, 0);
    });

    it('returns base64 data for an existing image entry', async () => {
        const result = await provider.loadImagesFromTar(['docs/images/logo.png'], IMAGES_TAR_GZ);
        assert.strictEqual(result.size, 1);
        const img = result.get('docs/images/logo.png');
        assert.ok(img, 'should have the image entry');
        assert.ok(typeof img.base64 === 'string' && img.base64.length > 0);
        assert.strictEqual(img.mimeType, 'image/png');
    });

    it('loads multiple images in one pass', async () => {
        const paths = ['docs/images/logo.png', 'docs/images/icon.png'];
        const result = await provider.loadImagesFromTar(paths, IMAGES_TAR_GZ);
        assert.strictEqual(result.size, 2);
        assert.ok(result.has('docs/images/logo.png'));
        assert.ok(result.has('docs/images/icon.png'));
    });

    it('ignores paths that do not exist in the archive', async () => {
        const result = await provider.loadImagesFromTar([
            'docs/images/logo.png',
            'does/not/exist.png'
        ], IMAGES_TAR_GZ);
        assert.strictEqual(result.size, 1);
        assert.ok(result.has('docs/images/logo.png'));
        assert.ok(!result.has('does/not/exist.png'));
    });
});

// ── showPreviewPanel — image CSP ─────────────────────────────────────────────

describe('showPreviewPanel — image preview HTML', () => {
    it('includes Content-Security-Policy allowing data: URIs for images', () => {
        const fakeVscode = require('vscode');
        let capturedHtml = '';
        const origCreate = fakeVscode.window.createWebviewPanel;
        fakeVscode.window.createWebviewPanel = (_vt: string, title: string, _col: any, _opts?: any) => ({
            webview: {
                options: {},
                onDidReceiveMessage: () => ({ dispose: () => {} }),
                get html() { return capturedHtml; },
                set html(v: string) { capturedHtml = v; }
            },
            title,
            onDidDispose: (_cb: () => void) => ({ dispose: () => {} }),
            dispose: () => {},
            reveal: () => {}
        });

        const state: any = {
            archiveFilePath: '/fake/archive.zip',
            archiveEntries: [],
            previewPanel: undefined,
            previewRequestId: 0
        };
        provider.showPreviewPanel('test.png', { kind: 'image', base64: 'abc', mimeType: 'image/png' }, state);

        fakeVscode.window.createWebviewPanel = origCreate;

        assert.ok(capturedHtml.includes('Content-Security-Policy'), 'should include CSP meta tag');
        assert.ok(
            capturedHtml.includes('img-src data:') || capturedHtml.includes("img-src 'self' data:"),
            'CSP should allow data: URIs for img-src'
        );
    });

    it('image src uses data URI with correct mimeType', () => {
        const fakeVscode = require('vscode');
        let capturedHtml = '';
        fakeVscode.window.createWebviewPanel = (_vt: string, title: string, _col: any, _opts?: any) => ({
            webview: {
                get html() { return capturedHtml; },
                set html(v: string) { capturedHtml = v; },
                options: {},
                onDidReceiveMessage: () => ({ dispose: () => {} })
            },
            title,
            onDidDispose: () => ({ dispose: () => {} }),
            dispose: () => {},
            reveal: () => {}
        });

        const state: any = {
            archiveFilePath: '/fake/archive.zip',
            archiveEntries: [],
            previewPanel: undefined,
            previewRequestId: 0
        };
        provider.showPreviewPanel('test.png', { kind: 'image', base64: 'dGVzdA==', mimeType: 'image/png' }, state);

        fakeVscode.window.createWebviewPanel = require('vscode').window.createWebviewPanel;

        assert.ok(capturedHtml.includes('data:image/png;base64,dGVzdA=='), 'img src should be a data URI');
    });
});
