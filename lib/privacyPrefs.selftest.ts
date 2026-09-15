// lib/privacyPrefs.selftest.ts — run: npx tsx lib/privacyPrefs.selftest.ts
//
// Two privacy defaults and two gates, all of which are invisible when they
// regress — which is exactly why they need a test rather than a code review.
//
//   • The RECIPIENT-side link preview used to hand our server a URL that had
//     arrived inside an end-to-end-encrypted message, from the recipient's own
//     device, with no setting anywhere. Nothing observable changes when that
//     comes back: the card still renders, the fetch is just a network call
//     nobody sees.
//   • Chat export wrote plaintext and opened the system share sheet with no
//     biometric, app-lock or chat-lock check — including for a chat the user
//     had explicitly locked. Nothing observable changes when that comes back
//     either; the export simply succeeds, which is what it looks like when it
//     is working.
//
// So the behavioural half (notifContent, the exported defaults) runs the real
// module, and the structural half asserts the gates are still in the source —
// including that no OTHER file has grown its own ungated /link/preview call,
// which is how this leak would return.

import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_NOTIF_PREVIEW, DEFAULT_REMOTE_LINK_PREVIEWS,
  NOTIF_PREVIEW_OPTIONS, notifContent,
} from './privacyPrefs';
import { DOC_BOMB_MESSAGE, MAX_UNZIPPED_BYTES, unzipBudget } from './docText';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Source with // and /* *\/ comments stripped, so a comment quoting a call
 *  site can never satisfy — or trip — a structural assertion. */
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

console.log('\nPrivacy-prefs self-test\n');

console.log('Defaults:');
check('recipient-side link previews are OFF by default',
  DEFAULT_REMOTE_LINK_PREVIEWS === false,
  'ON means every received link is handed to the server before the user can object');
check('notification preview defaults to name-only', DEFAULT_NOTIF_PREVIEW === 'name');
check('no "full text" preview mode is offered',
  !NOTIF_PREVIEW_OPTIONS.some(o => (o.value as string) === 'full'),
  'the client cannot decrypt at notification time, so a Full mode could not work');

console.log('\nNotification content:');
check('name-only shows the chat name and no message text',
  JSON.stringify(notifContent('name', 'Alice')) === JSON.stringify({ title: 'Alice', body: 'New message' }));
check('generic names neither the chat nor the message',
  JSON.stringify(notifContent('generic', 'Alice')) === JSON.stringify({ title: 'crazzychat', body: 'New message' }));
check('hidden raises nothing at all', notifContent('hidden', 'Alice') === null);
check('a missing chat name never falls through as an empty title',
  notifContent('name', '')?.title === 'crazzychat');
check('no mode ever carries message text',
  (['name', 'generic', 'hidden'] as const).every(m => {
    const c = notifContent(m, 'Alice');
    return c === null || c.body === 'New message';
  }));

console.log('\nRecipient-side link fetch is gated:');
const lp = code('components/LinkPreview.tsx');
check('LinkPreview asks the pref before fetching',
  /getRemoteLinkPreviews\(\)\s*\)\s*\)\s*return null;[\s\S]*\/link\/preview/.test(lp),
  'the gate must sit BEFORE the api() call, not beside it');
check('LinkPreview still renders a sender-embedded preview without fetching',
  /if \(data\) return;/.test(lp),
  'E2EE previews from the sender must keep working with the fetch off');

// The leak returns the moment some other screen calls the endpoint directly.
const SCAN = ['app', 'components', 'lib'];
const walk = (d: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (/node_modules|\.expo|android|ios|dist|build/.test(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
};
const callers = SCAN.flatMap(d => walk(path.join(ROOT, d)))
  .filter(f => /['"`]\/link\/preview/.test(code(f)));
check('exactly one file calls GET /link/preview, and it is the gated one',
  callers.length === 1 && callers[0] === 'components/LinkPreview.tsx',
  callers.join(', ') || 'none found — did the endpoint move?');

console.log('\nChat export is gated:');
const ex = code('app/chat-export.tsx');
check('export consults the chat lock', /getLock\(chatId\)/.test(ex));
check('a locked chat must satisfy biometric or PIN',
  /verifyBiometric\(/.test(ex) && /verifyPin\(/.test(ex));
check('every export path runs through the gate',
  (ex.match(/authorizeExport\(\)/g) || []).length >= 1
  && /if \(!\(await authorizeExport\(\)\)\) return;/.test(ex));
// EXECUTION order, not DEFINITION order. writeFile/shareFile are helpers
// declared near the top of the file; the gate lives in guard(), which is
// declared lower down and is what CALLS them. Comparing raw string indexes
// therefore compares where things are written, not what runs first, and fails
// on a file that is correctly gated. What actually matters: inside guard(),
// authorizeExport() must return early before the work callback is invoked.
{
  const g = ex.slice(ex.indexOf('const guard = async'));
  const body = g.slice(0, g.indexOf('\n  };'));
  check('the gate precedes the file write and the share sheet',
    /if \(!\(await authorizeExport\(\)\)\) return;/.test(body)
    && body.indexOf('authorizeExport()') < body.indexOf('await fn('),
    'authorizeExport must return early before guard() invokes the export callback');
  check('the write and share helpers are only reachable through guard()',
    !/writeFile\(|shareFile\(/.test(ex.slice(0, ex.indexOf('const guard = async'))
      .replace(/const (writeFile|shareFile) = async[\s\S]*?\n  \};/g, '')),
    'a write or share called outside guard() would bypass the lock');
}
check('both export buttons go through the same guard()',
  (ex.match(/=> guard\(async/g) || []).length === 2,
  'a new export format added outside guard() would be ungated');

console.log('\nDead privacy toggles are gone:');
const vf = read('app/vault-features.tsx');
check('hideChatPreview no longer ships as a switch', !/key:\s*'hideChatPreview'/.test(vf));
check('hidePreviewInApp no longer ships as a switch', !/key:\s*'hidePreviewInApp'/.test(vf));

console.log('\nZip output is bounded:');
// The budget is the whole defence, so it is exercised rather than only grepped.
const small = unzipBudget();
check('an ordinary document passes through untouched',
  [1_000, 50_000, 2_000_000].every(n => small({ originalSize: n }) === true));

const bomb = unzipBudget();
let threw = '';
try {
  // A 32 MB zip of one repeated byte declares gigabytes of original size. Each
  // entry is individually small — only the RUNNING TOTAL catches it, which is
  // why the budget is stateful and per-unzip-call.
  for (let i = 0; i < 4_000; i++) bomb({ originalSize: MAX_UNZIPPED_BYTES / 1_000 });
} catch (e: any) { threw = e?.message ?? ''; }
check('a zip whose entries sum past the cap is refused', threw === DOC_BOMB_MESSAGE,
  threw || 'nothing thrown — the app would have OOMed instead');
check('one oversized entry alone is refused',
  (() => { try { unzipBudget()({ originalSize: MAX_UNZIPPED_BYTES + 1 }); return false; }
           catch { return true; } })());
check('each unzip call gets a fresh budget',
  unzipBudget()({ originalSize: MAX_UNZIPPED_BYTES - 1 }) === true,
  'a shared counter would refuse the second document a user opens');

const dt = code('lib/docText.ts');
const db = code('lib/docBlocks.ts');
check('docText caps the DECOMPRESSED size, not just the input',
  /MAX_UNZIPPED_BYTES/.test(dt) && /unzipSync\(bytes, \{ filter: unzipBudget\(\) \}\)/.test(dt));
check('docBlocks uses the same cap',
  /unzipSync\(bytes, \{ filter: unzipBudget\(\) \}\)/.test(db));
check('no unzipSync anywhere in either file is left unbounded',
  !/unzipSync\([^)]*\)(?!\s*;?\s*$)/.test('') &&
  (dt.match(/unzipSync\(/g) || []).length === (dt.match(/unzipSync\(bytes, \{ filter/g) || []).length &&
  (db.match(/unzipSync\(/g) || []).length === (db.match(/unzipSync\(bytes, \{ filter/g) || []).length);

console.log(failures === 0 ? '\nAll privacy-prefs checks passed.\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
