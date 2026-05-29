/**
 * Tests for Markdown preview with embedded archive images.
 *
 * Verifies that:
 *  - .md files return kind:'markdown' with rendered HTML
 *  - Basic Markdown elements (headings, bold, lists) appear in the HTML
 *  - Images referenced inside the archive are inlined as data: URIs
 *  - Non-existent image references don't break rendering (kept as-is)
 *  - Behaviour is consistent across ZIP and TAR formats
 *  - resolveArchivePath and renderMarkdownWithImages work end-to-end
 */

import * as assert from 'assert';
import * as path from 'path';
import { Readable } from 'stream';

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

// ---- renderMarkdownWithImages (unit) ----

describe('renderMarkdownWithImages', () => {
    it('renders heading to <h1>', async () => {
        const html = await provider.renderMarkdownWithImages('# Hello', 'readme.md', async () => null);
        assert.ok(html.includes('<h1>'), `expected <h1> in: ${html}`);
        assert.ok(html.includes('Hello'));
    });

    it('renders bold text to <strong>', async () => {
        const html = await provider.renderMarkdownWithImages('**bold**', 'readme.md', async () => null);
        assert.ok(html.includes('<strong>'));
    });

    it('renders unordered list', async () => {
        const html = await provider.renderMarkdownWithImages('- a\n- b', 'readme.md', async () => null);
        assert.ok(html.includes('<ul>') || html.includes('<li>'));
    });

    it('replaces local image src with data URI', async () => {
        const fakeImg = { base64: 'AAAA', mimeType: 'image/png' };
        const html = await provider.renderMarkdownWithImages(
            '![logo](logo.png)',
            'readme.md',
            async () => fakeImg
        );
        assert.ok(html.includes('data:image/png;base64,AAAA'), `expected data URI in: ${html}`);
    });

    it('keeps http image src unchanged', async () => {
        const html = await provider.renderMarkdownWithImages(
            '![logo](https://example.com/img.png)',
            'readme.md',
            async () => null
        );
        assert.ok(html.includes('https://example.com/img.png'));
        assert.ok(!html.includes('data:'));
    });

    it('keeps src when image is not found in archive', async () => {
        const html = await provider.renderMarkdownWithImages(
            '![missing](missing.png)',
            'readme.md',
            async () => null
        );
        assert.ok(html.includes('missing.png'));
    });

    it('deduplicates image loading calls (same src used twice)', async () => {
        let callCount = 0;
        await provider.renderMarkdownWithImages(
            '![a](img.png)\n![b](img.png)',
            'readme.md',
            async () => { callCount++; return { base64: 'X', mimeType: 'image/png' }; }
        );
        assert.strictEqual(callCount, 1, 'loadImage should be called once per unique path');
    });

    it('resolves relative image path before calling loadImage', async () => {
        const receivedPaths: string[] = [];
        await provider.renderMarkdownWithImages(
            '![a](images/logo.png)',
            'docs/readme.md',
            async (archivePath: string) => { receivedPaths.push(archivePath); return null; }
        );
        assert.deepStrictEqual(receivedPaths, ['docs/images/logo.png']);
    });
});

// ---- loadFilePreview: markdown files bypass this method in real flow ----
// loadFilePreview is the low-level ZIP stream reader; markdown is handled at
// the previewZipFile level. These tests confirm loadFilePreview returns text
// for .md (raw content), while the ZIP/TAR integration tests verify kind:'markdown'.

describe('loadFilePreview — raw stream (markdown bypass)', () => {
    function makeMockFile(content: string) {
        return {
            stream: () => {
                const s = new Readable({ read() {} });
                s.push(Buffer.from(content));
                s.push(null);
                return s;
            }
        };
    }

    it('loadFilePreview with .md returns kind:text (raw, no archive context)', async () => {
        const result = await provider.loadFilePreview(makeMockFile('# Hi'), 'readme.md', undefined);
        // loadFilePreview has no archive reference to resolve images, so it returns raw text
        assert.strictEqual(result.kind, 'text');
    });

    it('.txt file returns kind:text', async () => {
        const result = await provider.loadFilePreview(makeMockFile('hello'), 'readme.txt', undefined);
        assert.strictEqual(result.kind, 'text');
    });

    it('.png file returns kind:image regardless of content', async () => {
        const result = await provider.loadFilePreview(makeMockFile('binarydata'), 'photo.png', undefined);
        assert.strictEqual(result.kind, 'image');
    });
});

// ---- ZIP integration ----

describe('Markdown preview — ZIP', () => {
    it('previewZipFile returns kind:markdown for readme.md', async () => {
        const result = await provider.previewZipFile('readme.md', path.join(TEST_DIR, 'markdown-simple.zip'));
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'markdown');
    });

    it('HTML contains rendered heading from readme.md', async () => {
        const result = await provider.previewZipFile('readme.md', path.join(TEST_DIR, 'markdown-simple.zip'));
        assert.ok(result.html.includes('<h1>'));
        assert.ok(result.html.includes('Hello World'));
    });

    it('HTML contains rendered bold text', async () => {
        const result = await provider.previewZipFile('readme.md', path.join(TEST_DIR, 'markdown-simple.zip'));
        assert.ok(result.html.includes('<strong>'));
    });

    it('image references in ZIP are inlined as data URIs', async () => {
        const result = await provider.previewZipFile('docs/readme.md', path.join(TEST_DIR, 'markdown-with-images.zip'));
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'markdown');
        assert.ok(result.html.includes('data:image/png;base64,'), `expected data URI in: ${result.html}`);
    });

    it('both images in markdown-with-images.zip are inlined', async () => {
        const result = await provider.previewZipFile('docs/readme.md', path.join(TEST_DIR, 'markdown-with-images.zip'));
        const matches = (result.html.match(/data:image\/png;base64,/g) || []).length;
        assert.strictEqual(matches, 2, `expected 2 data URIs, got ${matches}`);
    });

    it('returns null for non-existent markdown file', async () => {
        const result = await provider.previewZipFile('no/such.md', path.join(TEST_DIR, 'markdown-simple.zip'));
        assert.strictEqual(result, null);
    });
});

// ---- TAR integration ----

describe('Markdown preview — TAR', () => {
    it('previewTarFile returns kind:markdown for readme.md', async () => {
        const result = await provider.previewTarFile('readme.md', path.join(TEST_DIR, 'markdown-simple.tar.gz'));
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'markdown');
    });

    it('HTML from TAR contains rendered heading', async () => {
        const result = await provider.previewTarFile('readme.md', path.join(TEST_DIR, 'markdown-simple.tar.gz'));
        assert.ok(result.html.includes('<h1>'));
        assert.ok(result.html.includes('Hello World'));
    });

    it('image references in TAR are inlined as data URIs', async () => {
        const result = await provider.previewTarFile('docs/readme.md', path.join(TEST_DIR, 'markdown-with-images.tar.gz'));
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'markdown');
        assert.ok(result.html.includes('data:image/png;base64,'));
    });

    it('both images in markdown-with-images.tar.gz are inlined', async () => {
        const result = await provider.previewTarFile('docs/readme.md', path.join(TEST_DIR, 'markdown-with-images.tar.gz'));
        const matches = (result.html.match(/data:image\/png;base64,/g) || []).length;
        assert.strictEqual(matches, 2, `expected 2 data URIs, got ${matches}`);
    });

    it('returns null for non-existent markdown file in TAR', async () => {
        const result = await provider.previewTarFile('no/such.md', path.join(TEST_DIR, 'markdown-simple.tar.gz'));
        assert.strictEqual(result, null);
    });

    it('previewTarFile returns kind:markdown for README.md in tar.Z (7z decompression path)', async () => {
        const result = await provider.previewTarFile('README.md', path.join(TEST_DIR, 'out.tar.Z'));
        assert.ok(result !== null, 'result should not be null');
        assert.strictEqual(result.kind, 'markdown');
        assert.ok(result.html.length > 0, 'rendered HTML should not be empty');
        assert.ok(result.html.includes('<h1>'), 'HTML should contain a heading');
    });
});

// ---- 7Z integration ----

describe('Markdown preview — 7Z', () => {
    it('preview7zFile returns kind:markdown for readme.md', async () => {
        const result = await provider.preview7zFile('readme.md', path.join(TEST_DIR, 'markdown-simple.7z'));
        assert.ok(result !== null);
        assert.strictEqual(result.kind, 'markdown');
    });

    it('HTML from 7Z contains rendered heading', async () => {
        const result = await provider.preview7zFile('readme.md', path.join(TEST_DIR, 'markdown-simple.7z'));
        assert.ok(result.html.includes('<h1>'));
        assert.ok(result.html.includes('Hello World'));
    });

    it('HTML from 7Z contains bold text', async () => {
        const result = await provider.preview7zFile('readme.md', path.join(TEST_DIR, 'markdown-simple.7z'));
        assert.ok(result.html.includes('<strong>'));
    });
});
