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
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'out.zip'));
        assertValidEntries(entries, 'out.zip');
    });

    it('contains expected files from out.zip', async () => {
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'out.zip'));
        const all = flattenEntries(entries);
        const names = all.map((e: any) => e.name);
        assert.ok(names.includes('extension.js'), 'should contain extension.js');
    });

    it('builds correct directory hierarchy for out.zip', async () => {
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'out.zip'));
        const topNames = entries.map((e: any) => e.name);
        assert.ok(topNames.includes('out'), 'root should contain out/ directory');
    });

    it('loads tmp.zip correctly', async () => {
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'tmp.zip'));
        assertValidEntries(entries, 'tmp.zip');
    });
});

describe('TAR archive loading', () => {
    it('loads out.tar.gz and returns valid entries', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.gz'));
        assertValidEntries(entries, 'out.tar.gz');
    });

    it('loads out.tgz (alias for tar.gz)', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tgz'));
        assertValidEntries(entries, 'out.tgz');
    });

    it('loads out.tar.xz', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.xz'));
        assertValidEntries(entries, 'out.tar.xz');
    });

    it('loads out.tar.bz2', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.bz2'));
        assertValidEntries(entries, 'out.tar.bz2');
    });

    it('loads out.tar.Z (LZW via bundled 7z binary)', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.Z'));
        assertValidEntries(entries, 'out.tar.Z');
    });

    it('loads plain out.tar', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar'));
        assertValidEntries(entries, 'out.tar');
    });

    it('loads out.tar.zst (Zstandard)', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.zst'));
        assertValidEntries(entries, 'out.tar.zst');
    });

    it('tar entries contain expected file from out.tar.gz', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'out.tar.gz'));
        const all = flattenEntries(entries);
        const names = all.map((e: any) => e.name);
        assert.ok(names.includes('extension.js'), 'should contain extension.js');
    });

    it('builds correct directory hierarchy for tar with implicit dirs', async () => {
        // markdown-with-images.tar.gz has no explicit dir entries:
        //   docs/readme.md, docs/images/logo.png, docs/images/icon.png
        // processTarEntry must infer intermediate dirs as isDirectory:true
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'markdown-with-images.tar.gz'));
        const docs = entries.find((e: any) => e.name === 'docs');
        assert.ok(docs, 'docs directory should exist at root');
        assert.strictEqual(docs.isDirectory, true, 'docs should be marked as directory');
        assert.ok(Array.isArray(docs.children) && docs.children.length > 0, 'docs should have children');

        const readme = docs.children.find((e: any) => e.name === 'readme.md');
        assert.ok(readme, 'readme.md should be inside docs');
        assert.strictEqual(readme.isDirectory, false, 'readme.md should not be a directory');

        const images = docs.children.find((e: any) => e.name === 'images');
        assert.ok(images, 'images directory should be inside docs');
        assert.strictEqual(images.isDirectory, true, 'images should be marked as directory');
        assert.ok(Array.isArray(images.children) && images.children.length > 0, 'images should have children');

        const childNames = images.children.map((e: any) => e.name);
        assert.ok(childNames.includes('logo.png'), 'logo.png should be inside images');
        assert.ok(childNames.includes('icon.png'), 'icon.png should be inside images');
    });
});

describe('7Z archive loading', () => {
    it('loads out.7z and returns valid entries', async () => {
        const entries = await provider.load7zEntries(path.join(TEST_DIR, 'out.7z'));
        assertValidEntries(entries, 'out.7z');
    });

    it('contains expected files from out.7z', async () => {
        const entries = await provider.load7zEntries(path.join(TEST_DIR, 'out.7z'));
        const all = flattenEntries(entries);
        const names = all.map((e: any) => e.name);
        assert.ok(names.length > 0, 'should have entries');
    });

    it('builds correct directory hierarchy for out.7z', async () => {
        // out.7z structure:
        //   out/test/              ← explicit directory entry (D.... attr)
        //   out/extension.js       ← files directly under out/
        //   out/test/extension.test.js  ← files nested under out/test/
        // Regression: data.attr was used instead of data.attributes, causing
        // isDirectory to always be false and all entries to appear flat.
        const entries = await provider.load7zEntries(path.join(TEST_DIR, 'out.7z'));

        const out = entries.find((e: any) => e.name === 'out');
        assert.ok(out, 'out/ should exist at root');
        assert.strictEqual(out.isDirectory, true, 'out/ should be a directory');
        assert.ok(Array.isArray(out.children) && out.children.length > 0, 'out/ should have children');

        const test = out.children.find((e: any) => e.name === 'test');
        assert.ok(test, 'test/ should be inside out/');
        assert.strictEqual(test.isDirectory, true, 'test/ should be marked as a directory');
        assert.ok(Array.isArray(test.children) && test.children.length > 0, 'test/ should have children');

        const testNames = test.children.map((e: any) => e.name);
        assert.ok(testNames.includes('extension.test.js'), 'extension.test.js should be inside out/test/');

        const extensionJs = out.children.find((e: any) => e.name === 'extension.js');
        assert.ok(extensionJs, 'extension.js should be a direct child of out/, not nested under test/');
        assert.strictEqual(extensionJs.isDirectory, false, 'extension.js should not be a directory');
    });
});

describe('ZIP preview', () => {
    it('previews a text file from out.zip', async () => {
        const result = await provider.previewZipFile('out/extension.js', path.join(TEST_DIR, 'out.zip'));
        assert.ok(result !== null, 'should return a result');
        assert.strictEqual(result.kind, 'text', 'should be text kind');
        assert.ok(typeof result.content === 'string', 'content should be string');
        assert.ok(result.content.length > 0, 'content should be non-empty');
    });

    it('returns null for non-existent file in zip', async () => {
        const result = await provider.previewZipFile('nonexistent/file.txt', path.join(TEST_DIR, 'out.zip'));
        assert.strictEqual(result, null);
    });
});

describe('TAR preview', () => {
    it('previews a text file from out.tar.gz', async () => {
        const result = await provider.previewTarFile('out/extension.js', path.join(TEST_DIR, 'out.tar.gz'));
        assert.ok(result !== null, 'should return a result');
        assert.strictEqual(result.kind, 'text');
        assert.ok(result.content.length > 0);
    });

    it('returns null for non-existent file in tar', async () => {
        const result = await provider.previewTarFile('no/such/file.txt', path.join(TEST_DIR, 'out.tar.gz'));
        assert.strictEqual(result, null);
    });
});

// ── Nested archive preview (archive-list) ────────────────────────────────────
// Regression: previewTarFile resolved(null) because the stream finish event
// fired before the async listNestedArchiveEntries() completed.

describe('Nested archive preview — zip inside zip', () => {
    it('returns archive-list kind for out.zip inside tmp.zip', async () => {
        const result = await provider.previewZipFile('tmp/out.zip', path.join(TEST_DIR, 'tmp.zip'));
        assert.ok(result !== null, 'should not return null for nested zip');
        assert.strictEqual(result.kind, 'archive-list', 'should be archive-list kind');
        assert.strictEqual(result.archiveName, 'out.zip');
        assert.ok(Array.isArray(result.entries), 'entries should be an array');
        assert.ok(result.entries.length > 0, 'entries should not be empty');
    });

    it('entries have path, size, isDir fields', async () => {
        const result = await provider.previewZipFile('tmp/out.zip', path.join(TEST_DIR, 'tmp.zip'));
        assert.ok(result !== null);
        for (const e of result.entries) {
            assert.ok(typeof e.path === 'string' && e.path.length > 0, 'entry.path should be non-empty string');
            assert.ok(typeof e.size === 'number', 'entry.size should be number');
            assert.ok(typeof e.isDir === 'boolean', 'entry.isDir should be boolean');
        }
    });
});

describe('Nested archive preview — zip inside tgz (regression: asyncPending race)', () => {
    it('returns archive-list kind for out.zip inside tmp.tgz', async () => {
        // Before the fix, finish fired before await listNestedArchiveEntries()
        // completed, causing the promise to resolve(null) instead of archive-list.
        const result = await provider.previewTarFile('tmp/out.zip', path.join(TEST_DIR, 'tmp.tgz'));
        assert.ok(result !== null, 'should not return null — regression: asyncPending race was not fixed');
        assert.strictEqual(result.kind, 'archive-list', 'should be archive-list kind');
        assert.strictEqual(result.archiveName, 'out.zip');
        assert.ok(Array.isArray(result.entries) && result.entries.length > 0, 'entries should be non-empty');
    });

    it('entries have expected fields', async () => {
        const result = await provider.previewTarFile('tmp/out.zip', path.join(TEST_DIR, 'tmp.tgz'));
        assert.ok(result !== null);
        for (const e of result.entries) {
            assert.ok(typeof e.path === 'string' && e.path.length > 0);
            assert.ok(typeof e.size === 'number');
            assert.ok(typeof e.isDir === 'boolean');
        }
    });
});

describe('Nested archive preview — zip inside 7z', () => {
    it('returns archive-list kind for out.zip inside tmp.7z', async () => {
        const result = await provider.preview7zFile('out.zip', path.join(TEST_DIR, 'tmp.7z'));
        assert.ok(result !== null, 'should not return null for nested zip in 7z');
        assert.strictEqual(result.kind, 'archive-list', 'should be archive-list kind');
        assert.strictEqual(result.archiveName, 'out.zip');
        assert.ok(Array.isArray(result.entries) && result.entries.length > 0, 'entries should be non-empty');
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
