import * as assert from 'assert';
import JSZip = require('jszip');
import { getDocumentKind, renderOfficeBody } from '../../src/documentPreview';

describe('documentPreview', () => {
    it('detects kinds', () => {
        assert.strictEqual(getDocumentKind('a/b.PDF'), 'pdf');
        assert.strictEqual(getDocumentKind('x.docx'), 'docx');
        assert.strictEqual(getDocumentKind('x.doc'), undefined);
    });

    it('renders xlsx cells and shared strings', async () => {
        const zip = new JSZip();
        zip.file('xl/workbook.xml', '<workbook><sheets><sheet name="S&amp;1" sheetId="1" r:id="rId1"/></sheets></workbook>');
        zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
        zip.file('xl/sharedStrings.xml', '<sst><si><t>日本語</t></si></sst>');
        zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>');
        const html = await renderOfficeBody(await zip.generateAsync({ type: 'nodebuffer' }), 'xlsx');
        assert.ok(html.includes('S&amp;1'));
        assert.ok(html.includes('<td>日本語</td><td></td><td>42</td>'));
    });

    it('renders pptx slide text in order', async () => {
        const zip = new JSZip();
        zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>');
        zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>One</a:t></a:r></a:p></p:sld>');
        const html = await renderOfficeBody(await zip.generateAsync({ type: 'nodebuffer' }), 'pptx');
        assert.ok(html.indexOf('One') < html.indexOf('Two'));
    });
});

describe('decodeTextPreview', () => {
    let provider: any;
    before(() => {
        const fakeVscode = require('vscode');
        const mod = require('../../src/extension');
        let captured: any;
        const orig = fakeVscode.window.registerCustomEditorProvider;
        fakeVscode.window.registerCustomEditorProvider = (_id: string, p: any) => { captured = p; return { dispose: () => {} }; };
        mod.activate({ subscriptions: [] });
        fakeVscode.window.registerCustomEditorProvider = orig;
        provider = new captured.constructor({ subscriptions: [] });
    });

    it('decodes UTF-8', () => {
        assert.strictEqual(provider.decodeTextPreview(Buffer.from('日本語\nabc\n'), 1), '日本語');
    });

    it('falls back to Shift_JIS', () => {
        assert.strictEqual(provider.decodeTextPreview(Buffer.from('82a082a2', 'hex'), 5), 'あい');
    });

    it('does not break on a multibyte character cut at the end', () => {
        const full = Buffer.from('日本語\nあ');
        assert.strictEqual(provider.decodeTextPreview(full.subarray(0, full.length - 1), 1), '日本語');
    });

    it('reports binary data instead of garbage', () => {
        assert.ok(provider.decodeTextPreview(Buffer.from([0xd0, 0xcf, 0x11, 0, 0, 1]), 5).includes('Binary'));
    });
});
