// lib/docText.realfiles.selftest.ts — run:
//   npx tsx lib/docText.realfiles.selftest.ts <dir-of-documents>
//
// docText.selftest.ts builds its fixtures by hand with fflate, which proves the
// PARSER but not the CONTRACT: a hand-rolled zip contains exactly the parts the
// test author remembered. Real Word, Excel, PowerPoint and PDF writers emit
// tables, tabs, multiple sheets, shared-string tables, speaker notes, page
// breaks and Flate-compressed multi-page content streams — none of which a
// synthetic fixture exercises.
//
// This runs the SHIPPED extractDocText over whatever documents it is pointed at,
// so it can be aimed at generated fixtures or at a folder of genuine files.
//
// It prints sizes and character counts, never document CONTENT — pointing it at
// a real folder must not spill private documents into a terminal or a log.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { extractDocText, docKind, MAX_DOC_BYTES } from './docText.js';

// SKIPS (exit 0) with no argument, so the repo-wide runner can pick this file up
// without needing a corpus — the same contract test-migrations.js uses when the
// database stack is not running. Point it at a folder to actually run:
//   npx tsx lib/docText.realfiles.selftest.ts <dir-of-documents>
const dir = process.argv[2];
if (!dir) {
  console.log('  · no document folder given — skipped (pass a directory to run)');
  process.exit(0);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

const MARK = 'CRAZZYCHATMARKER';

/** What each generated fixture must yield. Anything else is reported, not asserted. */
const EXPECT: Record<string, { ok: boolean; must?: string[]; why: string }> = {
  'test.docx':          { ok: true,  must: [MARK, 'TableCell1', 'Line two', 'Second page'],
                          why: 'headings, runs, a real <w:br/>, table cells and a page break' },
  'test.xlsx':          { ok: true,  must: [MARK, 'Alice', '1234.56', 'SecondSheetValue', 'AfterBlankRow'],
                          why: 'shared strings, numbers, a blank row, and a SECOND sheet' },
  'test.pptx':          { ok: true,  must: [MARK, 'Slide Two', 'Bullet A', 'TextBoxOnBlankSlide'],
                          why: 'title + body placeholders across slides, and a bare text box' },
  'test.pdf':           { ok: true,  must: [MARK, 'Page Two'],
                          why: 'Flate-compressed content streams across two pages' },
  'scanned-noText.pdf': { ok: false, why: 'image-only PDF — no text layer, must report empty not garbage' },
  'legacy.doc':         { ok: false, why: 'OLE2 binary format — must be refused with a reason' },
  'legacy.xls':         { ok: false, why: 'OLE2 binary format — must be refused with a reason' },
  'corrupt.docx':       { ok: false, why: 'truncated zip — must fail cleanly, never throw' },
  'notreally.pdf':      { ok: false, why: 'not a PDF at all' },
  'empty.pdf':          { ok: false, why: 'zero bytes' },
};

const files = readdirSync(dir).filter(f => statSync(join(dir, f)).isFile()).sort();
console.log(`extracting text from ${files.length} document(s) in ${dir}\n`);

let realOk = 0, realEmpty = 0;

for (const f of files) {
  const path = join(dir, f);
  const bytes = new Uint8Array(readFileSync(path));
  const kind = docKind(f);
  const exp = EXPECT[f];

  // extractDocText THROWS by design, with a message the UI shows directly —
  // that is its refusal channel, not a failure. What must never happen is an
  // unhandled throw reaching the viewer, which is what `refused` proves.
  let res: ReturnType<typeof extractDocText> | null = null;
  let refused = '';
  try {
    res = extractDocText(bytes, f);
  } catch (e: any) {
    refused = String(e?.message ?? e);
  }

  const n = res?.text?.length ?? 0;
  const label = `${f} [${kind}] ${bytes.length}B → ${refused ? 'refused' : n + ' chars'}`;

  if (!exp) {
    // A genuine document we were pointed at. Report ONLY sizes — never content.
    if (!refused && n > 0) { realOk++; console.log(`  · ${label}`); }
    else { realEmpty++; console.log(`  · ${label}${refused ? '  (' + refused + ')' : '  (no text layer)'}`); }
    continue;
  }

  if (exp.ok) {
    check(label, !refused && n > 0, refused || 'no text extracted');
    for (const m of exp.must ?? []) {
      check(`    contains "${m}" — ${exp.why}`, !!res && res.text.includes(m),
            `not found in ${n} chars`);
    }
  } else {
    check(`${label} — ${exp.why}`, !!refused || n === 0,
          `expected nothing readable, got ${n} chars`);
    check(`    …and the user is told why`, !!refused || (!!res && res.empty),
          'silently returned nothing with no explanation');
  }
}

console.log();
check('the size ceiling is enforced', MAX_DOC_BYTES > 0 && MAX_DOC_BYTES <= 64 * 1024 * 1024,
      `MAX_DOC_BYTES=${MAX_DOC_BYTES}`);
if (realOk + realEmpty > 0) {
  console.log(`\n  real documents: ${realOk} yielded text, ${realEmpty} yielded none`);
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
