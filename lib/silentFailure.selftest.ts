// lib/silentFailure.selftest.ts — run: npx tsx lib/silentFailure.selftest.ts
//
// EIGHT CONFIRMED INTERACTION DEFECTS, ONE RATCHET.
//
// Every defect below was a user-initiated mutation whose failure was invisible:
// the screen looked like it had succeeded and the truth arrived later, or never.
// They were found by tracing control flow, not by grep — three earlier
// grep-based passes produced 100% false positives (create-poll, group-trip and
// emergency-sos were all guarded). This file exists so the eight do not come
// back quietly, one `catch {}` at a time.
//
//   app/group-insights.tsx     re-tapping the active span tab hung the spinner
//   app/chat.tsx               pin and unpin left the optimistic value on screen
//   app/message-reminder.tsx   the row — and with it the cancellation handle —
//                              was deleted even when the OS cancel threw
//   app/chat.tsx               Clear chat swallowed the server-side hide, so the
//                              history returned on the next refresh
//   app/finance/interest.tsx   the history row was dropped silently
//   app/(tabs)/chats.tsx       bulk actions swallowed every per-item failure
//   app/(tabs)/chats.tsx       a long-press sheet that could never open
//   app/vault-features.tsx     "Revoke" deleted only the local copy
//
// This guard is STRUCTURAL and says so, in the repo's convention
// (lib/call/reconnectWiring.selftest.ts:3). It cannot prove an alert renders on
// a device. It proves the failure path is still wired, and still ordered after
// the call it reports on. Comments are stripped before matching, so prose about
// a fix cannot satisfy a check about code.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** Comments removed — a sentence describing the guard must not pass for it. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
const check = (what: string, ok: boolean, detail?: string) => {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what + (detail ? '  — ' + detail : ''));
};

console.log('\nsilent-failure ratchet\n');

const CHAT     = code(read('app/chat.tsx'));
const CHATS    = code(read('app/(tabs)/chats.tsx'));
const INSIGHTS = code(read('app/group-insights.tsx'));
const REMINDER = code(read('app/message-reminder.tsx'));
const INTEREST = code(read('app/finance/interest.tsx'));
const VAULT    = code(read('app/vault-features.tsx'));

// ── C.2 stuck spinner ───────────────────────────────────────────────────────
// `range` is useMemo([span]) and the only setLoading(false) lives inside the
// focus effect, so re-tapping the active tab must not enter the loading state
// at all. A `finally` cannot help here: the effect body never runs.
check('1. the span tab bails out before entering the loading state',
  /if \(sp === span\) return;/.test(INSIGHTS),
  'setLoading(true) without this is a spinner nothing will ever clear');

// ── C.3 pin / unpin ─────────────────────────────────────────────────────────
check('2. both pin paths restore the previous pinned id on failure',
  (CHAT.match(/setPinnedId\(prev\)/g) ?? []).length >= 2,
  'the optimistic value stays on screen after a failed write');
check('3. both pin paths tell the user',
  CHAT.includes("'Could not pin'") && CHAT.includes("'Could not unpin'"));

// ── C.4 uncancellable reminder ──────────────────────────────────────────────
// r.id IS the cancellation handle; deleting the row after a failed OS cancel
// leaves a notification that will fire with nothing left to stop it.
check('4. a failed reminder cancel is surfaced, not swallowed',
  REMINDER.includes("'Could not cancel'"));

// ── C.5 clear chat ──────────────────────────────────────────────────────────
const clearIdx = CHAT.indexOf('await clearChatMessages(chatId)');
check('5. Clear chat still hides server-side',
  clearIdx > 0 && CHAT.includes('await setHidden(chatId, true);'));
check('6. the server-side hide is not swallowed',
  !/try \{ await setHidden\(chatId, true\); \} catch \{\s*\}/.test(CHAT),
  'swallowed, the screen pops back looking cleared and sync pulls the history back');
{
  const slice = CHAT.slice(clearIdx, clearIdx + 1200);
  const hide = slice.indexOf('await setHidden(chatId, true);');
  check('7. the success-looking pop happens after the hide, never before',
    hide >= 0 && slice.indexOf('router.back()') > hide);
}

// ── C.6 bulk chat actions ───────────────────────────────────────────────────
check('8. bulk actions count their per-item failures',
  /const results = await Promise\.allSettled\(ids\.map\(id => fn\(id\)\)\);\s*\n\s*const failed = results\.filter\(r => r\.status === 'rejected'\)\.length;/.test(CHATS),
  'catch {} here makes a partial bulk action look identical to a complete one');
check('9. the bulk failure is reported after the refetch is awaited',
  /await fetchList\(\);\s*\n\s*if \(failed\) setError\(/.test(CHATS),
  'loadList() calls setError(null) on success and would erase the message');
check('10. bulk delete reports its failures too',
  /Promise\.allSettled\(ids\.map\(id => setHidden\(id, true\)\)\)/.test(CHATS) && /const failed = results\.filter\(r => r\.status === 'rejected'\)\.length;/.test(CHATS));

// ── C.8 the sheet that could never open ─────────────────────────────────────
check('11. the dead long-press sheet stays deleted',
  !/menuChat/.test(CHATS),
  'setMenuChat was only ever called with null, so visible={!!menuChat} was always false');
check('12. favourite is still reachable — selection mode is now its only path',
  /const bulkFav\s*=/.test(CHATS) && /onPress=\{bulkFav\}/.test(CHATS));

// ── C.7 interest history ────────────────────────────────────────────────────
check('13. the interest write no longer swallows its failure',
  !/await insertInterest\([\s\S]{0,400}?\n\s*\} catch \{\s*\}/.test(INTEREST));
check('14. a failed interest write says it was not saved',
  INTEREST.includes("'Not saved to history'"));
check('15. the result is shown before the failure is reported, not instead of it',
  INTEREST.indexOf('setRes(out)') < INTEREST.indexOf("'Not saved to history'"),
  'the calculation succeeded; only the record did not');

// ── C.9 revoke code ─────────────────────────────────────────────────────────
// No revoke endpoint exists — contacts.go registers create/status/verify only.
// POST /contacts/sync/create opens with
// `DELETE FROM sync_codes WHERE initiator_id = $1`, so minting a replacement
// and discarding it is what actually invalidates the shared code.
{
  const i = VAULT.indexOf('const handleRevokeCode');
  const slice = VAULT.slice(i, i + 900);
  check('16. Revoke invalidates the code server-side, not just locally',
    i > 0 && slice.includes('await createSyncCode()'),
    'a local delete leaves the shared code live for its full 5 minutes');
  check('17. a failed revoke keeps the local copy and says the code is still valid',
    slice.includes("'Not revoked'") && slice.indexOf("'Not revoked'") < slice.indexOf('deleteItemAsync'));
}
check('18. the expiry the screen states matches the one the server mints',
  !/expires in 24 hours/.test(read('app/vault-features.tsx')),
  "the server uses INTERVAL '5 minutes'");

console.log(failed === 0 ? '\nsilentFailure: all checks passed' : `\nsilentFailure: ${failed} FAILED`);
if (failed > 0) process.exit(1);
