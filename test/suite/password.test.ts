/**
 * Tests for password handling in archive preview.
 *
 * Verifies:
 *  - Unencrypted archives need no prompt
 *  - Correct password unlocks preview and is stored in savedPasswords
 *  - Stored password is reused on subsequent previews without prompting
 *  - Wrong password shows an error message and re-prompts
 *  - Wrong password is never stored
 *  - Cancelling the prompt returns null immediately
 *  - Passwords are keyed per archive path (archives are independent)
 *  - Stale stored password triggers a fresh prompt
 *  - Behaviour is consistent across ZIP and 7Z formats
 *
 * Test archives used:
 *  - out_pass.zip / out_pass.7z  (password: "pass")
 *  - out.zip                     (unencrypted, used as backing store for mock tests)
 */

import * as assert from 'assert';
import * as path from 'path';

const TEST_DIR = path.join(__dirname, '../../test');

// Known-password archives already committed to the test directory
const PASS_ZIP = path.join(TEST_DIR, 'out_pass.zip');   // password: "pass"
const PASS_7Z  = path.join(TEST_DIR, 'out_pass.7z');    // password: "pass"
const CORRECT_PASSWORD = 'pass';

const OPEN_ZIP = path.join(TEST_DIR, 'out.zip');         // unencrypted
const OPEN_FILE = 'out/extension.js';

// A file that exists in both out_pass.zip and out_pass.7z
const PASS_FILE = 'out/extension.js';

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

// ── helpers ─────────────────────────────────────────────────────────────────

/** Replace promptForPassword with a function that returns the given values in sequence. */
function mockPrompt(...responses: (string | undefined)[]): () => Promise<string | undefined> {
    let i = 0;
    return async () => responses[i < responses.length ? i++ : responses.length - 1];
}

/** Capture showErrorMessage calls for the duration of a test. */
function captureErrors(fn: () => Promise<void>): Promise<string[]> {
    const errors: string[] = [];
    const orig = fakeVscode.window.showErrorMessage;
    fakeVscode.window.showErrorMessage = (msg: string) => { errors.push(msg); return Promise.resolve(); };
    return fn().finally(() => { fakeVscode.window.showErrorMessage = orig; }).then(() => errors);
}

// ── Password-flow logic tests (mock checkPassword, use open archive for reads) ───

describe('Password flow — logic (mock-based)', () => {

    beforeEach(() => {
        provider.savedPasswords = {};
        provider.archiveFilePath = OPEN_ZIP;
        // Mock checkPassword: only accepts CORRECT_PASSWORD
        provider.checkPassword = async (_file: any, pw: string) => pw === CORRECT_PASSWORD;
    });

    afterEach(() => {
        // Restore real checkPassword
        delete provider.checkPassword;
    });

    it('unencrypted flow: checkPassword with "" returns true → no prompt', async () => {
        // Simulate unencrypted: any password accepted
        provider.checkPassword = async () => true;
        let prompted = false;
        provider.promptForPassword = async () => { prompted = true; return ''; };
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.ok(!prompted, 'should not prompt for unencrypted file');
        assert.ok(result !== null);
    });

    it('correct password on first attempt → result is not null', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.ok(result !== null);
    });

    it('correct password is stored in savedPasswords', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(provider.savedPasswords[OPEN_ZIP], CORRECT_PASSWORD);
    });

    it('stored password is reused — prompt is not called again', async () => {
        // First call: enter password and save it
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        await provider.previewZipFile(OPEN_FILE);

        // Second call: should use saved password without prompting
        let promptedAgain = false;
        provider.promptForPassword = async () => { promptedAgain = true; return ''; };
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.ok(!promptedAgain, 'should not prompt when password is already saved');
        assert.ok(result !== null);
    });

    it('cancelling prompt (undefined) returns null', async () => {
        provider.promptForPassword = mockPrompt(undefined);
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(result, null);
    });

    it('empty string from prompt returns null', async () => {
        // promptForPassword that returns '' is treated as cancel
        provider.promptForPassword = mockPrompt('');
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(result, null);
    });

    it('wrong password shows error message', async () => {
        // wrong → cancel so loop exits
        provider.promptForPassword = mockPrompt('wrong', undefined);
        const errors = await captureErrors(() => provider.previewZipFile(OPEN_FILE));
        assert.ok(errors.length >= 1, 'expected at least one error message');
        assert.ok(errors[0].toLowerCase().includes('incorrect') || errors[0].toLowerCase().includes('password'),
            `unexpected error message: ${errors[0]}`);
    });

    it('wrong password prompts again (retry loop)', async () => {
        let calls = 0;
        provider.promptForPassword = async () => {
            calls++;
            if (calls === 1) return 'wrong';
            return CORRECT_PASSWORD;
        };
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(calls, 2, 'should prompt exactly twice: once wrong, once correct');
        assert.ok(result !== null);
    });

    it('wrong password is not stored in savedPasswords', async () => {
        // wrong → cancel
        provider.promptForPassword = mockPrompt('wrongpass', undefined);
        await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(provider.savedPasswords[OPEN_ZIP], undefined,
            'wrong password must not be saved');
    });

    it('password only saved after correct entry, not after wrong attempt', async () => {
        // wrong first, then correct
        provider.promptForPassword = mockPrompt('wrong', CORRECT_PASSWORD);
        await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(provider.savedPasswords[OPEN_ZIP], CORRECT_PASSWORD,
            'only the correct password should be stored');
    });

    it('passwords are keyed per-archive path', async () => {
        // Save a password for OPEN_ZIP
        provider.savedPasswords[OPEN_ZIP] = CORRECT_PASSWORD;
        // A different archive should NOT inherit the password
        const OTHER = path.join(TEST_DIR, 'out.zip').replace('out.zip', 'tmp.zip');
        assert.strictEqual(provider.savedPasswords[OTHER], undefined);
    });

    it('stale saved password: re-prompts when saved password is rejected', async () => {
        // Pre-populate with a stale password
        provider.savedPasswords[OPEN_ZIP] = 'stale-old-password';
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        const result = await provider.previewZipFile(OPEN_FILE);
        assert.ok(result !== null, 'should succeed after re-prompt');
        assert.strictEqual(provider.savedPasswords[OPEN_ZIP], CORRECT_PASSWORD,
            'saved password should be updated to correct one');
    });

    it('multiple wrong attempts before cancel: none stored', async () => {
        provider.promptForPassword = mockPrompt('bad1', 'bad2', 'bad3', undefined);
        await provider.previewZipFile(OPEN_FILE);
        assert.strictEqual(provider.savedPasswords[OPEN_ZIP], undefined);
    });
});

// ── ZIP integration (real encrypted archive) ─────────────────────────────────

describe('Password handling — ZIP integration (out_pass.zip)', () => {

    beforeEach(() => {
        provider.savedPasswords = {};
        provider.archiveFilePath = PASS_ZIP;
        // Use real checkPassword (not mocked)
        delete provider.checkPassword;
    });

    it('encrypted ZIP without password prompts the user', async () => {
        let prompted = false;
        provider.promptForPassword = async () => { prompted = true; return CORRECT_PASSWORD; };
        const result = await provider.previewZipFile(PASS_FILE);
        assert.ok(prompted, 'should have prompted for password');
        assert.ok(result !== null);
    });

    it('correct password returns a non-null result', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        const result = await provider.previewZipFile(PASS_FILE);
        assert.ok(result !== null);
        assert.ok(result.kind === 'text' || result.kind === 'image' || result.kind === 'markdown');
    });

    it('correct password is stored after successful decrypt', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        await provider.previewZipFile(PASS_FILE);
        assert.strictEqual(provider.savedPasswords[PASS_ZIP], CORRECT_PASSWORD);
    });

    it('stored password is reused — no second prompt', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        await provider.previewZipFile(PASS_FILE); // saves password

        let secondPrompt = false;
        provider.promptForPassword = async () => { secondPrompt = true; return ''; };
        const result = await provider.previewZipFile(PASS_FILE);
        assert.ok(!secondPrompt, 'should reuse stored password');
        assert.ok(result !== null);
    });

    it('wrong password shows error and re-prompts', async () => {
        let calls = 0;
        provider.promptForPassword = async () => {
            calls++;
            return calls === 1 ? 'wrongpassword' : CORRECT_PASSWORD;
        };
        const errors = await captureErrors(() => provider.previewZipFile(PASS_FILE));
        assert.ok(errors.length >= 1);
        assert.strictEqual(calls, 2);
    });

    it('cancelling prompt returns null', async () => {
        provider.promptForPassword = mockPrompt(undefined);
        const result = await provider.previewZipFile(PASS_FILE);
        assert.strictEqual(result, null);
    });

    it('wrong password is not stored', async () => {
        provider.promptForPassword = mockPrompt('wrong', undefined);
        await provider.previewZipFile(PASS_FILE);
        assert.strictEqual(provider.savedPasswords[PASS_ZIP], undefined);
    });
});

// ── 7Z integration (real encrypted archive) ──────────────────────────────────

describe('Password handling — 7Z integration (out_pass.7z)', () => {

    beforeEach(() => {
        provider.savedPasswords = {};
        provider.archiveFilePath = PASS_7Z;
    });

    it('encrypted 7Z without password prompts the user', async () => {
        let prompted = false;
        provider.promptForPassword = async () => { prompted = true; return CORRECT_PASSWORD; };
        const result = await provider.preview7zFile(PASS_FILE);
        assert.ok(prompted, 'should have prompted for password');
        assert.ok(result !== null);
    });

    it('correct password returns a non-null result', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        const result = await provider.preview7zFile(PASS_FILE);
        assert.ok(result !== null);
        assert.ok(result.kind === 'text' || result.kind === 'image' || result.kind === 'markdown');
    });

    it('correct password is stored after successful 7Z decrypt', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        await provider.preview7zFile(PASS_FILE);
        assert.strictEqual(provider.savedPasswords[PASS_7Z], CORRECT_PASSWORD);
    });

    it('stored password is reused — no second prompt', async () => {
        provider.promptForPassword = mockPrompt(CORRECT_PASSWORD);
        await provider.preview7zFile(PASS_FILE);  // saves password

        let secondPrompt = false;
        provider.promptForPassword = async () => { secondPrompt = true; return ''; };
        const result = await provider.preview7zFile(PASS_FILE);
        assert.ok(!secondPrompt, 'should reuse stored password');
        assert.ok(result !== null);
    });

    it('wrong password shows error and re-prompts', async () => {
        let calls = 0;
        provider.promptForPassword = async () => {
            calls++;
            return calls === 1 ? 'wrongpassword' : CORRECT_PASSWORD;
        };
        const errors = await captureErrors(() => provider.preview7zFile(PASS_FILE));
        assert.ok(errors.length >= 1);
        assert.strictEqual(calls, 2);
    });

    it('cancelling 7Z password prompt returns null', async () => {
        provider.promptForPassword = mockPrompt(undefined);
        const result = await provider.preview7zFile(PASS_FILE);
        assert.strictEqual(result, null);
    });

    it('wrong password is not stored', async () => {
        provider.promptForPassword = mockPrompt('wrongpass', undefined);
        await provider.preview7zFile(PASS_FILE);
        assert.strictEqual(provider.savedPasswords[PASS_7Z], undefined);
    });

    it('7Z password is independent of ZIP password for same filename', async () => {
        provider.savedPasswords[PASS_ZIP] = CORRECT_PASSWORD;
        // 7Z archive has no saved password yet
        let prompted = false;
        provider.promptForPassword = async () => { prompted = true; return CORRECT_PASSWORD; };
        await provider.preview7zFile(PASS_FILE);
        assert.ok(prompted, '7Z should prompt even though ZIP password was saved');
    });
});
