// lib/docText.selftest.ts — run: npx tsx lib/docText.selftest.ts
//
// These parsers turn someone's document into what the app shows them. Dropping
// or garbling text here silently misrepresents the file, so the shapes that
// actually appear in Office XML are asserted rather than eyeballed.

import { zipSync, strToU8, strFromU8, zlibSync } from 'fflate';
import {
  decodeEntities, docKind, docxText, pptxSlideText, xlsxSheetText,
  orderedSheetPaths, orderedSlidePaths, extractDocText,
  pdfLiteral, pdfStreamText, pdfText, ascii85Decode, colIndexFromRef,
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

// Excel OMITS an empty cell rather than writing a blank one, so the `r=`
// reference is the ONLY thing that says which column a value belongs to.
// Ignoring it shifted every later column one place left and a header stopped
// lining up with its own data — on the sheets most likely to have a gap.
eq('a gap in a row keeps later columns in their own column',
  xlsxSheetText(
    '<sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2"><v>10</v></c><c r="B2"><v>20</v></c><c r="C2"><v>30</v></c></row>' +
    '</sheetData>', ['Name', 'Total']),
  'Name\t\tTotal\n10\t20\t30');
eq('columns past Z resolve', colIndexFromRef('AA'), 27);

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

// ── /Filter is a LIST, and ReportLab always writes two ───────────────────
//
// `/Filter [ /ASCII85Decode /FlateDecode ]` means "un-ascii85, THEN inflate".
// The extractor used to see FlateDecode and inflate the raw bytes, which throws
// on ascii85 text — so the stream was skipped and the document came back with no
// text at all. Every ReportLab PDF is built this way, which is most
// server-generated invoices, statements and tickets.
function a85encode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 4) {
    const n = Math.min(4, b.length - i);
    let v = 0;
    for (let j = 0; j < 4; j++) v = v * 256 + (j < n ? b[i + j] : 0);
    if (v === 0 && n === 4) { out += 'z'; continue; }
    const g: string[] = [];
    for (let j = 0; j < 5; j++) { g.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
    out += g.join('').slice(0, n + 1);
  }
  return out + '~>';
}
function makeA85Pdf(text: string): Uint8Array {
  const a85 = a85encode(zlibSync(strToU8(`BT /F1 12 Tf 72 700 Td (${text}) Tj ET`)));
  return strToU8(
    `%PDF-1.3\n1 0 obj\n<< /Filter [ /ASCII85Decode /FlateDecode ] /Length ${a85.length} >>\n` +
    `stream\n${a85}\nendstream\nendobj\n%%EOF\n`);
}
eq('ASCII85 round-trips', strFromU8(ascii85Decode(a85encode(strToU8('hello world')))!), 'hello world');
eq('a zero group encodes as z and decodes back',
   Array.from(ascii85Decode('z~>')!).join(','), '0,0,0,0');
check('malformed ascii85 is refused, not guessed', ascii85Decode('!~>') === null);
eq('an ASCII85 + Flate chain extracts (ReportLab)',
   pdfText(makeA85Pdf('Statement balance 1234')), 'Statement balance 1234');
check('a PDF with no text stream yields nothing',
  pdfText(strToU8('%PDF-1.4\ntrailer<<>>\n%%EOF')) === '');
const pdfOut = extractDocText(makePdf('Readable'), 'doc.pdf');
check('extractDocText handles .pdf', pdfOut.text === 'Readable' && !pdfOut.empty, pdfOut.text);
// A scanned page has no text layer — must report empty so the caller offers
// the device's PDF app rather than showing a blank screen.
check('an image-only PDF reports empty',
  extractDocText(strToU8('%PDF-1.4\n%%EOF'), 'scan.pdf').empty);

// ── The two ways a PDF turned into pages of mojibake ─────────────────────
//
// Found by running the SHIPPED extractor over 32 real PDFs: 14 came back 60%+
// binary. Both causes are pinned here, because nothing else stops them from
// silently coming back.

// 1. "stream" is six ordinary letters, and compressed bytes contain them by
//    chance. Such a hit has no `/Filter` in its header, so it used to be read
//    as an UNCOMPRESSED content stream and the raw deflate bytes were harvested
//    as text, swamping the real page. A genuine stream always follows `>>`.
function pdfWithBinaryDecoy(text: string): Uint8Array {
  const real = makePdf(text);
  // What a font program or image could plausibly hold: the keyword, a
  // parenthesised run of control characters and a Tj — but no dictionary.
  const decoy = strToU8(
    '\x01\x02\x7fstream\n(\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12) Tj\nendstream\n');
  const out = new Uint8Array(real.length + decoy.length);
  out.set(real, 0); out.set(decoy, real.length);
  return out;
}
eq('binary that merely CONTAINS "stream" is not read as one',
   pdfText(pdfWithBinaryDecoy('Invoice total 42')), 'Invoice total 42');

// 2. A CID-font page IS a real stream, but its glyph codes mean nothing without
//    a /ToUnicode map — emitting them raw is how a bank statement rendered as
//    control characters. Reporting no text layer sends the user to the device's
//    PDF app, which beats showing noise.
const cid = '\x00Q\x00E\x00\x14\x00Q\x00E\x00\x14\x00Q\x00E\x00\x14\x00Q\x00E';
const cidPdf = strToU8(
  `%PDF-1.4\n1 0 obj\n<< /Length 60 >>\nstream\nBT (${cid}) Tj ET\nendstream\nendobj\n%%EOF\n`);
check('a CID stream with no /ToUnicode reports no text, not glyph codes',
  extractDocText(cidPdf, 'statement.pdf').empty);

// …and the gate must not swallow ordinary prose in a non-Latin script.
const telugu = makePdf('హలో ప్రపంచం');
check('non-Latin text is NOT mistaken for binary',
  pdfText(telugu).includes('హలో'), JSON.stringify(pdfText(telugu)));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all docText checks passed\n');
process.exit(failures ? 1 : 0);
