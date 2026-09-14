// lib/messageQueue.latency.selftest.ts — run: npx tsx lib/messageQueue.latency.selftest.ts
//
// REPORTED FROM A DEVICE: "messages are not instantly single tick, it's taking
// too much time." The message appeared as a clock and stayed there for many
// seconds before the tick, on a healthy network where the POST itself takes
// ~200 ms.
//
// Two independent causes, both in flush():
//
//   1. A send that arrived WHILE a flush was running was DROPPED. enqueue()
//      calls flush() immediately after writing the row, but flush() opened with
//      a bare `if (flushing) return;`. Any other pass in flight — the 30 s
//      periodic tick, a backoff retry, a reconnect drain — swallowed that call,
//      and the message then waited for the NEXT scheduled pass. On the backoff
//      ladder that is up to 60 s.
//
//   2. Every flush ran reapAwaitingDelivery() FIRST, which reads 500 rows out of
//      SQLite and unseals each one through the cache codec — before the message
//      the user is waiting on is even looked at. It is garbage collection
//      against a SEVEN-DAY cutoff, so running it per-send bought nothing and
//      lengthened every flush, which in turn widened the window for cause 1.
//
// lib/messageQueue.ts imports react-native and expo-sqlite, so it cannot be
// loaded under Node. This asserts against the source, like lib/refreshOutcome
// and lib/chatListResync do, and is honest about being a source-level check.

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'lib', 'messageQueue.ts'), 'utf8');

// Strip line comments so an assertion tests the code, not the prose describing
// it — the fix deliberately quotes the old behaviour to explain what must not
// come back, and a raw substring search would match that and fail on a correct
// file.
const CODE = SRC.split('\n').map(l => {
  const i = l.indexOf('//');
  return i >= 0 ? l.slice(0, i) : l;
}).join('\n');

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

console.log('\nSend latency — the clock must not outlive the POST\n');

console.log('1. A send during an in-flight flush is served, not dropped:');
check('flush() sets a re-run flag instead of returning bare',
  /if \(flushing\) \{\s*flushAgain = true;\s*return;\s*\}/.test(CODE));
check('...the flag is declared',
  /let flushAgain = false;/.test(CODE));
check('...and drained after the pass completes',
  /if \(flushAgain\) \{\s*flushAgain = false;[\s\S]{0,80}?flush\(\)/.test(CODE));
check('...cleared BEFORE the re-run, so N callers cost one extra pass, not N',
  CODE.indexOf('flushAgain = false;') < CODE.indexOf('void flush()'));
// The regression this guards: reverting to a bare early return.
check('no bare `if (flushing) return;` remains',
  !/if \(flushing\) return;/.test(CODE));

console.log('\n2. Seven-day GC does not run on the send path:');
check('the reap is interval-gated',
  /Date\.now\(\) - lastReapAt >= REAP_INTERVAL_MS/.test(CODE));
check('...with an interval measured in minutes, not per-send',
  /REAP_INTERVAL_MS = \d+ \* 60_000/.test(CODE));
check('...and the timestamp is advanced before the await, so a slow reap '
  + 'cannot be re-entered',
  /lastReapAt = Date\.now\(\);\s*await reapAwaitingDelivery\(\)/.test(CODE));
// The reap still has to exist — throttling is not deleting.
check('the reap is still called',
  /await reapAwaitingDelivery\(\);/.test(CODE));
check('the 7-day cutoff is unchanged',
  /AWAIT_DELIVERY_MAX_MS = 7 \* 24 \* 60 \* 60 \* 1000/.test(CODE));

console.log('\n3. The properties that must NOT have changed:');
check('enqueue still flushes immediately (the optimistic path)',
  /await put\(msg\);[\s\S]{0,120}?flush\(\)/.test(CODE));
check('accepted rows are still skipped by the send loop',
  /if \(isAwaitingDelivery\(item\)\) \{ inert\+\+; continue; \}/.test(CODE));
check('a network failure still keeps the clock, never a red failure',
  /function isPermanent\(status\?: number\): boolean \{\s*return status === 400/.test(CODE));
check('re-body recovery still runs outside the flushing guard',
  /flushing = false;[\s\S]{0,400}?await reBodyAwaiting\(\)/.test(CODE));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all send-latency checks passed\n');
process.exit(failures ? 1 : 0);
