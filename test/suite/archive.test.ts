import * as assert from 'assert';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../test');

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

function assertValidEntries(entries: any[], label: string) {
    assert.ok(Array.isArray(entries), `${label}: should return array`);
    assert.ok(entries.length > 0, `${label}: should have at least one entry`);
    for (const e of entries) {
        assert.ok(typeof e.name === 'string' && e.name.length > 0, `${label}: entry.name should be non-empty string`);
        assert.ok(typeof e.size === 'number', `${label}: entry.size should be number`);
        assert.ok(typeof e.isDirectory === 'boolean', `${label}: entry.isDirectory should be boolean`);
        if (e.isDirectory) {
            assert.ok(Array.isArray(e.children), `${label}: directory should have children array`);
        }
    }
}

function flattenEntries(entries: any[]): any[] {
    const result: any[] = [];
    for (const e of entries) {
        result.push(e);
        if (e.children) result.push(...flattenEntries(e.children));
    }
    return result;
}

describe('ZIP archive loading', () => {
    it('loads out.zip and returns valid entries', async () => {
        await provider.loadZipEntries(path.join(TEST_DIR, 'out.zip'));
        assertValidEntries(provider.archiveEntries, 'out.zip');
    });

    it('contains expected files from out.zip', async () => {
        await provider.loadZipEntries(path.join(TEST_DIR, 'out.zip'));
        const all = flattenEntries(provider.archiveEntries);
        const names = all.map((e: any) => e.name);
        assert.ok(names.includes('extension.js'), 'should contain extension.js');
    });

    it('builds correct directory hierarchy for out.zip', async () => {
        await provider.loadZipEntries(path.join(TEST_DIR, 'out.zip'));
        const topNames = provider.archiveEntries.map((e: any) => e.name);
        assert.ok(topNames.includes('out'), 'root should contain out/ directory');
    });

    it('loads tmp.zip correctly', async () => {
        await provider.loadZipEntries(path.join(TEST_DIR, 'tmp.zip'));
        assertValidEntries(provider.archiveEntries, 'tmp.zip');
    });
});

describe('TAR archive loading', () => {
    it('loads out.tar.gz and returns valid entries', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.gz'));
        assertValidEntries(provider.archiveEntries, 'out.tar.gz');
    });

    it('loads out.tgz (alias for tar.gz)', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tgz'));
        assertValidEntries(provider.archiveEntries, 'out.tgz');
    });

    it('loads out.tar.xz', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.xz'));
        assertValidEntries(provider.archiveEntries, 'out.tar.xz');
    });

    it('loads out.tar.bz2', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.bz2'));
        assertValidEntries(provider.archiveEntries, 'out.tar.bz2');
    });

    it('loads out.tar.Z (LZW via bundled 7z binary)', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.Z'));
        assertValidEntries(provider.archiveEntries, 'out.tar.Z');
    });

    it('loads plain out.tar', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar'));
        assertValidEntries(provider.archiveEntries, 'out.tar');
    });

    it('loads out.tar.zst (Zstandard)', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.zst'));
        assertValidEntries(provider.archiveEntries, 'out.tar.zst');
    });

    it('tar entries contain expected file from out.tar.gz', async () => {
        await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.gz'));
        const all = flattenEntries(provider.archiveEntries);
        const names = all.map((e: any) => e.name);
        assert.ok(names.includes('extension.js'), 'should contain extension.js');
    });
});

describe('7Z archive loading', () => {
    it('loads out.7z and returns valid entries', async () => {
        await provider.load7zEntries(path.join(TEST_DIR, 'out.7z'));
        assertValidEntries(provider.archiveEntries, 'out.7z');
    });

    it('contains expected files from out.7z', async () => {
        await provider.load7zEntries(path.join(TEST_DIR, 'out.7z'));
        const all = flattenEntries(provider.archiveEntries);
        const names = all.map((e: any) => e.name);
        assert.ok(names.length > 0, 'should have entries');
    });
});

describe('ZIP preview', () => {
    it('previews a text file from out.zip', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'out.zip');
        const result = await provider.previewZipFile('out/extension.js');
        assert.ok(result !== null, 'should return a result');
        assert.strictEqual(result.kind, 'text', 'should be text kind');
        assert.ok(typeof result.content === 'string', 'content should be string');
        assert.ok(result.content.length > 0, 'content should be non-empty');
    });

    it('returns null for non-existent file in zip', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'out.zip');
        const result = await provider.previewZipFile('nonexistent/file.txt');
        assert.strictEqual(result, null);
    });
});

describe('TAR preview', () => {
    it('previews a text file from out.tar.gz', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'out.tar.gz');
        const result = await provider.previewTarFile('out/extension.js');
        assert.ok(result !== null, 'should return a result');
        assert.strictEqual(result.kind, 'text');
        assert.ok(result.content.length > 0);
    });

    it('returns null for non-existent file in tar', async () => {
        provider.archiveFilePath = path.join(TEST_DIR, 'out.tar.gz');
        const result = await provider.previewTarFile('no/such/file.txt');
        assert.strictEqual(result, null);
    });
});

describe('Image preview detection in ZIP', () => {
    it('loadFilePreview returns image kind for .png files', async () => {
        // Create a minimal PNG buffer (1x1 white pixel)
        const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
            0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, // IDAT chunk
            0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
            0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
            0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, // IEND chunk
            0x44, 0xae, 0x42, 0x60, 0x82
        ]);

        // Create a mock file-like object that streams the PNG
        const { Readable } = require('stream');
        const mockFile = {
            stream: () => {
                const s = new Readable({ read() {} });
                s.push(pngBytes);
                s.push(null);
                return s;
            }
        };

        const result = await provider.loadFilePreview(mockFile, 'image.png', undefined);
        assert.strictEqual(result.kind, 'image');
        assert.strictEqual(result.mimeType, 'image/png');
        assert.ok(typeof result.base64 === 'string');
        assert.ok(result.base64.length > 0);
        // Verify round-trip
        const decoded = Buffer.from(result.base64, 'base64');
        assert.deepStrictEqual(decoded, pngBytes);
    });

    it('loadFilePreview returns text kind for .txt files', async () => {
        const { Readable } = require('stream');
        const mockFile = {
            stream: () => {
                const s = new Readable({ read() {} });
                s.push(Buffer.from('line1\nline2\nline3\n'));
                s.push(null);
                return s;
            }
        };
        const result = await provider.loadFilePreview(mockFile, 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
        assert.ok(result.content.includes('line1'));
    });
});
