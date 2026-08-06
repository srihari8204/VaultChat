/**
 * Verifies the on-device Office parsers against real OOXML packages.
 * Run: node lib/office/__tests__/parsers.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  ✗ ${name} — ${e.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond, what) {
  if (!cond) throw new Error(what);
}

const { parseWorkbook, columnLabel, cellRef, formatCell } = await import('../dist-test/xlsx.js');
const { parseDocument } = await import('../dist-test/docx.js');
const { parseDeck } = await import('../dist-test/pptx.js');

console.log('\nExcel');
{
  const b64 = readFileSync(join(FIX, 'sample.xlsx.b64'), 'utf8');
  const wb = parseWorkbook(b64);

  check('reads both sheets', () => eq(wb.sheets.map((s) => s.name), ['Revenue', 'Scratch'], 'sheet names'));
  check('detects the hidden sheet', () => eq(wb.hiddenSheetNames, ['Scratch'], 'hidden sheets'));
  check('reads the header row', () =>
    eq(wb.sheets[0].rows[0], ['Region', 'Month', 'Revenue', 'Margin'], 'header'));
  check('keeps numbers as numbers', () => {
    const v = wb.sheets[0].rows[1][2];
    ok(typeof v === 'number' && v === 412800, `revenue cell was ${JSON.stringify(v)}`);
  });
  check('extracts the formula', () => eq(wb.sheets[0].formulas.C6, 'SUM(C2:C5)', 'C6 formula'));
  check('reports grid size', () => {
    ok(wb.sheets[0].rowCount === 6, `rowCount ${wb.sheets[0].rowCount}`);
    ok(wb.sheets[0].colCount === 4, `colCount ${wb.sheets[0].colCount}`);
  });
  check('column labels roll over past Z', () => {
    eq([columnLabel(0), columnLabel(25), columnLabel(26), columnLabel(27)], ['A', 'Z', 'AA', 'AB'], 'labels');
  });
  check('cell refs are 1-based', () => eq(cellRef(13, 3), 'D14', 'cellRef'));
  check('formats numbers with separators', () => eq(formatCell(412800), '412,800', 'format'));
  check('formats empty cells as blank', () => eq(formatCell(null), '', 'format null'));
}

console.log('\nWord');
{
  const b64 = readFileSync(join(FIX, 'sample.docx.b64'), 'utf8');
  const doc = parseDocument(b64);
  const kinds = doc.blocks.map((b) => b.kind);

  check('keeps body order (heading, para, list, table, para)', () =>
    eq(kinds, ['heading', 'paragraph', 'listItem', 'table', 'paragraph'], 'block order'));
  check('reads the heading level', () => eq(doc.blocks[0].level, 1, 'heading level'));
  check('joins runs into one paragraph', () => {
    const text = doc.blocks[1].runs.map((r) => r.text).join('');
    eq(text, 'Enterprise teams exchange more than 60% of documents inside chat.', 'paragraph text');
  });
  check('preserves bold on the middle run', () => {
    const bolded = doc.blocks[1].runs.filter((r) => r.bold).map((r) => r.text);
    eq(bolded, ['more than 60%'], 'bold runs');
  });
  check('reads the table grid', () =>
    eq(doc.blocks[3].rows, [['Segment', 'TAM'], ['Regulated', '2.1B']], 'table rows'));
  check('counts words and estimates pages', () => {
    ok(doc.wordCount > 10, `wordCount ${doc.wordCount}`);
    ok(doc.approxPages >= 1, `approxPages ${doc.approxPages}`);
  });
}

console.log('\nPowerPoint');
{
  const b64 = readFileSync(join(FIX, 'sample.pptx.b64'), 'utf8');
  const deck = parseDeck(b64);

  check('reads every slide', () => eq(deck.slides.length, 2, 'slide count'));
  check('reads slide titles', () =>
    eq(deck.slides.map((s) => s.title), ['Atlas changes how teams ship', 'Rollout'], 'titles'));
  check('reads slide body text', () => eq(deck.slides[0].body, ['Six pilot teams, one quarter.'], 'body'));
  check('reads speaker notes for slide 1', () =>
    eq(deck.slides[0].notes, 'Open with the pilot numbers.', 'notes'));
  check('slide 2 has no notes', () => eq(deck.slides[1].notes, null, 'notes'));
  check('slides keep their numbers', () => eq(deck.slides.map((s) => s.index), [1, 2], 'indices'));
}

console.log('\nError handling');
{
  check('a non-Office file is rejected cleanly', () => {
    let threw = false;
    try {
      parseDeck(Buffer.from('this is not a zip').toString('base64'));
    } catch (e) {
      threw = e.name === 'OfficeParseError';
    }
    ok(threw, 'expected an OfficeParseError');
  });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
