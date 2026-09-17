// lib/ccwire/adversarialParity.selftest.ts — run: npx tsx lib/ccwire/adversarialParity.selftest.ts
//
// The TypeScript reader of __vectors__/adversarial.json.
//
// WHY THIS FILE EXISTS. The fixture's own note calls itself "ONE source of
// hostile bytes for every implementation, so Go and Rust cannot drift into
// disagreeing about what is refusable" — and until now only Go
// (internal/ccwire/fuzz_test.go, as fuzz seeds) and Rust
// (transport/rust/tests/adversarial.rs, as a table) read it. Two of three is not
// one source. A corpus that the third implementation never runs is a corpus that
// documents an agreement TypeScript is not party to.
//
// HOW THIS DIFFERS FROM codecParity.selftest.ts. codec.json pins exact BYTES and
// exact typed errors, because the header is a contract about representation.
// adversarial.json deliberately pins less: `accept` says only whether a
// conforming decoder may return a VALUE, and the fixture's howToUse says in so
// many words that it "is NOT an assertion about which error". Asserting the
// error here would be asserting something the other two readers do not, which is
// how a fixture stops being one source and becomes three dialects of one.
//
// LIVENESS IS ASSERTED FOR EVERY CASE, accepted or refused. That is the property
// hostile bytes actually threaten: decodeFrameMessage must RETURN — not throw
// past its own typed-result boundary, not hang on a varint that never ends, and
// not allocate from a length a peer declared but did not supply. A refusal is a
// return. An uncaught throw is not, and would reach a caller that is switching
// on `r.error`.
//
// STATUS: NOT WIRED, like codec.ts itself. Nothing on the live path imports it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrameMessage, ERROR_CODE } from './codec';

const VECTORS = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '__vectors__', 'adversarial.json');

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// Whitespace is stripped so the fixture may group bytes for a human reader.
const unhex = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from((s ?? '').replace(/\s+/g, ''), 'hex'));

console.log('\nccwire.v1.Frame adversarial corpus, TS against the shared fixture\n');

if (!fs.existsSync(VECTORS)) {
  console.error(`  ✗ ${VECTORS} is missing.`);
  process.exit(1);
}
const v = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

console.log(`TS agrees with every recorded expectation (${v.cases.length} cases):`);
for (const c of v.cases) {
  let r: ReturnType<typeof decodeFrameMessage>;
  try {
    r = decodeFrameMessage(unhex(c.hex));
  } catch (e) {
    // Liveness. Reaching here means hostile bytes escaped the typed boundary
    // and became an exception in whatever called the decoder.
    check(c.name, false, `THREW past the typed result: ${e}`);
    continue;
  }

  if (c.accept) {
    check(c.name, r.ok, r.ok ? '' : `refused conforming bytes: ${r.error} — ${r.detail}`);
  } else {
    // The fixture pins refusal, not which refusal; the typed error is printed so
    // a disagreement between implementations is still readable from the log.
    check(c.name, !r.ok, r.ok ? 'ACCEPTED bytes the fixture calls unrepresentable' : '');
    if (!r.ok) console.log(`      refused with ${r.error}/${r.errorCode}`);
  }

  // A refusal a caller cannot turn into an Error frame is a refusal it will
  // drop on the floor, so the typed error must always carry its ErrorCode.
  if (!r.ok) {
    check(`  ${c.name}: errorCode matches ERROR_CODE[${r.error}]`,
      r.errorCode === ERROR_CODE[r.error!], `${r.errorCode} vs ${ERROR_CODE[r.error!]}`);
  }
}

console.log(failures
  ? `\n  ${failures} FAILED — TypeScript disagrees with the shared adversarial corpus\n`
  : '\n  all ccwire.v1.Frame adversarial checks passed\n');
process.exit(failures ? 1 : 0);
