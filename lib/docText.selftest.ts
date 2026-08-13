// lib/docText.selftest.ts — run: npx tsx lib/docText.selftest.ts
//
// These parsers turn someone's document into what the app shows them. Dropping
// or garbling text here silently misrepresents the file, so the shapes that
// actually appear in Office XML are asserted rather than eyeballed.

import { zipSync, strToU8, zlibSync } from 'fflate';
import {
  decodeEntities, docKind, docxText, pptxSlideText, xlsxSheetText,
  orderedSheetPaths, orderedSlidePaths, extractDocText,
  pdfLiteral, pdfStreamText, pdfText,
} from './docText';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('\nDocument text extraction self-test\n');

// ── kind detection ─────────────────────────────────────────────────────
eq('docx detected', docKind('Report.DOCX'), 'docx');
eq('xlsx detected', docKind('books.xlsx'), 'xlsx');
eq('pptx detected', docKind('deck.pptx'), 'pptx');
eq('legacy .doc is NOT claimed', docKind('old.doc'), 'unsupported');

// ── entities ───────────────────────────────────────────────────────────
eq('entities decode', decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#233;'), 'a & b <c> "d" é');
// &amp; must be decoded LAST or "&amp;lt;" turns into "<" instead of "&lt;".
eq('ampersand decoded last', decodeEntities('&amp;lt;'), '&lt;');

// ── docx ───────────────────────────────────────────────────────────────
const docx = `<w:document><w:body>
<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>
<w:p><w:r><w:t>Second</w:t></w:r><w:br/><w:r><w:t>after break</w:t></w:r></w:p>
<w:p></w:p>
<w:p><w:r><w:t>Third &amp; last</w:t></w:r></w:p>
</w:body></w:document>`;
const dt = docxText(docx);
check('runs join without a gap', dt.startsWith('Hello world'), dt);
check('paragraphs are separated', dt.includes('Hello world\n'), JSON.stringify(dt));
check('<w:br/> becomes a newline', dt.includes('Second\nafter break'), JSON.stringify(dt));
check('entities decoded in body', dt.includes('Third & last'));
check('no XML tag survives', !/[<>]/.test(dt.replace(/&/g, '')), dt);

// ── pptx ───────────────────────────────────────────────────────────────
eq('slide text runs are collected',
  pptxSlideText('<p:sld><a:t>Title</a:t><a:t>Bullet one</a:t></p:sld>'),
  'Title\nBullet one');

// ── xlsx ───────────────────────────────────────────────────────────────
const shared = ['Name', 'Qty', 'Widget'];
const sheet = `<worksheet><sheetData>
<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>
<row><c t="s"><v>2</v></c><c><v>42</v></c></row>
</sheetData></worksheet>`;
eq('shared strings resolve, numbers pass through',
  xlsxSheetText(sheet, shared), 'Name\tQty\nWidget\t42');
eq('a fully empty row is dropped',
  xlsxSheetText('<sheetData><row><c/><c/></row></sheetData>', shared), '');

// ── ordering: sheet10 must not sort before sheet2 ──────────────────────
eq('sheets order numerically',
  orderedSheetPaths(['xl/worksheets/sheet10.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet1.xml']),
  ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet10.xml']);
eq('slides order numerically',
  orderedSlidePaths(['ppt/slides/slide10.xml', 'ppt/slides/slide9.xml']),
  ['ppt/slides/slide9.xml', 'ppt/slides/slide10.xml']);
eq('unrelated zip entries are ignored',
  orderedSheetPaths(['xl/styles.xml', 'docProps/app.xml']), []);

// ── end to end, through a REAL zip ─────────────────────────────────────
const realDocx = zipSync({ 'word/document.xml': strToU8(docx) });
const out = extractDocText(realDocx, 'note.docx');
check('a real .docx zip extracts', out.text.includes('Hello world') && !out.empty, out.text);

const emptyDocx = zipSync({ 'word/document.xml': strToU8('<w:document><w:body></w:body></w:document>') });
check('an empty document reports empty', extractDocText(emptyDocx, 'e.docx').empty);

// A non-zip must fail with a readable message, not a stack trace.
let msg = '';
try { extractDocText(strToU8('not a zip at all'), 'x.docx'); } catch (e: any) { msg = e.message; }
check('garbage input fails cleanly', /not a readable document/i.test(msg), msg);

let msg2 = '';
try { extractDocText(realDocx, 'legacy.doc'); } catch (e: any) { msg2 = e.message; }
check('legacy .doc is refused with a reason', /docx/i.test(msg2), msg2);

// ── PDF ────────────────────────────────────────────────────────────────
eq('pdf detected', docKind('invoice.PDF'), 'pdf');
eq('pdf escapes decode', pdfLiteral(String.raw`a\(b\)c\\d`), 'a(b)c\\d');
eq('pdf octal decodes', pdfLiteral(String.raw`\101\102`), 'AB');
eq('Tj text is collected', pdfStreamText('BT (Hello) Tj ET'), 'Hello');
eq('TJ array joins; a big negative kern becomes a space',
  pdfStreamText('BT [(Hel) -20 (lo) -300 (World)] TJ ET'), 'Hello World');
check('Td starts a new line',
  pdfStreamText('BT (one) Tj 0 -14 Td (two) Tj ET').includes('one\ntwo'),
  JSON.stringify(pdfStreamText('BT (one) Tj 0 -14 Td (two) Tj ET')));

// A real, minimal PDF whose content stream is Flate-compressed — the shape
// almost every generator emits, and the one the extractor must handle.
function makePdf(text: string): Uint8Array {
  const comp = zlibSync(strToU8(`BT /F1 12 Tf 72 700 Td (${text}) Tj ET`));
  const head = strToU8(
    `%PDF-1.4\n1 0 obj\n<< /Length ${comp.length} /Filter /FlateDecode >>\nstream\n`);
  const tail = strToU8('\nendstream\nendobj\n%%EOF\n');
  const out = new Uint8Array(head.length + comp.length + tail.length);
  out.set(head, 0); out.set(comp, head.length); out.set(tail, head.length + comp.length);
  return out;
}
eq('a real Flate-compressed PDF extracts', pdfText(makePdf('Invoice total 42')), 'Invoice total 42');
check('a PDF with no text stream yields nothing',
  pdfText(strToU8('%PDF-1.4\ntrailer<<>>\n%%EOF')) === '');
const pdfOut = extractDocText(makePdf('Readable'), 'doc.pdf');
check('extractDocText handles .pdf', pdfOut.text === 'Readable' && !pdfOut.empty, pdfOut.text);
// A scanned page has no text layer — must report empty so the caller offers
// the device's PDF app rather than showing a blank screen.
check('an image-only PDF reports empty',
  extractDocText(strToU8('%PDF-1.4\n%%EOF'), 'scan.pdf').empty);

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all docText checks passed\n');
process.exit(failures ? 1 : 0);
