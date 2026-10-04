// lib/financeBtnLatch.selftest.ts — run: npx tsx lib/financeBtnLatch.selftest.ts
//
// SIX CONFIRMED DUPLICATE WRITES, ONE SHARED BUTTON, ONE LATCH.
//
// components/finance/ui.tsx Btn is the save button on every finance form. Six
// of those forms pass neither `disabled` nor `loading` and keep no busy state,
// so before the latch a second press during the await wrote a second row:
//
//   app/finance/ledger/update.tsx   a repayment recorded twice
//   app/finance/ledger/new.tsx      a duplicate loan
//   app/finance/chitti/new.tsx      a duplicate group
//   app/finance/chitti/[id].tsx     two members sharing one `number`
//   app/finance/reminders.tsx       two OS notifications, one cancellable
//   app/finance/interest.tsx        a duplicate history row
//
// Each write mints a fresh uuid() with no unique index behind it, so nothing
// downstream collapses the duplicate. The fix is one latch in the shared
// component rather than six busy states.
//
// This guard is STRUCTURAL and says so. It cannot prove the latch works on a
// device; it proves the latch is still there and still wired, which is what
// stops the six defects returning quietly. It strips comments before matching,
// so prose about a latch cannot satisfy a check about code.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comments removed — a sentence describing the guard must not pass for the guard. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
const check = (what: string, ok: boolean, detail?: string) => {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what + (detail ? '  — ' + detail : ''));
};

console.log('\nfinance Btn single-flight latch\n');

const UI = code(read('components/finance/ui.tsx'));

check('1. Btn holds a ref latch, not a state flag',
  /inFlight\s*=\s*React\.useRef\(false\)/.test(UI),
  'state only blocks the next press after a render has flushed');

check('2. a press while one is in flight returns early',
  /if\s*\(\s*inFlight\.current\s*\)\s*return/.test(UI));

check('3. the latch is only taken for a thenable',
  /typeof\s*\(?\s*r[\s\S]{0,60}\.then\s*===\s*['"]function['"]/.test(UI),
  'a handler returning nothing must behave exactly as before');

check('4. the latch is always released',
  /\.finally\(\s*\(\)\s*=>\s*\{\s*inFlight\.current\s*=\s*false/.test(UI),
  'a rejected promise must not leave the button dead');

// Scoped to Btn's own body: IconBtn, QuickAction and the rest of this file pass
// onPress straight through, correctly — they take no promise and write nothing.
// The first version of this check scanned the whole file and failed on them,
// which is the false positive a ratchet is supposed to be shaped against.
const BTN = UI.slice(UI.indexOf('export function Btn('),
                     UI.indexOf('export function IconBtn('));
check('5a. the check is reading Btn and nothing else',
  BTN.length > 200 && BTN.includes('guardedPress'), `${BTN.length} chars`);
check('5b. Btn wires the Pressable to the guarded handler, not the raw prop',
  /onPress=\{guardedPress\}/.test(BTN) && !/onPress=\{onPress\}/.test(BTN),
  'rewiring to onPress={onPress} silently restores all six defects');

// The latch only protects a screen that actually renders this Btn. If one of
// the six swaps it for a raw Pressable, the guarantee is gone with no error.
const COVERED = [
  'app/finance/ledger/update.tsx',
  'components/finance/LedgerForm.tsx',          // ledger/new and ledger/edit
  'app/finance/chitti/new.tsx',
  'components/finance/chitti/MembersTab.tsx',   // split out of chitti/[id]
  'components/finance/chitti/AuctionsTab.tsx',
  'app/finance/reminders.tsx',
  'app/finance/interest.tsx',
];
for (const f of COVERED) {
  const src = code(read(f));
  check(`6. ${f} still saves through Btn`,
    /<Btn\b/.test(src) && /from '[^']*(components\/finance\/|\.\.?\/)ui'/.test(read(f)),
    'this screen no longer inherits the latch');
}

console.log(failed === 0 ? '\nfinanceBtnLatch: all checks passed' : `\nfinanceBtnLatch: ${failed} FAILED`);
if (failed > 0) process.exit(1);
