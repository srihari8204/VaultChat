// Run: npx tsx lib/appLockLatch.selftest.ts
//
// app/app-lock.tsx: submitSeal and submitMpin each spend an attempt (pinStore
// back-off, or a server-checked MPIN). They used to guard on `busy` STATE, so a
// second completion in the same frame — keyboard submit plus the button, or
// MpinInput's autofill firing onComplete twice — still read false and sent a
// second check. They now share a ref latch, taken before the first await and
// released in `finally`, like mpin-entry / mpin-recover / backup-pin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '..', 'app', 'app-lock.tsx'), 'utf8');

function body(name: string): string {
  const start = SRC.indexOf(`const ${name} = async`);
  assert.ok(start >= 0, `${name} not found`);
  const end = SRC.indexOf('\n  };', start);
  return SRC.slice(start, end);
}

assert.match(SRC, /const inFlight = useRef\(false\);/, 'one ref latch for the submits');

for (const name of ['submitSeal', 'submitMpin']) {
  const b = body(name);
  const guard = b.indexOf('if (inFlight.current) return;');
  const take = b.indexOf('inFlight.current = true;');
  const firstAwait = b.indexOf('await ');
  assert.ok(guard >= 0, `${name}: returns while a check is in flight`);
  assert.ok(take > guard && take < firstAwait, `${name}: takes the latch before the first await`);
  assert.match(b, /finally \{ inFlight\.current = false;/, `${name}: releases the latch in finally`);
  assert.doesNotMatch(b, /if \(busy\b/, `${name}: no longer guards on busy state`);
}

// Run the guard shape: two completions in one tick, one check.
{
  let calls = 0;
  const inFlight = { current: false };
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { calls++; await Promise.resolve(); } finally { inFlight.current = false; }
  };
  void Promise.all([submit(), submit()]).then(async () => {
    assert.equal(calls, 1, 'a double completion sends one check');
    await submit();
    assert.equal(calls, 2, 'the latch is released for the next real attempt');
    console.log('appLockLatch selftest: OK');
  });
}
