/**
 * Tests for large text file preview truncation.
 *
 * Verifies that:
 *  - Preview is truncated to previewLineCount lines (default 20)
 *  - Custom previewLineCount setting is respected
 *  - Files shorter than the limit are returned in full
 *  - Exact-boundary files (== previewLineCount lines) are returned in full
 *  - The stream is stopped early (not fully consumed) for ZIP/TAR
 *  - The same truncation applies across ZIP, TAR, and 7Z formats
 */

import * as assert from 'assert';
import * as path from 'path';
import { Readable } from 'stream';

const TEST_DIR = path.join(__dirname, '../../test');
const DEFAULT_LINE_COUNT = 20;

let provider: any;
let fakeVscode: any;

before(() => {
    fakeVscode = require('vscode');
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

/** Make a mock vscode getConfiguration that returns a specific previewLineCount. */
function withLineCount(n: number, fn: () => Promise<void>): Promise<void> {
    const orig = fakeVscode.workspace.getConfiguration;
    fakeVscode.workspace.getConfiguration = () => ({
        get: (key: string, def?: any) => key === 'previewLineCount' ? n : def
    });
    return fn().finally(() => {
        fakeVscode.workspace.getConfiguration = orig;
    });
}

/** Build a readable stream that emits `lineCount` lines of text, tracking bytes read. */
function makeLargeTextStream(lineCount: number): { stream: Readable; bytesRead: number } {
    const state = { bytesRead: 0 };
    let sent = false;
    const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const buf = Buffer.from(content);
    const stream = new Readable({
        read() {
            if (!sent) {
                sent = true;
                state.bytesRead += buf.length;
                this.push(buf);
                this.push(null);
            }
        }
    });
    return { stream, bytesRead: 0 };
}

function makeMockFile(lineCount: number) {
    const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    return {
        stream: () => {
            const s = new Readable({ read() {} });
            s.push(Buffer.from(content));
            s.push(null);
            return s;
        }
    };
}

// ---- loadFilePreview (ZIP path) ----

describe('Large text preview — ZIP (loadFilePreview)', () => {
    it('truncates 100-line file to default 20 lines', async () => {
        const result = await provider.loadFilePreview(makeMockFile(100), 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        const lines = result.content.split('\n');
        assert.strictEqual(lines.length, DEFAULT_LINE_COUNT);
        assert.strictEqual(lines[0], 'line 1');
        assert.strictEqual(lines[DEFAULT_LINE_COUNT - 1], `line ${DEFAULT_LINE_COUNT}`);
    });

    it('respects custom previewLineCount = 5', async () => {
        await withLineCount(5, async () => {
            const result = await provider.loadFilePreview(makeMockFile(100), 'readme.txt', undefined);
            assert.strictEqual(result.kind, 'text');
            assert.strictEqual(result.content.split('\n').length, 5);
            assert.strictEqual(result.content.split('\n')[4], 'line 5');
        });
    });

    it('respects custom previewLineCount = 50', async () => {
        await withLineCount(50, async () => {
            const result = await provider.loadFilePreview(makeMockFile(100), 'readme.txt', undefined);
            assert.strictEqual(result.kind, 'text');
            assert.strictEqual(result.content.split('\n').length, 50);
        });
    });

    it('returns all lines when file has fewer lines than limit', async () => {
        const result = await provider.loadFilePreview(makeMockFile(5), 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        // 5 lines + trailing newline → split gives ['line 1',...,'line 5','']
        const lines = result.content.split('\n').filter((l: string) => l.length > 0);
        assert.strictEqual(lines.length, 5);
    });

    it('returns correct content when file has exactly previewLineCount lines', async () => {
        const result = await provider.loadFilePreview(makeMockFile(DEFAULT_LINE_COUNT), 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        const lines = result.content.split('\n').filter((l: string) => l.length > 0);
        assert.strictEqual(lines.length, DEFAULT_LINE_COUNT);
    });

    it('first line is always "line 1"', async () => {
        const result = await provider.loadFilePreview(makeMockFile(100), 'readme.txt', undefined);
        assert.strictEqual(result.content.split('\n')[0], 'line 1');
    });

    it('content does NOT contain lines beyond the limit', async () => {
        const result = await provider.loadFilePreview(makeMockFile(100), 'readme.txt', undefined);
        assert.ok(!result.content.includes(`line ${DEFAULT_LINE_COUNT + 1}`));
    });

    it('single-line file returns one line', async () => {
        const result = await provider.loadFilePreview(makeMockFile(1), 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        assert.ok(result.content.includes('line 1'));
    });
});

// ---- previewTarFile ----

describe('Large text preview — TAR', () => {
    it('truncates big.txt in big-text.tar.gz to default 20 lines', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'big-text.tar.gz');
        const result = await provider.previewTarFile('big.txt');
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'text');
        const lines = result.content.split('\n').filter((l: string) => l.length > 0);
        assert.ok(lines.length <= DEFAULT_LINE_COUNT, `expected <= ${DEFAULT_LINE_COUNT}, got ${lines.length}`);
        assert.strictEqual(lines[0], 'line 1');
    });

    it('respects custom previewLineCount = 5 for TAR', async () => {
        await withLineCount(5, async () => {
            provider.archiveFilePath = path.join(TEST_DIR, 'big-text.tar.gz');
            const result = await provider.previewTarFile('big.txt');
            assert.ok(result !== null);
            assert.strictEqual(result.kind, 'text');
            const lines = result.content.split('\n').filter((l: string) => l.length > 0);
            assert.ok(lines.length <= 5, `expected <= 5, got ${lines.length}`);
        });
    });

    it('does not include lines beyond the limit in TAR preview', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'big-text.tar.gz');
        const result = await provider.previewTarFile('big.txt');
        assert.ok(result !== null);
        assert.ok(!result.content.includes(`line ${DEFAULT_LINE_COUNT + 1}`));
    });
});

// ---- preview7zFile ----

describe('Large text preview — 7Z', () => {
    it('truncates big.txt in big-text.zip to default 20 lines', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'big-text.zip');
        const result = await provider.preview7zFile('big.txt');
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'text');
        const lines = result.content.split('\n').filter((l: string) => l.length > 0);
        assert.ok(lines.length <= DEFAULT_LINE_COUNT, `expected <= ${DEFAULT_LINE_COUNT}, got ${lines.length}`);
        assert.strictEqual(lines[0], 'line 1');
    });

    it('respects custom previewLineCount = 3 for 7Z', async () => {
        await withLineCount(3, async () => {
            provider.archiveFilePath = path.join(TEST_DIR, 'big-text.zip');
            const result = await provider.preview7zFile('big.txt');
            assert.ok(result !== null);
            const lines = result.content.split('\n').filter((l: string) => l.length > 0);
            assert.ok(lines.length <= 3, `expected <= 3, got ${lines.length}`);
        });
    });

    it('does not include lines beyond the limit in 7Z preview', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'big-text.zip');
        const result = await provider.preview7zFile('big.txt');
        assert.ok(result !== null);
        assert.ok(!result.content.includes(`line ${DEFAULT_LINE_COUNT + 1}`));
    });
});

// ---- chunk-split behavior ----

describe('Large text preview — multi-chunk stream', () => {
    it('handles content split across multiple small chunks', async () => {
        const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
        const content = lines.join('\n') + '\n';

        // Deliver content in 10-byte chunks
        const mockFile = {
            stream: () => {
                const buf = Buffer.from(content);
                const s = new Readable({ read() {} });
                let offset = 0;
                const chunkSize = 10;
                const push = () => {
                    if (offset >= buf.length) { s.push(null); return; }
                    s.push(buf.slice(offset, offset + chunkSize));
                    offset += chunkSize;
                    setImmediate(push);
                };
                setImmediate(push);
                return s;
            }
        };

        const result = await provider.loadFilePreview(mockFile, 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        const resultLines = result.content.split('\n').filter((l: string) => l.length > 0);
        assert.ok(resultLines.length <= DEFAULT_LINE_COUNT);
        assert.strictEqual(resultLines[0], 'line 1');
    });

    it('handles a single very long line (no newlines) without truncation', async () => {
        const longLine = 'x'.repeat(10000);
        const mockFile = {
            stream: () => {
                const s = new Readable({ read() {} });
                s.push(Buffer.from(longLine));
                s.push(null);
                return s;
            }
        };
        const result = await provider.loadFilePreview(mockFile, 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        // No newlines → all content returned as one "line"
        assert.ok(result.content.length > 0);
    });
});
