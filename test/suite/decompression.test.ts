/**
 * Tests for getDecompressionStream().
 *
 * Verifies that each supported TAR compression format produces a readable
 * stream that can be piped through tar to yield valid archive entries.
 * Each test uses the corresponding fixture file in test/.
 */

import * as assert from 'assert';
import * as path from 'path';
import * as tar from 'tar';
import { pipeline } from 'stream';
import { promisify } from 'util';

const pipelineAsync = promisify(pipeline);
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

async function collectEntries(archivePath: string, extension: string): Promise<string[]> {
    const names: string[] = [];
    const stream = provider.getDecompressionStream(extension, archivePath);
    await pipelineAsync(
        stream,
        tar.t({
            onentry: (entry: any) => names.push(entry.path)
        }) as any
    );
    return names;
}

describe('getDecompressionStream — .tar (plain)', () => {
    it('returns entries from plain .tar', async () => {
        const names = await collectEntries(path.join(TEST_DIR, 'out.tar'), '.tar');
        assert.ok(names.length > 0, 'should have entries');
        assert.ok(names.some(n => n.includes('extension.js')));
    });
});

describe('getDecompressionStream — .tar.gz / .tgz', () => {
    it('decompresses .tar.gz and returns entries', async () => {
        const names = await collectEntries(path.join(TEST_DIR, 'out.tar.gz'), '.tar.gz');
        assert.ok(names.length > 0);
        assert.ok(names.some(n => n.includes('extension.js')));
    });

    it('decompresses .tgz (alias) and returns entries', async () => {
        const names = await collectEntries(path.join(TEST_DIR, 'out.tgz'), '.tgz');
        assert.ok(names.length > 0);
    });
});

describe('getDecompressionStream — .tar.bz2 / .tbz2 / .tz2', () => {
    it('decompresses .tar.bz2 and returns entries', async () => {
        const names = await collectEntries(path.join(TEST_DIR, 'out.tar.bz2'), '.tar.bz2');
        assert.ok(names.length > 0);
        assert.ok(names.some(n => n.includes('extension.js')));
    });
});

describe('getDecompressionStream — .tar.xz', () => {
    it('decompresses .tar.xz and returns entries', async () => {
        const names = await collectEntries(path.join(TEST_DIR, 'out.tar.xz'), '.tar.xz');
        assert.ok(names.length > 0);
        assert.ok(names.some(n => n.includes('extension.js')));
    });
});

describe('getDecompressionStream — .tar.zst', () => {
    it('decompresses .tar.zst (Zstandard) and returns entries', async () => {
        const names = await collectEntries(path.join(TEST_DIR, 'out.tar.zst'), '.tar.zst');
        assert.ok(names.length > 0, 'should have at least one entry');
    });
});

describe('getDecompressionStream — return value is a Readable', () => {
    it('returns a Readable for each known extension', () => {
        const { Readable } = require('stream');
        const formats = ['.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tz2',
                         '.tar.xz', '.tar.lz', '.tlz', '.tar.lzma', '.tar.zst'];
        for (const ext of formats) {
            // Use a known file; some may decompress incorrectly but stream object itself must be Readable
            const stream = provider.getDecompressionStream(ext, path.join(TEST_DIR, 'out.tar.gz'));
            assert.ok(stream instanceof Readable || typeof stream.pipe === 'function',
                `${ext} should return a Readable-like stream`);
            stream.destroy();
        }
    });
});
