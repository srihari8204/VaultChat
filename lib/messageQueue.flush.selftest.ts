// lib/messageQueue.flush.selftest.ts — run: npx tsx lib/messageQueue.flush.selftest.ts
//
// Two bugs made "offline messages not working" real, and both were silent —
// nothing threw, nothing logged, messages just never left the phone. This pins
// the invariants that broke, because neither failure is visible in review.
//
// 1. PAGE ACCOUNTING. flush() skips accepted-but-unconfirmed rows, but they were
//    not subtracted from the drained count, so a page made only of them looked
//    fully drained → pageOffset reset to 0 → immediate re-flush → same page,
//    forever. Those rows are the OLDEST, so they sort to the head of the page:
//    an active user hit this as the NORMAL case, and real queued sends behind
//    them were never reached.
//
// 2. ORDERING + OFFLINE GUARD. reBodyAwaiting() ran BEFORE the send loop and
//    does one network PUT per row. api() sets no fetch timeout, so with no
//    network each call hangs until the OS gives up. Recovering rows serially in
//    front of the send loop stalled flush() outright.
//
// messageQueue.ts can't be imported in Node (react-native, expo-crypto), so the
// rule is lifted OUT of the source and executed here — the same approach as
// localDb.queue.selftest.ts. A change to the real line is picked up; a copy of
// it in this file would not be.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'messageQueue.ts'), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

function bodyOf(fnDecl: string): string {
  const start = SRC.indexOf(fnDecl);
  if (start < 0) throw new Error(`selftest: ${fnDecl} not found — renamed?`);
  // Brace-match from the first { after the signature.
  let i = SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(i, j + 1);
  }
  throw new Error(`selftest: unbalanced braces in ${fnDecl}`);
}

// ── 1. the real drained expression, lifted and executed ──────────────────
console.log('page accounting');

const flushBody = bodyOf('export async function flush');
const drainedLine = flushBody.match(/const drained = ([^;]+);/);
check('flush() still computes `drained`', !!drainedLine);

// Executing the real expression is the point: if someone drops `- inert`, this
// evaluates differently and the simulation below wedges.
const drainedOf = new Function(
  'q', 'remaining', 'inert',
  `return ${drainedLine![1]};`,
) as (q: unknown[], remaining: unknown[], inert: number) => number;

check('inert rows are subtracted, not counted as drained',
  drainedOf(new Array(200), [], 200) === 0,
  `a full page of inert rows reported ${drainedOf(new Array(200), [], 200)} drained`);

check('genuinely drained rows still count',
  drainedOf(new Array(10), new Array(4), 0) === 6);

check('mixed page counts only what actually left',
  drainedOf(new Array(10), new Array(2), 5) === 3);

// ── the rotation loop, driven by that same expression ────────────────────
// Faithful to flush(): same page window, same empty-page rewind, same
// drained-based offset rule. A wedged queue never terminates, so passes are
// bounded and exceeding the bound IS the failure.
const PAGE = 200;
const MAX_PASSES = 20;

// Lifted, not assumed: does the empty-page branch come straight back, or go
// idle? Hardcoding "goes idle" here would make this simulation agree with
// itself no matter what flush() actually does — which is the one way a test
// like this fails silently.
const emptyBranch = flushBody.slice(
  flushBody.indexOf('if (q.length === 0)'),
  flushBody.indexOf('return;', flushBody.indexOf('if (q.length === 0)')),
);
check('the empty-page branch was located in source', emptyBranch.length > 0);
const respinsOnEmpty = /scheduleFlush\(\s*0\s*\)/.test(emptyBranch);

function simulate(inertCount: number, sendable: number) {
  let queue = [
    ...Array.from({ length: inertCount }, () => ({ inert: true })),
    ...Array.from({ length: sendable }, () => ({ inert: false })),
  ];
  let pageOffset = 0, sent = 0, passes = 0;

  while (passes < MAX_PASSES) {
    passes++;
    const q = queue.slice(pageOffset, pageOffset + PAGE);
    if (q.length === 0) {
      // Walked off the end: rewind. Whether flush() then comes straight back
      // is read from the source above — rescheduling here is what made the
      // exact-multiple case spin forever.
      if (pageOffset > 0) {
        pageOffset = 0;
        if (respinsOnEmpty) continue;
      }
      break;
    }

    let inert = 0;
    const remaining: unknown[] = [];
    const gone = new Set<unknown>();
    for (const item of q) {
      if (item.inert) { inert++; continue; }
      sent++;
      gone.add(item);   // a successful send drops out of the queue
    }
    queue = queue.filter(x => !gone.has(x));

    const drained = drainedOf(q, remaining, inert);
    if (drained > 0 || q.length < PAGE) pageOffset = 0;
    else pageOffset += PAGE;

    // flush() only comes straight back for a full page with nothing retrying;
    // anything else means it went idle until the next real trigger.
    if (remaining.length === 0 && q.length >= PAGE) continue;
    break;
  }
  return { sent, passes };
}

const past = simulate(250, 3);
check('real sends behind a full page of inert rows are reached',
  past.sent === 3, `sent ${past.sent}/3 after ${past.passes} passes`);
check('rotation terminates instead of hot-looping',
  past.passes < MAX_PASSES, `still spinning after ${past.passes} passes`);

// The residual busy loop: inert count an EXACT multiple of PAGE, nothing to
// send. Full page advances the offset, next page is empty and rewinds — that
// cycle span forever at 0ms, re-unsealing rows on every lap.
const spin = simulate(PAGE * 2, 0);
check('an exact-multiple page of inert rows does not busy-loop',
  spin.passes < MAX_PASSES, `still spinning after ${spin.passes} passes`);

// ── 2. ordering and the offline guard ────────────────────────────────────
console.log('recovery must never block sending');

const reBody = bodyOf('async function reBodyAwaiting');
const guard = reBody.indexOf('if (!online) return');
const firstCall = reBody.indexOf('await api(');
check('reBodyAwaiting() bails out when offline', guard >= 0);
check('the offline guard precedes every network call',
  guard >= 0 && firstCall > guard,
  `guard@${guard} vs first api()@${firstCall}`);
check('recovery is bounded per pass', /attempts >= RE_BODY_PER_FLUSH/.test(reBody));
check('a request that never reached the server ends the pass',
  /else if \(!status\)[\s\S]{0,300}?return;/.test(reBody));

// Ordering: recovery must come after the send loop, not in front of it.
const loadAt  = flushBody.indexOf('await load()');
const reBodyAt = flushBody.indexOf('reBodyAwaiting()');
check('flush() sends before it attempts recovery',
  reBodyAt > loadAt,
  reBodyAt < 0 ? 'flush() no longer calls reBodyAwaiting()' : `reBodyAwaiting@${reBodyAt} vs load@${loadAt}`);

// ── 3. none of the above matters if the outbox never runs ────────────────
console.log('the outbox has to be running');

const LAYOUT = readFileSync(join(HERE, '..', 'app', '_layout.tsx'), 'utf8');
check('_layout.tsx starts the TEXT outbox at boot, not just the media one',
  /initQueue\(\)/.test(LAYOUT),
  'only app/chat.tsx called initQueue(), so there was no boot drain, no reconnect ' +
  'flush and no periodic tick until some individual chat was opened — and `online` stayed stale-true');
check('the media outbox is still started too', /initMediaOutbox\(\)/.test(LAYOUT));

const API = readFileSync(join(HERE, 'api.ts'), 'utf8');
check('api() gives fetch a deadline',
  /AbortController|AbortSignal\.timeout/.test(API),
  'a connected-but-dead link never settles, and an unsettled await inside the flush mutex wedges the outbox for the process lifetime');
check('uploads are exempt from that deadline', /instanceof FormData/.test(API));
check('a caller-supplied signal still wins', /init\.signal/.test(API));

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
