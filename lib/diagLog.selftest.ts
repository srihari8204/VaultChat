// lib/diagLog.selftest.ts — the noisy-log seam, and the two rules it enforces.
//
//   npx tsx lib/diagLog.selftest.ts
//
// BEHAVIOURAL for the helper (it runs warnOnce/redactIds for real), STRUCTURAL
// for the two call sites (it reads their source).
//
// WHAT THIS PROTECTS
//
// console.warn is deliberately NOT stripped from release builds — that is how
// several defects in this app were found on a device that could not be attached
// to a debugger. The cost is that every warn on a hot path is a real line in a
// shipped user's logcat.
//
// Measured on a cold boot of the release build: 21 of the 22 JavaScript log
// lines were the same two E2EE failures repeating for a handful of peers over
// ~3 seconds, each printing a full user UUID. The first of each carried the
// entire diagnostic; the rest only buried it.

import { readFileSync } from 'fs';
import { join } from 'path';
import { warnOnce, shortId, redactIds, _resetWarnOnce } from './diagLog';

const ROOT = join(__dirname, '..');

let failed = 0;
function A(ok: boolean, what: string): void {
  if (ok) { console.log('  ok   ' + what); return; }
  failed++;
  console.log('  FAIL ' + what);
}

console.log('\nDiagnostic logging seam\n');

// ── 1. warnOnce actually suppresses repeats ───────────────────────────
{
  _resetWarnOnce();
  const orig = console.warn;
  const seen: string[] = [];
  console.warn = (m?: unknown) => { seen.push(String(m)); };
  try {
    for (let i = 0; i < 12; i++) warnOnce('chat|peer', 'boom');
    warnOnce('chat|other', 'boom-other');
  } finally { console.warn = orig; }

  A(seen.length === 2, `1. 12 calls on one key + 1 on another => 2 lines (got ${seen.length})`);
  A(seen[0] === 'boom', '1a. the FIRST occurrence is the one kept — it carries the diagnostic');
  A(seen[1] === 'boom-other', '1b. a different key still reports; suppression is per-key');
}

// ── 2. identifiers do not reach the log in full ───────────────────────
{
  const uuid = 'cb1caeda-e862-4578-9fab-9acd248ee77d';
  A(shortId(uuid) === 'cb1caeda', '2. shortId keeps 8 chars — enough to correlate, not to identify');
  A(shortId(undefined) === '(none)', '2a. and tolerates a missing id');

  // The thrown message embeds an id we did not choose to log, so redaction has
  // to happen on free text, not just at the call site.
  const msg = `group: no sender key for ${uuid}`;
  const red = redactIds(msg);
  A(!red.includes(uuid), '2b. redactIds removes a full uuid embedded in a thrown message');
  A(red.includes('cb1caeda'), '2c. while keeping the prefix, so logs stay correlatable');

  const two = redactIds(`${uuid} and 46161a32-b4f0-4184-8272-ee3ab3444df6`);
  A(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(two),
    '2d. every uuid in the string, not only the first');
}

// ── 3. the two hot call sites use it ──────────────────────────────────
{
  const GROUP = readFileSync(join(ROOT, 'services/crypto/groupSession.rn.ts'), 'utf8');
  const CHAT  = readFileSync(join(ROOT, 'lib/chatService.ts'), 'utf8');

  A(/warnOnce\(chatId \+ '\|' \+ senderId/.test(GROUP),
    '3. the sender-key ingest failure is keyed per chat+peer, not per attempt');
  A(!/console\.warn\('\[e2ee\] group: could not open sender key/.test(GROUP),
    '3a. and no longer calls console.warn directly');

  A(/warnOnce\('gdec\|' \+ chatId \+ '\|' \+ senderId/.test(CHAT),
    '3b. the group-decrypt failure is keyed per chat+sender, not per MESSAGE — '
    + 'one broken key used to warn once for every message it could not open');
  A(!/console\.warn\('\[e2ee\] group decrypt failed:/.test(CHAT),
    '3c. and no longer calls console.warn directly');

  // The user-visible behaviour must be untouched: this was a logging change.
  A(/return '🔒 unable to decrypt';/.test(CHAT),
    '3d. the undecryptable bubble is UNCHANGED — this was a logging seam only');
}

console.log(failed === 0
  ? '\ndiagLog: all checks passed'
  : `\ndiagLog: ${failed} FAILED`);
if (failed > 0) process.exit(1);
