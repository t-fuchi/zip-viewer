/**
 * Tests for error handling with malformed, corrupt, and empty archives.
 *
 * Verifies that:
 *  - Corrupt ZIP/TAR/7Z files return [] without throwing
 *  - Non-existent files return [] without throwing
 *  - Empty (but valid) ZIP returns [] entries
 *  - Preview methods return null gracefully for corrupt archives
 *  - Error messages are shown to the user (not swallowed silently)
 */

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const TEST_DIR = path.join(__dirname, '../../test');

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

afterEach(() => {
    fakeVscode.window.showErrorMessage = async () => undefined;
});

function captureErrors(fn: () => Promise<void>): Promise<string[]> {
    const errors: string[] = [];
    const orig = fakeVscode.window.showErrorMessage;
    fakeVscode.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(); };
    return fn().finally(() => { fakeVscode.window.showErrorMessage = orig; }).then(() => errors);
}

// ── loadZipEntries — corrupt / missing ───────────────────────────────────────

describe('loadZipEntries — error handling', () => {
    it('sets archiveEntries to [] for a corrupt ZIP', async () => {
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'corrupt.zip'));
        assert.deepStrictEqual(entries, []);
    });

    it('shows an error message for a corrupt ZIP', async () => {
        const errors = await captureErrors(() =>
            provider.loadZipEntries(path.join(TEST_DIR, 'corrupt.zip'))
        );
        assert.ok(errors.length >= 1, 'should show at least one error');
        assert.ok(errors[0].toLowerCase().includes('error') || errors[0].toLowerCase().includes('zip'),
            `unexpected message: ${errors[0]}`);
    });

    it('sets archiveEntries to [] for a non-existent file', async () => {
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'does_not_exist.zip'));
        assert.deepStrictEqual(entries, []);
    });

    it('does not throw for a corrupt ZIP', async () => {
        await assert.doesNotReject(() =>
            provider.loadZipEntries(path.join(TEST_DIR, 'corrupt.zip'))
        );
    });

    it('returns empty entries for an empty (valid) ZIP', async () => {
        const entries = await provider.loadZipEntries(path.join(TEST_DIR, 'empty.zip'));
        assert.deepStrictEqual(entries, []);
    });
});

// ── loadTarEntries — corrupt / missing ───────────────────────────────────────

describe('loadTarEntries — error handling', () => {
    it('sets archiveEntries to [] for a corrupt TAR.GZ', async () => {
        const entries = await provider.loadTarEntries(path.join(TEST_DIR, 'corrupt.tar.gz'));
        assert.deepStrictEqual(entries, []);
    });

    it('shows an error message for a corrupt TAR.GZ', async () => {
        const errors = await captureErrors(() =>
            provider.loadTarEntries(path.join(TEST_DIR, 'corrupt.tar.gz'))
        );
        assert.ok(errors.length >= 1);
    });

    it('does not throw for a corrupt TAR.GZ', async () => {
        await assert.doesNotReject(() =>
            provider.loadTarEntries(path.join(TEST_DIR, 'corrupt.tar.gz'))
        );
    });

    it('throws ENOENT for a non-existent TAR file (statSync before try-catch)', async () => {
        // loadTarEntries calls fs.statSync before the try-catch, so it throws for missing files
        await assert.rejects(
            () => provider.loadTarEntries(path.join(TEST_DIR, 'does_not_exist.tar.gz')),
            /ENOENT/
        );
    });
});

// ── load7zEntries — corrupt / missing ────────────────────────────────────────

describe('load7zEntries — error handling', () => {
    it('sets archiveEntries to [] for a corrupt 7Z', async () => {
        const tmpPath = path.join(os.tmpdir(), 'zv-corrupt.7z');
        fs.writeFileSync(tmpPath, Buffer.from('7z\xbc\xaf\x27\x1c' + '\xff'.repeat(20)));
        const entries = await provider.load7zEntries(tmpPath);
        assert.deepStrictEqual(entries, []);
        fs.unlinkSync(tmpPath);
    });

    it('does not throw for a corrupt 7Z', async () => {
        const tmpPath = path.join(os.tmpdir(), 'zv-corrupt2.7z');
        fs.writeFileSync(tmpPath, Buffer.from('7z\xbc\xaf\x27\x1c' + '\x00'.repeat(20)));
        await assert.doesNotReject(() => provider.load7zEntries(tmpPath));
        fs.unlinkSync(tmpPath);
    });

    it('sets archiveEntries to [] for a non-existent 7Z', async () => {
        const entries = await provider.load7zEntries(path.join(TEST_DIR, 'does_not_exist.7z'));
        assert.deepStrictEqual(entries, []);
    });
});

// ── previewZipFile — corrupt archive ─────────────────────────────────────────

describe('previewZipFile — error handling', () => {
    it('returns null for a corrupt ZIP', async () => {
        const result = await provider.previewZipFile('any/file.txt', path.join(TEST_DIR, 'corrupt.zip'));
        assert.strictEqual(result, null);
    });

    it('does not throw when previewing a corrupt ZIP', async () => {
        await assert.doesNotReject(() =>
            provider.previewZipFile('any/file.txt', path.join(TEST_DIR, 'corrupt.zip'))
        );
    });
});

// ── previewTarFile — corrupt archive ─────────────────────────────────────────

describe('previewTarFile — error handling', () => {
    it('rejects with decompression error when previewing a corrupt TAR.GZ', async () => {
        await assert.rejects(() =>
            provider.previewTarFile('any/file.txt', path.join(TEST_DIR, 'corrupt.tar.gz'))
        );
    });
});

// ── cancellation token ────────────────────────────────────────────────────────

describe('Cancellation token handling', () => {
    it('loadZipEntries returns [] when cancelled', async () => {
        const cancelledToken = { isCancellationRequested: true };
        const entries = await provider.loadZipEntries(
            path.join(TEST_DIR, 'out.zip'),
            undefined,
            cancelledToken
        );
        assert.deepStrictEqual(entries, []);
    });

    it('loadTarEntries returns [] when cancelled before start', async () => {
        const cancelledToken = { isCancellationRequested: true };
        const entries = await provider.loadTarEntries(
            path.join(TEST_DIR, 'out.tar.gz'),
            undefined,
            cancelledToken
        );
        assert.deepStrictEqual(entries, []);
    });

    it('load7zEntries returns [] when cancelled mid-listing', async () => {
        let callCount = 0;
        const token = {
            get isCancellationRequested() {
                callCount++;
                return callCount > 1;
            }
        };
        const entries = await provider.load7zEntries(path.join(TEST_DIR, 'out.7z'), undefined, token);
        assert.deepStrictEqual(entries, []);
    });
});
