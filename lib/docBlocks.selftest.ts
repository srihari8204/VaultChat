// lib/docBlocks.selftest.ts — run: npx tsx lib/docBlocks.selftest.ts
//
// The structured reader decides what the user SEES: a mis-parsed row puts values
// under the wrong heading, a missed heading flattens a report, and a table parsed
// after the paragraphs silently reorders the document. Each of those is asserted
// here against the XML shapes Word, Excel and PowerPoint actually emit.

import { zipSync, strToU8, zlibSync } from 'fflate';
import {
  docxBlocks, xlsxRows, sheetNames, pptxSlide,
  pdfPageLines, pdfBlocksFromLines, extractDocBlocks, type Block,
} from './docBlocks';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
const txt = (b: Block) => ('runs' in b ? b.runs.map(r => r.text).join('') : '');

console.log('\nStructured document reader self-test\n');

// ── Word ─────────────────────────────────────────────────────────────
console.log('Word keeps its structure');
{
  const xml = `<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Big Title</w:t></w:r></w:p>
<w:p><w:r><w:t>Plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested item</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>H1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>H2</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>After the table</w:t></w:r></w:p>
<w:p><w:r><w:t>Line A</w:t></w:r><w:br/><w:r><w:t>Line B</w:t></w:r></w:p>
</w:body>`;
  const b = docxBlocks(xml);
  eq('block kinds, in document order', b.map(x => x.t),
     ['h', 'p', 'li', 'li', 'table', 'h', 'p']);
  check('a table between paragraphs stays between them', b[4].t === 'table',
        'two passes concatenated would move every table to the end');
  eq('heading level is read from the style', (b[0] as any).level, 1);
  eq('bold is kept per run', (b[1] as any).runs.filter((r: any) => r.b).map((r: any) => r.text), ['bold']);
  eq('italic is kept per run', (b[1] as any).runs.filter((r: any) => r.i).map((r: any) => r.text), ['italic']);
  eq('the paragraph still reads correctly', txt(b[1]), 'Plain bold and italic');
  eq('list indent depth survives', [(b[2] as any).level, (b[3] as any).level], [0, 1]);
  eq('table cells', (b[4] as any).rows, [['H1', 'H2'], ['a', 'b']]);
  check('<w:br/> becomes a newline inside the run', txt(b[6]).includes('Line A\nLine B'),
        JSON.stringify(txt(b[6])));

  // An explicitly-cleared bold must not render bold.
  const off = docxBlocks(`<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>not bold</w:t></w:r></w:p>`);
  check('<w:b w:val="0"/> clears bold rather than setting it',
        !(off[0] as any).runs[0].b, 'a theme that clears bold would render everything bold');

  check('an empty paragraph is dropped', docxBlocks('<w:p></w:p>').length === 0);
}

// ── Excel ────────────────────────────────────────────────────────────
console.log('\nExcel becomes a real grid');
{
  const shared = ['Name', 'Qty', 'Widget'];
  const sheet = `<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>
<row r="3"><c r="C3"><v>99</v></c></row>
</sheetData>`;
  const rows = xlsxRows(sheet, shared);
  eq('shared strings resolve and numbers pass through', rows[0].concat(rows[1]),
     ['Name', 'Qty', '', 'Widget', '42', '']);
  eq('a skipped column keeps its position', rows[2], ['', '', '99']);
  check('every row is padded to the same width',
        new Set(rows.map(r => r.length)).size === 1,
        'a ragged grid cannot be drawn as a rectangle');

  eq('an inline string is read', xlsxRows(
     `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c></row></sheetData>`, []),
     [['Inline']]);
  eq('a fully empty row is dropped',
     xlsxRows('<sheetData><row r="1"><c r="A1"/><c r="B1"/></row></sheetData>', []), []);
  eq('sheet names come from the workbook',
     sheetNames('<sheets><sheet name="Jan Sales" sheetId="1"/><sheet name="Q&amp;A" sheetId="2"/></sheets>'),
     ['Jan Sales', 'Q&A']);
}

// ── PowerPoint ───────────────────────────────────────────────────────
console.log('\nPowerPoint separates title from body');
{
  const slide = `<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>My Title</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:p><a:r><a:t>Bullet one</a:t></a:r></a:p><a:p><a:r><a:t>Bullet </a:t></a:r><a:r><a:t>two</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld>`;
  const b = pptxSlide(slide, 3) as any;
  eq('the title placeholder is the title', b.title, 'My Title');
  eq('body lines, with runs joined per paragraph', b.lines, ['Bullet one', 'Bullet two']);
  eq('the slide keeps its number', b.n, 3);

  const noTitle = pptxSlide(`<p:sp><p:txBody><a:p><a:r><a:t>Only body</a:t></a:r></a:p></p:txBody></p:sp>`, 1) as any;
  eq('a slide with no title placeholder still yields its text', [noTitle.title, noTitle.lines], ['', ['Only body']]);
}

// ── PDF ──────────────────────────────────────────────────────────────
console.log('\nPDF gets pages and headings');
{
  const content = `BT /F1 24 Tf (Invoice 2026) Tj 0 -30 Td /F1 10 Tf (Line one of the body text here) Tj 0 -14 Td (Line two of the body text) Tj ET`;
  const lines = pdfPageLines(content);
  eq('font size is captured per line', lines.map(l => l.size), [24, 10, 10]);
  eq('lines are separated at Td', lines.map(l => l.text),
     ['Invoice 2026', 'Line one of the body text here', 'Line two of the body text']);

  const blocks = pdfBlocksFromLines(lines);
  check('the larger line becomes a heading', blocks[0].t === 'h', JSON.stringify(blocks[0]));
  eq('the heading text', txt(blocks[0]), 'Invoice 2026');
  check('the body is not a heading', blocks.slice(1).every(b => b.t === 'p'),
        JSON.stringify(blocks.map(b => b.t)));

  check('a page with one size yields no bogus headings',
        pdfBlocksFromLines([{ text: 'a', size: 10 }, { text: 'b', size: 10 }]).every(b => b.t === 'p'));
  eq('an empty page yields nothing', pdfBlocksFromLines([]), []);
}

// ── End to end, through real containers ──────────────────────────────
console.log('\nend to end');
{
  const docx = zipSync({ 'word/document.xml': strToU8(
    '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Hello</w:t></w:r></w:p></w:body>') });
  const r = extractDocBlocks(docx, 'a.docx');
  check('a real .docx yields blocks', !r.empty && r.blocks[0].t === 'h', JSON.stringify(r.blocks));

  const xlsx = zipSync({
    'xl/workbook.xml': strToU8('<sheets><sheet name="Data" sheetId="1"/></sheets>'),
    'xl/worksheets/sheet1.xml': strToU8('<sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData>'),
  });
  const rx = extractDocBlocks(xlsx, 'b.xlsx');
  eq('a real .xlsx yields a named sheet',
     [(rx.blocks[0] as any).t, (rx.blocks[0] as any).name, (rx.blocks[0] as any).rows], ['sheet', 'Data', [['7']]]);

  const pptx = zipSync({ 'ppt/slides/slide1.xml': strToU8(
    '<p:sp><p:txBody><a:p><a:r><a:t>Deck</a:t></a:r></a:p></p:txBody></p:sp>') });
  check('a real .pptx yields a slide', (extractDocBlocks(pptx, 'c.pptx').blocks[0] as any).t === 'slide');

  // The PDF path, through a genuinely Flate-compressed stream.
  const comp = zlibSync(strToU8('BT /F1 12 Tf (Readable) Tj ET'));
  const head = strToU8(`%PDF-1.4\n1 0 obj\n<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`);
  const tail = strToU8('\nendstream\nendobj\n%%EOF\n');
  const pdf = new Uint8Array(head.length + comp.length + tail.length);
  pdf.set(head, 0); pdf.set(comp, head.length); pdf.set(tail, head.length + comp.length);
  const rp = extractDocBlocks(pdf, 'd.pdf');
  eq('a real .pdf yields a page marker then its text',
     [rp.blocks[0].t, txt(rp.blocks[1])], ['page', 'Readable']);

  check('an empty document reports empty',
        extractDocBlocks(zipSync({ 'word/document.xml': strToU8('<w:body></w:body>') }), 'e.docx').empty);

  let msg = '';
  try { extractDocBlocks(strToU8('not a zip'), 'x.docx'); } catch (e: any) { msg = e.message; }
  check('garbage fails with a message written for a person', /not a readable document/i.test(msg), msg);

  let msg2 = '';
  try { extractDocBlocks(new Uint8Array(4), 'old.doc'); } catch (e: any) { msg2 = e.message; }
  check('legacy .doc is refused', /docx/i.test(msg2), msg2);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
