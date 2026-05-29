import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const TEST_DIR = path.join(__dirname, '../../test');
const OUT_ZIP    = path.join(TEST_DIR, 'out.zip');
const OUT_TAR_GZ = path.join(TEST_DIR, 'out.tar.gz');
const OUT_7Z     = path.join(TEST_DIR, 'out.7z');

// A file and folder that exist in all three test archives
const TEST_FILE   = 'out/extension.js';
const TEST_FOLDER = 'out';

let provider: any;
let fakeVscode: any;
const tmpDirs: string[] = [];

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

function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zv-extract-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    fakeVscode.window.showSaveDialog = async () => undefined;
    fakeVscode.window.showOpenDialog = async () => undefined;
    fakeVscode.window.showInformationMessage = async () => undefined;
    provider.savedPasswords = {};
});

// ─── extractZipFile ────────────────────────────────────────────────────────────

describe('extractZipFile', () => {
    beforeEach(() => {
        provider.savedPasswords = {};
    });

    it('extracts a file to the path returned by the save dialog', async () => {
        const tmpDir = makeTmpDir();
        const savePath = path.join(tmpDir, 'extension.js');
        fakeVscode.window.showSaveDialog = async () => ({ fsPath: savePath });

        await provider.extractZipFile(TEST_FILE, OUT_ZIP);

        assert.ok(fs.existsSync(savePath), 'extracted file should exist');
        assert.ok(fs.readFileSync(savePath).length > 0, 'extracted file should be non-empty');
    });

    it('extracted content matches direct zip stream read', async () => {
        const tmpDir = makeTmpDir();
        const savePath = path.join(tmpDir, 'extension.js');
        fakeVscode.window.showSaveDialog = async () => ({ fsPath: savePath });

        await provider.extractZipFile(TEST_FILE, OUT_ZIP);
        const extracted = fs.readFileSync(savePath);

        // Cross-check with ZIP preview
        const preview = await provider.previewZipFile(TEST_FILE, OUT_ZIP);
        assert.ok(extracted.toString('utf8').startsWith(preview.content.split('\n')[0]),
            'extracted content should match preview');
    });

    it('does nothing when the save dialog is cancelled', async () => {
        fakeVscode.window.showSaveDialog = async () => undefined;
        await provider.extractZipFile(TEST_FILE, OUT_ZIP); // should not throw
    });

    it('returns early (no dialog) when file does not exist in archive', async () => {
        let dialogCalled = false;
        fakeVscode.window.showSaveDialog = async () => { dialogCalled = true; return undefined; };

        await provider.extractZipFile('no/such/file.txt', OUT_ZIP);

        assert.ok(!dialogCalled, 'save dialog should not be shown for missing file');
    });
});

// ─── extractTarFile ────────────────────────────────────────────────────────────
//
// tar.extract uses strip:1, so "out/extension.js" is extracted as "extension.js"
// into path.dirname(saveUri.fsPath).

describe('extractTarFile', () => {
    it('extracts a file from tar.gz (strip:1 removes top-level folder)', async () => {
        const tmpDir = makeTmpDir();
        // The user saves to "extension.js" in tmpDir; strip:1 puts it there.
        fakeVscode.window.showSaveDialog = async () => ({ fsPath: path.join(tmpDir, 'extension.js') });

        await provider.extractTarFile(TEST_FILE, OUT_TAR_GZ);

        const extracted = path.join(tmpDir, 'extension.js');
        assert.ok(fs.existsSync(extracted), 'stripped file should exist in the save directory');
        assert.ok(fs.readFileSync(extracted).length > 0);
    });

    it('does nothing when the save dialog is cancelled', async () => {
        fakeVscode.window.showSaveDialog = async () => undefined;
        await provider.extractTarFile(TEST_FILE, OUT_TAR_GZ);
    });
});

// ─── extract7zFile ─────────────────────────────────────────────────────────────

describe('extract7zFile', () => {
    it('extracts a file from 7z to the save path', async () => {
        const tmpDir = makeTmpDir();
        const savePath = path.join(tmpDir, 'extension.js');
        fakeVscode.window.showSaveDialog = async () => ({ fsPath: savePath });

        await provider.extract7zFile(TEST_FILE, OUT_7Z);

        assert.ok(fs.existsSync(savePath), 'extracted file should exist');
        assert.ok(fs.readFileSync(savePath).length > 0);
    });

    it('does nothing when the save dialog is cancelled', async () => {
        fakeVscode.window.showSaveDialog = async () => undefined;
        await provider.extract7zFile(TEST_FILE, OUT_7Z);
    });
});

// ─── extractZipFolder ──────────────────────────────────────────────────────────
//
// Recreates basename(folderUri) inside the chosen destination with relative paths.

describe('extractZipFolder', () => {
    beforeEach(() => {
        provider.savedPasswords = {};
    });

    it('extracts folder contents preserving the folder name', async () => {
        const tmpDir = makeTmpDir();
        fakeVscode.window.showOpenDialog = async () => [{ fsPath: tmpDir }];

        await provider.extractZipFolder(TEST_FOLDER, OUT_ZIP);

        const folderPath = path.join(tmpDir, 'out');
        assert.ok(fs.existsSync(folderPath), 'top-level "out" folder should be created');
        assert.ok(fs.existsSync(path.join(folderPath, 'extension.js')), 'extension.js should be inside');
    });

    it('does nothing when the open dialog is cancelled', async () => {
        fakeVscode.window.showOpenDialog = async () => undefined;
        await provider.extractZipFolder(TEST_FOLDER, OUT_ZIP);
    });

    it('does nothing when the open dialog returns an empty array', async () => {
        fakeVscode.window.showOpenDialog = async () => [];
        await provider.extractZipFolder(TEST_FOLDER, OUT_ZIP);
    });
});

// ─── extractTarFolder ──────────────────────────────────────────────────────────
//
// strip:1 removes the top-level folder, so "out/extension.js" → "extension.js"
// directly inside the chosen destination.

describe('extractTarFolder', () => {
    it('extracts folder contents from tar.gz with strip:1', async () => {
        const tmpDir = makeTmpDir();
        fakeVscode.window.showOpenDialog = async () => [{ fsPath: tmpDir }];

        await provider.extractTarFolder(TEST_FOLDER, OUT_TAR_GZ);

        assert.ok(fs.existsSync(path.join(tmpDir, 'extension.js')),
            'strip:1 should place extension.js directly in destination, not inside "out/"');
    });

    it('does nothing when the open dialog is cancelled', async () => {
        fakeVscode.window.showOpenDialog = async () => undefined;
        await provider.extractTarFolder(TEST_FOLDER, OUT_TAR_GZ);
    });
});

// ─── extract7zFolder ───────────────────────────────────────────────────────────
//
// Uses 7z extractFull with "folderUri/*" wildcard; full paths are preserved.

describe('extract7zFolder', () => {
    it('extracts folder from 7z preserving full path', async () => {
        const tmpDir = makeTmpDir();
        fakeVscode.window.showOpenDialog = async () => [{ fsPath: tmpDir }];

        await provider.extract7zFolder(TEST_FOLDER, OUT_7Z);

        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js')),
            'full path should be preserved under destination');
    });

    it('does nothing when the open dialog is cancelled', async () => {
        fakeVscode.window.showOpenDialog = async () => undefined;
        await provider.extract7zFolder(TEST_FOLDER, OUT_7Z);
    });
});

// ─── extractSelectedZip ────────────────────────────────────────────────────────
//
// Writes files to path.join(destinationPath, file.path).

describe('extractSelectedZip', () => {
    const progress = { report: () => {} };

    beforeEach(() => {
        provider.savedPasswords = {};
    });

    it('extracts a single selected file', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedZip([TEST_FILE], tmpDir, progress, OUT_ZIP);
        assert.ok(fs.existsSync(path.join(tmpDir, TEST_FILE)));
    });

    it('extracted file is non-empty', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedZip([TEST_FILE], tmpDir, progress, OUT_ZIP);
        assert.ok(fs.readFileSync(path.join(tmpDir, TEST_FILE)).length > 0);
    });

    it('extracts all files under a selected folder', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedZip([TEST_FOLDER], tmpDir, progress, OUT_ZIP);
        // Files under "out/" should exist at destination/out/<filename>
        assert.ok(fs.existsSync(path.join(tmpDir, TEST_FILE)));
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js.map')));
    });

    it('extracts multiple selected files', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedZip(
            ['out/extension.js', 'out/extension.js.map'],
            tmpDir,
            progress,
            OUT_ZIP
        );
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js')));
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js.map')));
    });
});

// ─── extractSelectedTar ────────────────────────────────────────────────────────
//
// No strip — full entry path is preserved under destination.

describe('extractSelectedTar', () => {
    const progress = { report: () => {} };

    it('extracts a selected file from tar.gz with full path', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedTar([TEST_FILE], tmpDir, progress, OUT_TAR_GZ);
        assert.ok(fs.existsSync(path.join(tmpDir, TEST_FILE)));
    });

    it('extracts all files under a selected folder', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedTar([TEST_FOLDER], tmpDir, progress, OUT_TAR_GZ);
        assert.ok(fs.existsSync(path.join(tmpDir, TEST_FILE)));
    });

    it('extracts multiple selected files', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelectedTar(
            ['out/extension.js', 'out/extension.js.map'],
            tmpDir,
            progress,
            OUT_TAR_GZ
        );
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js')));
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js.map')));
    });
});

// ─── extractSelected7z ─────────────────────────────────────────────────────────

describe('extractSelected7z', () => {
    const progress = { report: () => {} };

    it('extracts a selected file from 7z with full path', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelected7z([TEST_FILE], tmpDir, progress, OUT_7Z);
        assert.ok(fs.existsSync(path.join(tmpDir, TEST_FILE)));
    });

    it('extracts multiple selected files from 7z', async () => {
        const tmpDir = makeTmpDir();
        await provider.extractSelected7z(
            ['out/extension.js', 'out/extension.js.map'],
            tmpDir,
            progress,
            OUT_7Z
        );
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js')));
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js.map')));
    });
});
