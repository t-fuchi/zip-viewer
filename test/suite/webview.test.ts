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

describe('Webview: click-to-toggle preview', () => {
    it('clicking a file row sends previewFile message', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        assert.strictEqual(msgs.length, 1);
        assert.strictEqual(msgs[0].command, 'previewFile');
        assert.ok(msgs[0].fileUri, 'fileUri should be set');
    });

    it('clicking the same file row again sends closePreview', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        click(rows[0]);
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[1].command, 'closePreview');
    });

    it('clicking a different file row switches preview', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        click(rows[1]);
        assert.strictEqual(msgs.length, 2);
        assert.strictEqual(msgs[1].command, 'previewFile');
        assert.notStrictEqual(msgs[1].fileUri, msgs[0].fileUri);
    });

    it('first click adds .selected class to the row', () => {
        const { dom, msgs: _ } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        assert.ok(rows[0].classList.contains('selected'));
    });

    it('second click on same row removes .selected class', () => {
        const { dom, msgs: _ } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        click(rows[0]);
        assert.ok(!rows[0].classList.contains('selected'));
    });

    it('selecting a new row moves .selected to new row', () => {
        const { dom, msgs: _ } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        click(rows[1]);
        assert.ok(!rows[0].classList.contains('selected'));
        assert.ok(rows[1].classList.contains('selected'));
    });

    it('clicking outside file rows sends closePreview', () => {
        const { dom, msgs } = buildDOM();
        const rows = fileRows(dom);
        click(rows[0]);
        // click on body (outside any .file-info-row)
        click(dom.window.document.body);
        assert.ok(msgs.some(m => m.command === 'closePreview'));
    });

    it('clicking a checkbox does NOT trigger previewFile', () => {
        const { dom, msgs } = buildDOM();
        const checkbox = dom.window.document.querySelector('.file-info-row .checkbox') as Element;
        click(checkbox);
        assert.ok(!msgs.some(m => m.command === 'previewFile'));
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
        click(rows[0]);
        keydown(dom.window.document, 'ArrowDown');
        assert.strictEqual(msgs[1].command, 'previewFile');
        assert.notStrictEqual(msgs[1].fileUri, msgs[0].fileUri);
        assert.ok(rows[1].classList.contains('selected'));
        assert.ok(!rows[0].classList.contains('selected'));
    });

    it('ArrowUp moves selection to previous file', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        click(rows[1]); // select second visible file
        keydown(dom.window.document, 'ArrowUp');
        assert.strictEqual(msgs[1].command, 'previewFile');
        assert.strictEqual(msgs[1].fileUri, rows[0].getAttribute('data-uri'));
    });

    it('ArrowDown at last file does not send extra message', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        click(rows[rows.length - 1]);
        const countBefore = msgs.length;
        keydown(dom.window.document, 'ArrowDown');
        assert.strictEqual(msgs.length, countBefore); // no new message
    });

    it('ArrowUp at first file does not send extra message', () => {
        const { dom, msgs } = buildDOM();
        const rows = visibleFileRows(dom);
        click(rows[0]); // select first visible file
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
