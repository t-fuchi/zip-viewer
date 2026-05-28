import * as assert from 'assert';
import * as path from 'path';

// Access private methods via any cast
// We construct a minimal provider instance for testing utility methods
let provider: any;

before(() => {
    // Dynamically require after vscode mock is in place via tsconfig paths
    const ext = require('../../src/extension');
    // Activate with a stub context to get the provider registered
    // We directly instantiate the class for testing
    const ArchiveFileEditorProvider = getProviderClass();
    provider = new ArchiveFileEditorProvider({ subscriptions: [] });
});

function getProviderClass() {
    // Grab the class by inspecting the module exports pattern
    // extension.ts exports activate/deactivate only, so we rebuild the instance
    // via a fresh require with a mock context
    const mod = require('../../src/extension');
    // Register a dummy custom editor provider to capture the class
    let captured: any;
    const fakeVscode = require('vscode');
    const origRegister = fakeVscode.window.registerCustomEditorProvider;
    fakeVscode.window.registerCustomEditorProvider = (_id: string, p: any) => {
        captured = p;
        return { dispose: () => {} };
    };
    mod.activate({ subscriptions: [] });
    fakeVscode.window.registerCustomEditorProvider = origRegister;
    return captured.constructor;
}

describe('getExtension', () => {
    it('returns compound extension .tar.gz', () => {
        assert.strictEqual(provider.getExtension('file.tar.gz'), '.tar.gz');
    });
    it('returns compound extension .tar.xz', () => {
        assert.strictEqual(provider.getExtension('archive.tar.xz'), '.tar.xz');
    });
    it('returns compound extension .tar.bz2', () => {
        assert.strictEqual(provider.getExtension('archive.tar.bz2'), '.tar.bz2');
    });
    it('returns compound extension .tar.Z', () => {
        assert.strictEqual(provider.getExtension('archive.tar.Z'), '.tar.Z');
    });
    it('returns compound extension .tar.lz', () => {
        assert.strictEqual(provider.getExtension('archive.tar.lz'), '.tar.lz');
    });
    it('returns compound extension .tar.lzma', () => {
        assert.strictEqual(provider.getExtension('archive.tar.lzma'), '.tar.lzma');
    });
    it('returns compound extension .tar.zst', () => {
        assert.strictEqual(provider.getExtension('archive.tar.zst'), '.tar.zst');
    });
    it('normalizes .tgz to .tar.gz', () => {
        assert.strictEqual(provider.getExtension('archive.tgz'), '.tar.gz');
    });
    it('normalizes .tbz2 to .tar.bz2', () => {
        assert.strictEqual(provider.getExtension('archive.tbz2'), '.tar.bz2');
    });
    it('normalizes .tz2 to .tar.bz2', () => {
        assert.strictEqual(provider.getExtension('archive.tz2'), '.tar.bz2');
    });
    it('normalizes .taz to .tar.Z', () => {
        assert.strictEqual(provider.getExtension('archive.taz'), '.tar.Z');
    });
    it('normalizes .tlz to .tar.lz', () => {
        assert.strictEqual(provider.getExtension('archive.tlz'), '.tar.lz');
    });
    it('normalizes .tzst to .tar.zst', () => {
        assert.strictEqual(provider.getExtension('archive.tzst'), '.tar.zst');
    });
    it('returns .zip for zip files', () => {
        assert.strictEqual(provider.getExtension('archive.zip'), '.zip');
    });
    it('returns .7z for 7z files', () => {
        assert.strictEqual(provider.getExtension('archive.7z'), '.7z');
    });
    it('returns .tar for plain tar', () => {
        assert.strictEqual(provider.getExtension('archive.tar'), '.tar');
    });
    it('is case-insensitive', () => {
        assert.strictEqual(provider.getExtension('ARCHIVE.TAR.GZ'), '.tar.gz');
    });
    it('handles paths with directory components', () => {
        assert.strictEqual(provider.getExtension('/some/path/to/file.tar.xz'), '.tar.xz');
    });
});

describe('isTarFormat', () => {
    const tarFormats = [
        '.tar', '.tar.gz', '.tgz', '.tar.xz', '.tar.bz2', '.tbz2', '.tz2',
        '.tar.Z', '.taz', '.taZ', '.tar.lz', '.tlz', '.tar.lzma', '.tar.zst', '.tzst'
    ];
    for (const fmt of tarFormats) {
        it(`recognizes ${fmt}`, () => {
            assert.strictEqual(provider.isTarFormat(fmt), true);
        });
    }
    it('rejects .zip', () => assert.strictEqual(provider.isTarFormat('.zip'), false));
    it('rejects .7z',  () => assert.strictEqual(provider.isTarFormat('.7z'), false));
    it('rejects .rar', () => assert.strictEqual(provider.isTarFormat('.rar'), false));
});

describe('isImageFile', () => {
    const imageFiles = [
        'photo.jpg', 'photo.jpeg', 'icon.png', 'anim.gif',
        'image.webp', 'bitmap.bmp', 'vector.svg', 'favicon.ico',
        'scan.tif', 'scan.tiff', 'photo.avif'
    ];
    for (const f of imageFiles) {
        it(`recognizes ${f} as image`, () => {
            assert.strictEqual(provider.isImageFile(f), true);
        });
    }
    it('rejects .txt', () => assert.strictEqual(provider.isImageFile('readme.txt'), false));
    it('rejects .js',  () => assert.strictEqual(provider.isImageFile('app.js'), false));
    it('rejects .ts',  () => assert.strictEqual(provider.isImageFile('app.ts'), false));
    it('rejects .zip', () => assert.strictEqual(provider.isImageFile('data.zip'), false));
    it('is case-insensitive for .JPG', () => {
        assert.strictEqual(provider.isImageFile('PHOTO.JPG'), true);
    });
    it('is case-insensitive for .PNG', () => {
        assert.strictEqual(provider.isImageFile('IMAGE.PNG'), true);
    });
});

describe('getMimeType', () => {
    const cases: [string, string][] = [
        ['photo.jpg',   'image/jpeg'],
        ['photo.jpeg',  'image/jpeg'],
        ['icon.png',    'image/png'],
        ['anim.gif',    'image/gif'],
        ['image.webp',  'image/webp'],
        ['bitmap.bmp',  'image/bmp'],
        ['vector.svg',  'image/svg+xml'],
        ['favicon.ico', 'image/x-icon'],
        ['scan.tif',    'image/tiff'],
        ['scan.tiff',   'image/tiff'],
        ['photo.avif',  'image/avif'],
    ];
    for (const [file, mime] of cases) {
        it(`${file} → ${mime}`, () => {
            assert.strictEqual(provider.getMimeType(file), mime);
        });
    }
    it('returns application/octet-stream for unknown extension', () => {
        assert.strictEqual(provider.getMimeType('file.xyz'), 'application/octet-stream');
    });
});

describe('escapeHtml', () => {
    it('escapes ampersand', () => {
        assert.strictEqual(provider.escapeHtml('a&b'), 'a&amp;b');
    });
    it('escapes less-than', () => {
        assert.strictEqual(provider.escapeHtml('<div>'), '&lt;div&gt;');
    });
    it('escapes greater-than', () => {
        assert.strictEqual(provider.escapeHtml('a>b'), 'a&gt;b');
    });
    it('escapes double quote', () => {
        assert.strictEqual(provider.escapeHtml('"value"'), '&quot;value&quot;');
    });
    it('escapes single quote', () => {
        assert.strictEqual(provider.escapeHtml("it's"), 'it&#039;s');
    });
    it('escapes XSS payload', () => {
        const result = provider.escapeHtml('<script>alert("xss")</script>');
        assert.ok(!result.includes('<script>'));
        assert.ok(result.includes('&lt;script&gt;'));
    });
    it('leaves plain text unchanged', () => {
        assert.strictEqual(provider.escapeHtml('hello world'), 'hello world');
    });
});

describe('buildTree', () => {
    it('builds a flat list of files', () => {
        const files = [
            { path: 'a.txt', uncompressedSize: 100, lastModifiedDateTime: new Date().toISOString(), type: 'File' },
            { path: 'b.txt', uncompressedSize: 200, lastModifiedDateTime: new Date().toISOString(), type: 'File' }
        ];
        const tree = provider.buildTree(files);
        assert.strictEqual(tree.length, 2);
        assert.strictEqual(tree[0].name, 'a.txt');
        assert.strictEqual(tree[0].isDirectory, false);
        assert.strictEqual(tree[0].size, 100);
    });

    it('builds a nested directory structure', () => {
        const files = [
            { path: 'dir/sub/file.txt', uncompressedSize: 50, lastModifiedDateTime: new Date().toISOString(), type: 'File' }
        ];
        const tree = provider.buildTree(files);
        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].name, 'dir');
        assert.strictEqual(tree[0].isDirectory, true);
        const sub = tree[0].children[0];
        assert.strictEqual(sub.name, 'sub');
        assert.strictEqual(sub.isDirectory, true);
        const file = sub.children[0];
        assert.strictEqual(file.name, 'file.txt');
        assert.strictEqual(file.isDirectory, false);
    });

    it('deduplicates directory entries', () => {
        const files = [
            { path: 'dir/a.txt', uncompressedSize: 10, lastModifiedDateTime: new Date().toISOString(), type: 'File' },
            { path: 'dir/b.txt', uncompressedSize: 20, lastModifiedDateTime: new Date().toISOString(), type: 'File' }
        ];
        const tree = provider.buildTree(files);
        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].name, 'dir');
        assert.strictEqual(tree[0].children.length, 2);
    });

    it('skips empty path segments from trailing slash', () => {
        const files = [
            { path: 'dir/', uncompressedSize: 0, lastModifiedDateTime: new Date().toISOString(), type: 'Directory' }
        ];
        const tree = provider.buildTree(files);
        assert.strictEqual(tree.length, 1);
        assert.strictEqual(tree[0].name, 'dir');
    });

    it('returns empty array for empty input', () => {
        assert.deepStrictEqual(provider.buildTree([]), []);
    });
});

describe('process7zEntry', () => {
    it('adds a top-level file', () => {
        const entries: any[] = [];
        const entry = { name: 'file.txt', size: 100, time: Date.now(), isDirectory: false };
        provider.process7zEntry(entries, 'file.txt', entry);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].name, 'file.txt');
    });

    it('creates intermediate directories', () => {
        const entries: any[] = [];
        const entry = { name: 'file.txt', size: 50, time: Date.now(), isDirectory: false };
        provider.process7zEntry(entries, 'dir/sub/file.txt', entry);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].name, 'dir');
        assert.strictEqual(entries[0].isDirectory, true);
        assert.strictEqual(entries[0].children[0].name, 'sub');
        assert.strictEqual(entries[0].children[0].children[0].name, 'file.txt');
    });

    it('handles backslash path separators', () => {
        const entries: any[] = [];
        const entry = { name: 'file.txt', size: 10, time: Date.now(), isDirectory: false };
        provider.process7zEntry(entries, 'dir\\sub\\file.txt', entry);
        assert.strictEqual(entries[0].name, 'dir');
        assert.strictEqual(entries[0].children[0].children[0].name, 'file.txt');
    });

    it('reuses existing directory nodes', () => {
        const entries: any[] = [];
        const e1 = { name: 'a.txt', size: 10, time: Date.now(), isDirectory: false };
        const e2 = { name: 'b.txt', size: 20, time: Date.now(), isDirectory: false };
        provider.process7zEntry(entries, 'dir/a.txt', e1);
        provider.process7zEntry(entries, 'dir/b.txt', e2);
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].children.length, 2);
    });
});

describe('isMarkdownFile', () => {
    it('recognizes .md', () => {
        assert.ok(provider.isMarkdownFile('readme.md'));
    });
    it('recognizes .markdown', () => {
        assert.ok(provider.isMarkdownFile('doc.markdown'));
    });
    it('is case-insensitive (.MD)', () => {
        assert.ok(provider.isMarkdownFile('README.MD'));
    });
    it('rejects .txt', () => {
        assert.ok(!provider.isMarkdownFile('readme.txt'));
    });
    it('rejects .html', () => {
        assert.ok(!provider.isMarkdownFile('page.html'));
    });
    it('rejects no extension', () => {
        assert.ok(!provider.isMarkdownFile('Makefile'));
    });
});

describe('resolveArchivePath', () => {
    it('resolves same-directory reference', () => {
        assert.strictEqual(provider.resolveArchivePath('docs/readme.md', 'logo.png'), 'docs/logo.png');
    });
    it('resolves subdirectory reference', () => {
        assert.strictEqual(provider.resolveArchivePath('docs/readme.md', 'images/logo.png'), 'docs/images/logo.png');
    });
    it('resolves parent directory reference', () => {
        assert.strictEqual(provider.resolveArchivePath('docs/sub/readme.md', '../logo.png'), 'docs/logo.png');
    });
    it('resolves root-level markdown', () => {
        assert.strictEqual(provider.resolveArchivePath('readme.md', 'img/photo.png'), 'img/photo.png');
    });
    it('passes through http URLs unchanged', () => {
        assert.strictEqual(provider.resolveArchivePath('readme.md', 'https://example.com/img.png'), 'https://example.com/img.png');
    });
    it('passes through data: URIs unchanged', () => {
        const dataUri = 'data:image/png;base64,abc';
        assert.strictEqual(provider.resolveArchivePath('readme.md', dataUri), dataUri);
    });
    it('resolves double parent traversal', () => {
        assert.strictEqual(provider.resolveArchivePath('a/b/c/readme.md', '../../logo.png'), 'a/logo.png');
    });
});

describe('extractImageRefs', () => {
    it('extracts a single image reference', () => {
        const refs = provider.extractImageRefs('![alt](images/logo.png)', 'readme.md');
        assert.deepStrictEqual(refs, ['images/logo.png']);
    });
    it('extracts multiple image references', () => {
        const refs = provider.extractImageRefs('![a](a.png)\n![b](b.png)', 'readme.md');
        assert.strictEqual(refs.length, 2);
        assert.ok(refs.includes('a.png'));
        assert.ok(refs.includes('b.png'));
    });
    it('deduplicates repeated references', () => {
        const refs = provider.extractImageRefs('![a](img.png)\n![b](img.png)', 'readme.md');
        assert.strictEqual(refs.length, 1);
    });
    it('ignores http URLs', () => {
        const refs = provider.extractImageRefs('![a](https://example.com/img.png)', 'readme.md');
        assert.strictEqual(refs.length, 0);
    });
    it('resolves paths relative to markdown location', () => {
        const refs = provider.extractImageRefs('![a](images/logo.png)', 'docs/readme.md');
        assert.deepStrictEqual(refs, ['docs/images/logo.png']);
    });
    it('returns empty array when no images', () => {
        const refs = provider.extractImageRefs('# Hello\n\nNo images here.', 'readme.md');
        assert.strictEqual(refs.length, 0);
    });
    it('handles image with title attribute', () => {
        const refs = provider.extractImageRefs('![alt](logo.png "Title")', 'readme.md');
        assert.strictEqual(refs.length, 1);
        assert.strictEqual(refs[0], 'logo.png');
    });
});
