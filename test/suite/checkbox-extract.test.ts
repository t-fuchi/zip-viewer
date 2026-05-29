/**
 * End-to-end tests: check checkboxes in the webview → click Extract → verify files on disk.
 * Covers every supported archive format.
 */
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { JSDOM } from 'jsdom';

const TEST_DIR = path.join(__dirname, '../../test');

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zv-cb-extract-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    fakeVscode.window.showOpenDialog = async () => undefined;
    fakeVscode.window.showInformationMessage = async () => undefined;
    provider.savedPasswords = {};
});

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function buildDOMWithEntries(entries: any[]): { dom: JSDOM; msgs: any[] } {
    const html = provider.getWebviewContent(entries);
    const msgs: any[] = [];
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(window: any) {
            window.acquireVsCodeApi = () => ({
                postMessage: (msg: any) => msgs.push(msg)
            });
        }
    } as any);
    dom.window.document.dispatchEvent(
        new dom.window.Event('DOMContentLoaded', { bubbles: false })
    );
    return { dom, msgs };
}

/** Check the checkbox whose data-path matches `dataPath`. */
function checkByPath(dom: JSDOM, dataPath: string): void {
    const cb = dom.window.document.querySelector(
        `.checkbox[data-path="${dataPath}"]`
    ) as HTMLInputElement;
    assert.ok(cb, `checkbox not found for path: ${dataPath}`);
    cb.click();
}

/** Click the Extract button in the webview toolbar. */
function clickExtract(dom: JSDOM): void {
    const btn = dom.window.document.getElementById('extractBtn') as HTMLButtonElement;
    assert.ok(btn, 'extractBtn not found');
    btn.click();
}

// ─── Shared entry builders ────────────────────────────────────────────────────

/** Standard entries for archives that contain an "out/" top-level folder. */
function outFolderEntries(): any[] {
    return [{
        name: 'out', size: 0, time: Date.now(), isDirectory: true, date: new Date(),
        children: [
            { name: 'extension.js',     size: 3342, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
            { name: 'extension.js.map', size: 1569, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
        ]
    }];
}

// ─── Test matrix ──────────────────────────────────────────────────────────────

interface FormatCase {
    label: string;
    archive: string;
    entries: any[];
    checkPath: string;    // data-path value to check
    expectedFile: string; // relative path expected under tmpDir after extraction
}

const CASES: FormatCase[] = [
    {
        label: 'zip',
        archive: 'out.zip',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: '7z',
        archive: 'out.7z',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: 'tar.gz',
        archive: 'out.tar.gz',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: 'tgz',
        archive: 'out.tgz',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: 'tar.bz2',
        archive: 'out.tar.bz2',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: 'tar.xz',
        archive: 'out.tar.xz',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: 'tar.zst',
        archive: 'out.tar.zst',
        entries: [{
            name: 'test', size: 0, time: Date.now(), isDirectory: true, date: new Date(),
            children: [
                { name: 'poi.txt', size: 0, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
            ]
        }],
        checkPath: 'test/poi.txt',
        expectedFile: 'test/poi.txt',
    },
    {
        label: 'tar (uncompressed)',
        archive: 'out.tar',
        entries: outFolderEntries(),
        checkPath: 'out/extension.js',
        expectedFile: 'out/extension.js',
    },
    {
        label: 'tar.Z',
        archive: 'out.tar.Z',
        entries: [{
            name: 'src', size: 0, time: Date.now(), isDirectory: true, date: new Date(),
            children: [
                { name: 'extension.ts', size: 0, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
            ]
        }],
        checkPath: 'src/extension.ts',
        expectedFile: 'src/extension.ts',
    },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

for (const c of CASES) {
    describe(`Checkbox → Extract: ${c.label}`, () => {
        it('checking a file checkbox enables the Extract button', () => {
            const { dom } = buildDOMWithEntries(c.entries);
            const btn = dom.window.document.getElementById('extractBtn') as HTMLButtonElement;
            assert.strictEqual(btn.disabled, true, 'Extract button should start disabled');

            checkByPath(dom, c.checkPath);

            assert.strictEqual(btn.disabled, false, 'Extract button should be enabled after checking');
        });

        it('clicking Extract sends extractSelected message with correct paths', () => {
            const { dom, msgs } = buildDOMWithEntries(c.entries);
            checkByPath(dom, c.checkPath);
            clickExtract(dom);

            const msg = msgs.find(m => m.command === 'extractSelected');
            assert.ok(msg, 'extractSelected message should be sent');
            assert.ok(Array.isArray(msg.selectedPaths), 'selectedPaths should be an array');
            assert.ok(
                msg.selectedPaths.includes(c.checkPath),
                `selectedPaths should include "${c.checkPath}", got: ${JSON.stringify(msg.selectedPaths)}`
            );
        });

        it('extractSelected message paths actually extract to disk', async () => {
            const archiveFile = path.join(TEST_DIR, c.archive);
            const tmpDir = makeTmpDir();

            // Simulate webview: check checkbox, click Extract, capture message
            const { dom, msgs } = buildDOMWithEntries(c.entries);
            checkByPath(dom, c.checkPath);
            clickExtract(dom);

            const msg = msgs.find(m => m.command === 'extractSelected');
            assert.ok(msg, 'extractSelected message should be sent');

            // Route the message to the provider (mirrors what resolveCustomEditor does)
            fakeVscode.window.showOpenDialog = async () => [{ fsPath: tmpDir }];
            await provider.extractSelected(msg.selectedPaths, archiveFile);

            assert.ok(
                fs.existsSync(path.join(tmpDir, c.expectedFile)),
                `Expected extracted file at ${path.join(tmpDir, c.expectedFile)}`
            );
        });

        it('extractSelected with multiple checked files extracts all of them', async () => {
            // Only test formats that have a second file at the expected path
            if (c.label === 'tar.zst' || c.label === 'tar.Z') {
                // These archives have only one easily addressable file — skip multi-file check
                return;
            }

            const archiveFile = path.join(TEST_DIR, c.archive);
            const tmpDir = makeTmpDir();

            const secondPath = c.checkPath.replace('extension.js', 'extension.js.map');
            const secondExpected = c.expectedFile.replace('extension.js', 'extension.js.map');

            const { dom, msgs } = buildDOMWithEntries(c.entries);
            checkByPath(dom, c.checkPath);
            checkByPath(dom, secondPath);
            clickExtract(dom);

            const msg = msgs.find(m => m.command === 'extractSelected');
            assert.ok(msg);
            assert.ok(msg.selectedPaths.includes(c.checkPath));
            assert.ok(msg.selectedPaths.includes(secondPath));

            fakeVscode.window.showOpenDialog = async () => [{ fsPath: tmpDir }];
            await provider.extractSelected(msg.selectedPaths, archiveFile);

            assert.ok(fs.existsSync(path.join(tmpDir, c.expectedFile)), `${c.expectedFile} should exist`);
            assert.ok(fs.existsSync(path.join(tmpDir, secondExpected)), `${secondExpected} should exist`);
        });
    });
}

// ─── Folder-level extraction via checkbox ─────────────────────────────────────

describe('Checkbox → Extract: folder checkbox extracts all children (zip)', () => {
    it('checking the folder checkbox and extracting extracts all descendant files', async () => {
        const archiveFile = path.join(TEST_DIR, 'out.zip');
        const tmpDir = makeTmpDir();

        const { dom, msgs } = buildDOMWithEntries(outFolderEntries());

        // Check the folder-level checkbox (data-path = 'out')
        checkByPath(dom, 'out');
        clickExtract(dom);

        const msg = msgs.find(m => m.command === 'extractSelected');
        assert.ok(msg, 'extractSelected message should be sent');
        assert.ok(msg.selectedPaths.includes('out'), 'folder path should be in selectedPaths');

        fakeVscode.window.showOpenDialog = async () => [{ fsPath: tmpDir }];
        await provider.extractSelected(msg.selectedPaths, archiveFile);

        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js')),
            'extension.js should exist under out/');
        assert.ok(fs.existsSync(path.join(tmpDir, 'out', 'extension.js.map')),
            'extension.js.map should exist under out/');
    });
});

describe('Checkbox → Extract: does nothing when dialog is cancelled', () => {
    it('no files are created when showOpenDialog returns undefined', async () => {
        const archiveFile = path.join(TEST_DIR, 'out.zip');
        const tmpDir = makeTmpDir();

        const { dom, msgs } = buildDOMWithEntries(outFolderEntries());
        checkByPath(dom, 'out/extension.js');
        clickExtract(dom);

        const msg = msgs.find(m => m.command === 'extractSelected');
        assert.ok(msg);

        fakeVscode.window.showOpenDialog = async () => undefined;
        await provider.extractSelected(msg.selectedPaths, archiveFile);

        assert.strictEqual(
            fs.existsSync(path.join(tmpDir, 'out', 'extension.js')),
            false,
            'no file should be created when dialog is cancelled'
        );
    });
});
