import * as path from 'path';

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 60;

export function getDocumentKind(filename: string): DocumentKind | undefined {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.pdf': return 'pdf';
        case '.docx': return 'docx';
        case '.xlsx': return 'xlsx';
        case '.pptx': return 'pptx';
        default: return undefined;
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXml(text: string): string {
    return text
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

function collectText(xml: string, tag: string): string {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
    let out = '';
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
        out += decodeXml(m[1]);
    }
    return out;
}

function columnIndex(ref: string): number {
    const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
    let n = 0;
    for (const ch of letters) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}

async function readEntry(zip: any, name: string): Promise<string | null> {
    const f = zip.file(name);
    return f ? f.async('string') : null;
}

async function docxToHtml(buf: Buffer): Promise<string> {
    const mammoth = require('mammoth');
    const result = await mammoth.convertToHtml({ buffer: buf });
    return result.value as string;
}

async function xlsxToHtml(buf: Buffer): Promise<string> {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);

    const sstXml = await readEntry(zip, 'xl/sharedStrings.xml');
    const shared: string[] = [];
    if (sstXml) {
        const re = /<si>([\s\S]*?)<\/si>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sstXml)) !== null) {
            shared.push(collectText(m[1], 't'));
        }
    }

    const wbXml = (await readEntry(zip, 'xl/workbook.xml')) ?? '';
    const relsXml = (await readEntry(zip, 'xl/_rels/workbook.xml.rels')) ?? '';
    const targets = new Map<string, string>();
    for (const m of relsXml.matchAll(/<Relationship\b([^>]*)>/g)) {
        const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
        const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
        if (id && target) {
            targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
        }
    }

    let html = '';
    for (const m of wbXml.matchAll(/<sheet\b([^>]*)>/g)) {
        const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? 'Sheet');
        const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1];
        const sheetPath = rid ? targets.get(rid) : undefined;
        const sheetXml = sheetPath ? await readEntry(zip, sheetPath) : null;
        html += `<h2>${escapeHtml(name)}</h2>`;
        if (!sheetXml) {
            continue;
        }

        let rowsHtml = '';
        let rowCount = 0;
        let truncated = false;
        for (const rm of sheetXml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
            if (rowCount >= MAX_SHEET_ROWS) {
                truncated = true;
                break;
            }
            rowCount++;
            const cells: string[] = [];
            for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const attrs = cm[1];
                const body = cm[2] ?? '';
                const col = columnIndex(/\br="([^"]*)"/.exec(attrs)?.[1] ?? 'A');
                if (col >= MAX_SHEET_COLS) {
                    continue;
                }
                const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
                let value = '';
                if (type === 'inlineStr') {
                    value = collectText(body, 't');
                } else {
                    const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
                    value = type === 's' ? (shared[parseInt(v, 10)] ?? '') : decodeXml(v);
                }
                while (cells.length < col) {
                    cells.push('');
                }
                cells[col] = value;
            }
            rowsHtml += `<tr><th class="rn">${rowCount}</th>${cells.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
        }
        html += `<table>${rowsHtml}</table>`;
        if (truncated) {
            html += `<p class="note">Showing first ${MAX_SHEET_ROWS} rows.</p>`;
        }
    }
    return html || '<p class="note">(empty workbook)</p>';
}

async function pptxToHtml(buf: Buffer): Promise<string> {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(buf);
    const slideNames = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => parseInt(/(\d+)\.xml$/.exec(a)![1], 10) - parseInt(/(\d+)\.xml$/.exec(b)![1], 10));

    let html = '';
    let i = 0;
    for (const name of slideNames) {
        i++;
        const xml = (await readEntry(zip, name)) ?? '';
        const paragraphs: string[] = [];
        for (const pm of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
            const text = collectText(pm[1], 'a:t');
            if (text.trim()) {
                paragraphs.push(`<p>${escapeHtml(text)}</p>`);
            }
        }
        html += `<section class="slide"><div class="slide-no">Slide ${i}</div>${paragraphs.join('') || '<p class="note">(no text)</p>'}</section>`;
    }
    return html || '<p class="note">(no slides)</p>';
}

export async function renderOfficeBody(buf: Buffer, kind: Exclude<DocumentKind, 'pdf'>): Promise<string> {
    switch (kind) {
        case 'docx': return docxToHtml(buf);
        case 'xlsx': return xlsxToHtml(buf);
        case 'pptx': return pptxToHtml(buf);
    }
}

export const OFFICE_PAGE_STYLE = `
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;padding:16px 24px;color:var(--vscode-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e)}
img{max-width:100%;height:auto}
table{border-collapse:collapse;margin-bottom:16px;font-size:12px}
th,td{border:1px solid #555;padding:3px 8px;text-align:left;vertical-align:top}
th.rn{background:rgba(128,128,128,.15);color:#888;text-align:right}
h2{border-bottom:1px solid #444;padding-bottom:.3em}
.note{color:#888;font-size:12px}
.slide{border:1px solid #555;border-radius:4px;padding:8px 16px;margin-bottom:16px}
.slide-no{color:#888;font-size:12px}
`;
