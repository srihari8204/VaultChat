// lib/docs/docStyle.selftest.ts — run: npx tsx lib/docs/docStyle.selftest.ts
//
// The filename is the part that bites. It is typed by a person, then used as a
// real file name AND sent as an attachment name — so a slash or a colon in it
// is a write failure on one platform and a broken download on another, and an
// emptied field would otherwise produce a file called ".pdf".

import {
  DEFAULT_STYLE, DOC_STYLES, defaultDocName, docFilename, docStyle,
} from './docStyle';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(name, ok, ok ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const ON = new Date(2026, 7, 26);   // 26 Aug 2026, local — months are 0-based

console.log('\nDocument style self-test\n');

console.log('The four styles the scan sheet offers:');
eq('exactly four', DOC_STYLES.length, 4);
eq('in order', DOC_STYLES.map(s => s.label), ['ID card', 'Document', 'Letter', 'Report']);
check('every style has a page rule and an image width',
  DOC_STYLES.every(s => s.page.includes('size:') && !!s.imageWidth));
check('the default style resolves', docStyle(DEFAULT_STYLE).id === DEFAULT_STYLE);
check('an unknown id falls back instead of throwing',
  docStyle('nope' as any).label === 'Document');

console.log('\nAn ID card prints at card size, not blown up to fill the page:');
eq('ID card width is the real ISO card width', docStyle('id').imageWidth, '85.6mm');
check('every other style fills the page width',
  DOC_STYLES.filter(s => s.id !== 'id').every(s => s.imageWidth === '100%'));
check('Letter uses Letter paper', docStyle('letter').page.includes('Letter'));

console.log('\nThe name field starts filled, so nothing is ever untitled:');
eq('default carries style + date', defaultDocName('id', ON), 'ID card 2026-08-26');
eq('a single-digit month/day pads', defaultDocName('report', new Date(2026, 0, 5)), 'Report 2026-01-05');

console.log('\nWhatever the user types becomes a safe filename:');
eq('a plain name gains .pdf', docFilename('Aadhaar front', 'id', ON), 'Aadhaar front.pdf');
eq('path separators are stripped', docFilename('a/b\\c', 'id', ON), 'abc.pdf');
eq('windows-illegal characters are stripped', docFilename('q:*?"<>|x', 'id', ON), 'qx.pdf');
eq('an emptied field falls back to the default', docFilename('   ', 'letter', ON), 'Letter 2026-08-26.pdf');
eq('a name that is only separators falls back too', docFilename('///', 'report', ON), 'Report 2026-08-26.pdf');
eq('the user typing .pdf does not double it', docFilename('Bill.pdf', 'document', ON), 'Bill.pdf');
check('the result always ends in exactly one .pdf',
  DOC_STYLES.every(s => (docFilename('x.pdf', s.id, ON).match(/\.pdf/gi) || []).length === 1));

console.log(failures === 0 ? '\nAll document style checks passed.\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
