import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// ---- DOM helper ----

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

const SAMPLE_ENTRIES = [
    {
        name: 'folder', size: 0, time: Date.now(), isDirectory: true, date: new Date(),
        children: [
            { name: 'nested.txt', size: 50, time: Date.now(), isDirectory: false, date: new Date(), children: [] }
        ]
    },
    { name: 'file1.txt', size: 100, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
    { name: 'file2.txt', size: 200, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
    { name: 'file3.png', size: 300, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
    { name: 'readme.md', size: 400, time: Date.now(), isDirectory: false, date: new Date(), children: [] },
];

function buildDOM(): { dom: JSDOM; msgs: any[] } {
    const html = provider.getWebviewContent(SAMPLE_ENTRIES);
    const msgs: any[] = [];

    // beforeParse runs before any script in the HTML executes,
    // so acquireVsCodeApi is available when the inline <script> runs.
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(window: any) {
            window.acquireVsCodeApi = () => ({
                postMessage: (msg: any) => msgs.push(msg)
            });
        }
    } as any);

    // JSDOM does not fire DOMContentLoaded automatically — dispatch it manually
    // so that the click/keyboard event listeners registered inside that callback are set up.
    dom.window.document.dispatchEvent(
        new dom.window.Event('DOMContentLoaded', { bubbles: false })
    );

    return { dom, msgs };
}

function click(el: Element) {
    el.dispatchEvent(new (el.ownerDocument!.defaultView!.MouseEvent)('click', { bubbles: true, cancelable: true }));
}

function mousedown(el: Element) {
    el.dispatchEvent(new (el.ownerDocument!.defaultView!.MouseEvent)('mousedown', { bubbles: true, cancelable: true, button: 0 }));
}

function mouseup(el: Element) {
    el.dispatchEvent(new (el.ownerDocument!.defaultView!.MouseEvent)('mouseup', { bubbles: true, cancelable: true, button: 0 }));
}

function keydown(doc: Document, key: string) {
    doc.dispatchEvent(new (doc.defaultView!.KeyboardEvent)('keydown', { key, bubbles: true, cancelable: true }));
}

function fileRows(dom: JSDOM): Element[] {
    return Array.from(dom.window.document.querySelectorAll('.file-info-row'));
}

function visibleFileRows(dom: JSDOM): Element[] {
    return fileRows(dom).filter(r => {
        let el = r.parentElement;
        while (el) {
            if (el.classList.contains('nested') && !el.classList.contains('active')) return false;
            el = el.parentElement;
        }
        return true;
    });
}

// ---- Tests ----

// Helper: find the row for readme.md (markdown file)
function markdownRow(dom: JSDOM): Element {
    return Array.from(dom.window.document.querySelectorAll('.file-info-row'))
        .find(r => r.getAttribute('data-uri')?.endsWith('.md'))!;
}

describe('Webview: mousedown/mouseup preview (non-markdown)', () => {
    it('mousedown on a text file row sends previewFile message', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        mousedown(rows[0]); // file1.txt
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].command, 'previewFile');
        assert.ok(msgs[0].fileUri, 'fileUri should be set');
    });

    it('mouseup after mousedown sends closePreview', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        mousedown(rows[0]);
        mouseup(dom.window.document.body);
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[0].command, 'previewFile');
        assert.strictEqual(msgs[1].command, 'closePreview');
    });

    it('mousedown adds .selected class to the row', () => {
        const { dom } = buildDOM();
        const rows = fileRows(dom);
        mousedown(rows[0]);
        assert.ok(rows[0].classList.contains('selected'));
    });

    it('mouseup removes .selected class', () => {
        const { dom } = buildDOM();
        const rows = fileRows(dom);
        mousedown(rows[0]);
        mouseup(dom.window.document.body);
        assert.ok(!rows[0].classList.contains('selected'));
    });

    it('mousedown on a different row switches selection', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        mousedown(rows[0]);
        mousedown(rows[1]);
        assert.strictEqual(msgs[0].command, 'previewFile');
        assert.strictEqual(msgs[1].command, 'previewFile');
        assert.notStrictEqual(msgs[0].fileUri, msgs[1].fileUri);
        assert.ok(!rows[0].classList.contains('selected'));
        assert.ok(rows[1].classList.contains('selected'));
    });

    it('mouseup with no active preview does not send closePreview', () => {
        const { dom, msgs } = buildDOM();
        mouseup(dom.window.document.body);
        assert.strictEqual(msgs.length, 0);
    });

    it('mousedown on a checkbox does NOT trigger previewFile', () => {
        const { dom, msgs } = buildDOM();
        const checkbox = dom.window.document.querySelector('.file-info-row .checkbox') as Element;
        mousedown(checkbox);
        assert.ok(!msgs.some(m => m.command === 'previewFile'));
    });

    it('click on a non-markdown file does NOT send previewFile', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]); // file1.txt
        assert.strictEqual(msgs.length, 0);
    });
});

describe('Webview: click-to-toggle preview (markdown)', () => {
    it('click on a markdown row sends previewFile message', () => {
        const { dom, msgs } = buildDOM();
        const row = markdownRow(dom);
        click(row);
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].command, 'previewFile');
        assert.ok(msgs[0].fileUri?.endsWith('.md'));
    });

    it('click on same markdown file again sends closePreview', () => {
        const { dom, msgs } = buildDOM();
        const row = markdownRow(dom);
        click(row);
        click(row);
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[0].command, 'previewFile');
        assert.strictEqual(msgs[1].command, 'closePreview');
    });

    it('click adds .selected class to markdown row', () => {
        const { dom } = buildDOM();
        const row = markdownRow(dom);
        click(row);
        assert.ok(row.classList.contains('selected'));
    });

    it('click on same markdown file removes .selected class', () => {
        const { dom } = buildDOM();
        const row = markdownRow(dom);
        click(row);
        click(row);
        assert.ok(!row.classList.contains('selected'));
    });

    it('mousedown on a markdown file does NOT send previewFile', () => {
        const { dom, msgs } = buildDOM();
        const row = markdownRow(dom);
        mousedown(row);
        assert.strictEqual(msgs.length, 0);
    });

    it('mouseup after markdown mousedown does NOT send closePreview', () => {
        const { dom, msgs } = buildDOM();
        const row = markdownRow(dom);
        mousedown(row);
        mouseup(dom.window.document.body);
        assert.strictEqual(msgs.length, 0);
    });
});

describe('Webview: arrow key navigation', () => {
    it('ArrowDown from no selection selects first visible file', () => {
        const { dom, msgs } = buildDOM();
        keydown(dom.window.document, 'ArrowDown');
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].command, 'previewFile');
    });

    it('ArrowUp from no selection selects first visible file', () => {
        const { dom, msgs } = buildDOM();
        keydown(dom.window.document, 'ArrowUp');
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].command, 'previewFile');
    });

    it('ArrowDown moves selection to next file', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        mousedown(rows[0]); // file1.txt — non-markdown, use mousedown
        keydown(dom.window.document, 'ArrowDown');
        assert.strictEqual(msgs[1].command, 'previewFile');
        assert.notStrictEqual(msgs[1].fileUri, msgs[0].fileUri);
        assert.ok(rows[1].classList.contains('selected'));
        assert.ok(!rows[0].classList.contains('selected'));
    });

    it('ArrowUp moves selection to previous file', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        mousedown(rows[1]); // select second visible file
        keydown(dom.window.document, 'ArrowUp');
        assert.strictEqual(msgs[1].command, 'previewFile');
        assert.strictEqual(msgs[1].fileUri, rows[0].getAttribute('data-uri'));
    });

    it('ArrowDown at last file does not send extra message', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        // Navigate to last row via ArrowDown from first
        mousedown(rows[0]);
        for (let i = 0; i < rows.length - 1; i++) keydown(dom.window.document, 'ArrowDown');
        const countBefore = msgs.length;
        keydown(dom.window.document, 'ArrowDown');
        assert.strictEqual(msgs.length, countBefore); // no new message
    });

    it('ArrowUp at first file does not send extra message', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        mousedown(rows[0]); // select first visible file
        const countBefore = msgs.length;
        keydown(dom.window.document, 'ArrowUp');
        assert.strictEqual(msgs.length, countBefore);
    });

    it('nested files inside collapsed folder are skipped by arrow keys', () => {
        const { dom, msgs } = buildDOM();
        // folder is collapsed by default (no .active on .nested)
        // visible rows should only be top-level files + folder header (no .file-info-row for folder)
        keydown(dom.window.document, 'ArrowDown');
        const firstUri = msgs[0].fileUri;
        // nested.txt is inside a collapsed folder — should NOT be navigated to
        assert.ok(!firstUri.includes('nested.txt'));
    });

    it('nested files inside expanded folder are reachable', () => {
        const { dom, msgs } = buildDOM();
        // Expand the folder by clicking the caret
        const caret = dom.window.document.querySelector('.caret') as Element;
        click(caret);
        // Now navigate through all visible rows
        const visibleRows = fileRows(dom).filter(r => {
            let el = r.parentElement;
            while (el) {
                if (el.classList.contains('nested') && !el.classList.contains('active')) return false;
                el = el.parentElement;
            }
            return true;
        });
        // Navigate down through all visible files
        for (let i = 0; i < visibleRows.length; i++) {
            keydown(dom.window.document, 'ArrowDown');
        }
        const uris = msgs.map(m => m.fileUri);
        assert.ok(uris.some(u => u && u.includes('nested.txt')), 'nested.txt should be reachable when folder is expanded');
    });

    it('other keys do not trigger preview', () => {
        const { dom, msgs } = buildDOM();
        keydown(dom.window.document, 'Enter');
        keydown(dom.window.document, 'Escape');
        keydown(dom.window.document, 'ArrowLeft');
        keydown(dom.window.document, 'ArrowRight');
        assert.strictEqual(msgs.length, 0);
    });
});

// ---- Checkbox behavior ----

function fileCheckboxFor(dom: JSDOM, name: string): HTMLInputElement {
    // Files use `.file > .file-info-row > .checkbox`
    const rows = Array.from(dom.window.document.querySelectorAll('.file .file-info-row')) as Element[];
    for (const row of rows) {
        const nameSpan = row.querySelector('.file-name');
        if (nameSpan && nameSpan.textContent === name) {
            return row.querySelector('.checkbox') as HTMLInputElement;
        }
    }
    throw new Error(`file checkbox not found: ${name}`);
}

function folderCheckboxFor(dom: JSDOM, name: string): HTMLInputElement {
    // Folders use `.folder > .file-info > .checkbox`
    const folders = Array.from(dom.window.document.querySelectorAll('.folder > .file-info')) as Element[];
    for (const info of folders) {
        const nameSpan = info.querySelector('.caret');
        if (nameSpan && nameSpan.textContent === name) {
            return info.querySelector('.checkbox') as HTMLInputElement;
        }
    }
    throw new Error(`folder checkbox not found: ${name}`);
}

function toggleCheckbox(cb: HTMLInputElement) {
    // .click() on an input[type=checkbox] flips checked AND fires change event
    cb.click();
}

function selectionCount(dom: JSDOM): number {
    return parseInt(dom.window.document.getElementById('selectedCount')!.textContent || '0');
}

describe('Webview: checkbox — file independence', () => {
    it('checking a single file checkbox does NOT select siblings', () => {
        const { dom } = buildDOM();
        const file1 = fileCheckboxFor(dom, 'file1.txt');
        const file2 = fileCheckboxFor(dom, 'file2.txt');
        const file3 = fileCheckboxFor(dom, 'file3.png');

        toggleCheckbox(file1);

        assert.strictEqual(file1.checked, true, 'file1 should be checked');
        assert.strictEqual(file2.checked, false, 'file2 must not be auto-checked');
        assert.strictEqual(file3.checked, false, 'file3 must not be auto-checked');
    });

    it('checking a single file does NOT select files in unrelated folders', () => {
        const { dom } = buildDOM();
        const file1 = fileCheckboxFor(dom, 'file1.txt');
        const nested = fileCheckboxFor(dom, 'nested.txt');

        toggleCheckbox(file1);

        assert.strictEqual(file1.checked, true);
        assert.strictEqual(nested.checked, false, 'nested file in folder/ must not be auto-checked');
    });

    it('unchecking a single file does NOT uncheck other files', () => {
        const { dom } = buildDOM();
        const file1 = fileCheckboxFor(dom, 'file1.txt');
        const file2 = fileCheckboxFor(dom, 'file2.txt');

        toggleCheckbox(file1); // check
        toggleCheckbox(file2); // check
        assert.strictEqual(selectionCount(dom), 2);

        toggleCheckbox(file1); // uncheck

        assert.strictEqual(file1.checked, false);
        assert.strictEqual(file2.checked, true, 'unchecking file1 must not affect file2');
        assert.strictEqual(selectionCount(dom), 1);
    });

    it('checking a nested file does NOT check its parent folder', () => {
        const { dom } = buildDOM();
        const nested = fileCheckboxFor(dom, 'nested.txt');
        const folder = folderCheckboxFor(dom, 'folder');

        toggleCheckbox(nested);

        assert.strictEqual(nested.checked, true);
        assert.strictEqual(folder.checked, false, 'parent folder must not be auto-checked');
    });

    it('selection count is exactly 1 when checking a single file', () => {
        const { dom } = buildDOM();
        toggleCheckbox(fileCheckboxFor(dom, 'file1.txt'));
        assert.strictEqual(selectionCount(dom), 1);
    });
});

describe('Webview: checkbox — folder cascade', () => {
    it('checking a folder cascades to all descendant files', () => {
        const { dom } = buildDOM();
        const folder = folderCheckboxFor(dom, 'folder');
        const nested = fileCheckboxFor(dom, 'nested.txt');

        toggleCheckbox(folder);

        assert.strictEqual(folder.checked, true);
        assert.strictEqual(nested.checked, true, 'descendant file should be checked');
    });

    it('checking a folder does NOT check unrelated top-level files', () => {
        const { dom } = buildDOM();
        const folder = folderCheckboxFor(dom, 'folder');
        const file1 = fileCheckboxFor(dom, 'file1.txt');

        toggleCheckbox(folder);

        assert.strictEqual(folder.checked, true);
        assert.strictEqual(file1.checked, false, 'top-level file outside folder must not be checked');
    });

    it('unchecking a folder cascades unchecking to descendants', () => {
        const { dom } = buildDOM();
        const folder = folderCheckboxFor(dom, 'folder');
        const nested = fileCheckboxFor(dom, 'nested.txt');

        toggleCheckbox(folder); // check (cascades)
        assert.strictEqual(nested.checked, true);

        toggleCheckbox(folder); // uncheck (should cascade uncheck)

        assert.strictEqual(folder.checked, false);
        assert.strictEqual(nested.checked, false, 'descendants should be unchecked');
    });

    it('selection count includes the folder itself plus all descendants', () => {
        const { dom } = buildDOM();
        toggleCheckbox(folderCheckboxFor(dom, 'folder'));
        // folder + nested.txt = 2
        assert.strictEqual(selectionCount(dom), 2);
    });
});

describe('Webview: checkbox — parent uncheck on child uncheck', () => {
    it('unchecking a child file unchecks its parent folder', () => {
        const { dom } = buildDOM();
        const folder = folderCheckboxFor(dom, 'folder');
        const nested = fileCheckboxFor(dom, 'nested.txt');

        toggleCheckbox(folder); // cascades — folder + nested checked
        assert.strictEqual(folder.checked, true);
        assert.strictEqual(nested.checked, true);

        toggleCheckbox(nested); // uncheck child

        assert.strictEqual(nested.checked, false, 'child should be unchecked');
        assert.strictEqual(folder.checked, false, 'parent folder must be auto-unchecked');
    });

    it('unchecking a child file does NOT uncheck unrelated top-level files', () => {
        const { dom } = buildDOM();
        // Select everything
        toggleCheckbox(folderCheckboxFor(dom, 'folder'));
        toggleCheckbox(fileCheckboxFor(dom, 'file1.txt'));
        toggleCheckbox(fileCheckboxFor(dom, 'file2.txt'));

        const file1 = fileCheckboxFor(dom, 'file1.txt');
        const file2 = fileCheckboxFor(dom, 'file2.txt');
        const nested = fileCheckboxFor(dom, 'nested.txt');

        // Uncheck the file inside folder
        toggleCheckbox(nested);

        // Unrelated top-level files should remain checked
        assert.strictEqual(file1.checked, true, 'top-level file1 should remain checked');
        assert.strictEqual(file2.checked, true, 'top-level file2 should remain checked');
    });

    it('selection count reflects parent uncheck after child uncheck', () => {
        const { dom } = buildDOM();
        toggleCheckbox(folderCheckboxFor(dom, 'folder')); // folder + nested = 2
        assert.strictEqual(selectionCount(dom), 2);

        toggleCheckbox(fileCheckboxFor(dom, 'nested.txt')); // uncheck nested → also unchecks folder

        // Both nested AND folder are now unchecked → count = 0
        assert.strictEqual(selectionCount(dom), 0);
    });

    it('unchecking the folder itself does not need to walk further (no grandparent)', () => {
        const { dom } = buildDOM();
        const folder = folderCheckboxFor(dom, 'folder');
        toggleCheckbox(folder);
        toggleCheckbox(folder); // back to unchecked
        assert.strictEqual(folder.checked, false);
        assert.strictEqual(selectionCount(dom), 0);
    });
});

describe('Webview: Select All / Clear Selection', () => {
    function clickButton(dom: JSDOM, label: string) {
        const buttons = Array.from(dom.window.document.querySelectorAll('button')) as HTMLButtonElement[];
        const btn = buttons.find(b => b.textContent && b.textContent.includes(label));
        if (!btn) throw new Error(`button not found: ${label}`);
        btn.click();
    }

    it('Select All checks every checkbox', () => {
        const { dom } = buildDOM();
        clickButton(dom, 'Select All');
        const all = dom.window.document.querySelectorAll('.checkbox');
        all.forEach(cb => assert.strictEqual((cb as HTMLInputElement).checked, true));
    });

    it('Clear Selection unchecks every checkbox', () => {
        const { dom } = buildDOM();
        clickButton(dom, 'Select All');
        clickButton(dom, 'Clear Selection');
        const all = dom.window.document.querySelectorAll('.checkbox');
        all.forEach(cb => assert.strictEqual((cb as HTMLInputElement).checked, false));
        assert.strictEqual(selectionCount(dom), 0);
    });

    it('Extract button is disabled when nothing is selected', () => {
        const { dom } = buildDOM();
        const btn = dom.window.document.getElementById('extractBtn') as HTMLButtonElement;
        assert.strictEqual(btn.disabled, true);
    });

    it('Extract button becomes enabled after checking a file', () => {
        const { dom } = buildDOM();
        toggleCheckbox(fileCheckboxFor(dom, 'file1.txt'));
        const btn = dom.window.document.getElementById('extractBtn') as HTMLButtonElement;
        assert.strictEqual(btn.disabled, false);
    });
});
