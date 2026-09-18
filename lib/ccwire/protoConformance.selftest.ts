// lib/ccwire/protoConformance.selftest.ts — run: npx tsx lib/ccwire/protoConformance.selftest.ts
//
// SCHEMA CONFORMANCE. proto/ccwire/v1/*.proto is the contract; two codecs are
// hand-written against it and nothing checked that they still agree with it:
//   TypeScript  lib/ccwire/codec.ts
//   Go          vaultchat-backend-go/internal/ccwire/codec.go
//
// codecParity.selftest.ts asks a different question — do TS and Rust agree with
// EACH OTHER on bytes. Two codecs can agree perfectly and both be wrong about
// the schema; that is the gap this file closes.
//
// GROUND TRUTH is the generated reference codec, lib/ccwire/gen/ccwire/v1/*_pb.ts
// (@bufbuild/protoc-gen-es), whose `proto3.util.newFieldList([...])` tables carry
// field numbers, names and types straight from protoc. They are read as SOURCE,
// not imported: a regex over a generated table cannot be fooled by a runtime
// import resolving to something else, and it works for the enum tables too.
// The .proto itself is read for one thing the generated code does not carry —
// the DOCUMENTED DEFAULT VALUE in the trailing comment on each Limits field,
// which is where codec.ts says it copied its numbers from.
//
// The Go side is source-scanned because it cannot be imported. The TS side is
// imported, like codecParity does, so it is the real runtime value rather than a
// second parse that could drift from it.
//
// KNOWN DIVERGENCES. Three are already recorded below (one of them field by
// field, so nine entries), each with the reason it is tolerated. They
// print as `○ KNOWN` and do not fail. Anything else fails. A KNOWN entry that
// stops diverging ALSO fails — a fixed divergence must be deleted from the list,
// not left rotting as permission to regress.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, BODY_NAMES, ERROR_CODE } from './codec';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// ── the known list ───────────────────────────────────────────────────────────
// Each id is raised by exactly one check below. Deleting a line here makes that
// divergence fail the run; the divergence going away makes the line fail it.

const KNOWN = new Map<string, string>([
  // Limits has 14 fields in capabilities.proto. Both codecs carry only the 7
  // they enforce (1,2,3,4,8,9,10); the other 7 are reassembly, batching,
  // in-flight and heartbeat bounds enforced elsewhere or not yet at all.
  ['limits-missing:reassembly_lifetime_ms', 'not carried by either codec'],
  ['limits-missing:max_reassembly_bytes', 'not carried by either codec'],
  ['limits-missing:max_concurrent_reassemblies', 'not carried by either codec'],
  ['limits-missing:max_batch_items', 'not carried by either codec'],
  ['limits-missing:max_inflight_per_stream', 'not carried by either codec'],
  ['limits-missing:heartbeat_interval_ms', 'not carried by either codec'],
  ['limits-missing:heartbeat_timeout_ms', 'not carried by either codec'],
  // max_message_body_bytes is uint64 (JS_STRING) in the schema, but the
  // ServerHello reader in client.ts:466 takes it through u32Of (client.ts:247),
  // which masks with 0xffffffff. A negotiated value above 2^32-1 wraps.
  ['limits-width:max_message_body_bytes', 'uint64 in schema, read through a 32-bit mask'],
  // AppEvent.event is bounded by max_string_field_bytes (4096) in codec.ts:502
  // but hard-coded to 64 in realtime/ccwire_app_events.go:157-158. A 100-byte
  // event name is accepted by one side and refused by the other.
  ['appevent-event-bound', 'TS 4096 vs Go 64'],
]);
const seen = new Set<string>();

/** A difference from the schema: recorded if known, a failure if not. */
function divergence(id: string, what: string, detail: string): void {
  if (KNOWN.has(id)) {
    seen.add(id);
    console.log(`  ○ KNOWN ${what}  (${detail} — ${KNOWN.get(id)})`);
    return;
  }
  check(what, false, detail);
}

// ── reading the generated tables ─────────────────────────────────────────────
// Every generated table — message field lists and enum value lists alike — is a
// bracketed list of `{ no: N, name: "..." }` entries after a line naming the
// type. Anchor on the type name, take to the closing `]);`, parse the entries.

type Entry = { no: number; name: string; T?: number; oneof?: string };

function table(file: string, anchor: string): Entry[] {
  const src = read(`lib/ccwire/gen/ccwire/v1/${file}`);
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`${file}: no generated table anchored at ${anchor}`);
  const end = src.indexOf(']);', at);
  const block = src.slice(at, end);
  const out: Entry[] = [];
  for (const line of block.split('\n')) {
    const m = /\{ no: (\d+), name: "([^"]+)"/.exec(line);
    if (!m) continue;
    out.push({
      no: Number(m[1]),
      name: m[2],
      T: /T: (\d+)/.exec(line) ? Number(/T: (\d+)/.exec(line)![1]) : undefined,
      oneof: /oneof: "(\w+)"/.exec(line)?.[1],
    });
  }
  if (!out.length) throw new Error(`${file}: table at ${anchor} parsed empty`);
  return out;
}

const SCHEMA_LIMITS = table('capabilities_pb.ts', 'typeName = "ccwire.v1.Limits"');
const SCHEMA_FRAME = table('envelope_pb.ts', 'typeName = "ccwire.v1.Frame"');
const SCHEMA_BODIES = SCHEMA_FRAME.filter((f) => f.oneof === 'body');
const SCHEMA_ERROR_CODES = table('errors_pb.ts', '"ccwire.v1.ErrorCode"');

// The default values live only in the .proto, as the trailing comment on each
// Limits field — `uint32 max_frame_bytes = 1;  // 262144`.
const DOCUMENTED = new Map<string, number>();
{
  const block = read('proto/ccwire/v1/capabilities.proto').split('message Limits {')[1].split('\n}')[0];
  for (const m of block.matchAll(/(\w+)\s*=\s*\d+\s*(?:\[[^\]]*\])?\s*;\s*\/\/\s*(\d+)/g)) {
    DOCUMENTED.set(m[1], Number(m[2]));
  }
}

// ── reading the Go codec ─────────────────────────────────────────────────────

const GO_CODEC = read('vaultchat-backend-go/internal/ccwire/codec.go');
const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const slice = (src: string, from: string, to = '\n}'): string => {
  const at = src.indexOf(from);
  if (at < 0) throw new Error(`Go source no longer contains ${from}`);
  const end = src.indexOf(to, at + from.length);
  return src.slice(at + from.length, end < 0 ? undefined : end);
};

const GO_LIMIT_FIELDS = [...slice(GO_CODEC, 'type Limits struct {').matchAll(/^\t(\w+)\s+\w+$/gm)]
  .map((m) => snake(m[1]));
const GO_LIMIT_VALUES = new Map<string, number>(
  [...slice(GO_CODEC, 'return Limits{').matchAll(/(\w+):\s*(\d+),/g)]
    .map((m) => [snake(m[1]), Number(m[2])] as [string, number]));

console.log('\nccwire.v1 schema conformance — codec.ts and codec.go vs the generated tables\n');

// ── 1. the Limits field set ──────────────────────────────────────────────────

console.log(`Limits: all ${SCHEMA_LIMITS.length} schema fields accounted for in both codecs:`);
for (const f of SCHEMA_LIMITS) {
  const inTs = f.name in LIMITS;
  const inGo = GO_LIMIT_FIELDS.includes(f.name);
  if (inTs && inGo) { check(f.name, true); continue; }
  if (!inTs && !inGo) { divergence(`limits-missing:${f.name}`, f.name, 'absent from TS and Go'); continue; }
  // One side only is never a known state: the two codecs would enforce
  // different bounds on the same negotiated frame.
  check(f.name, false, `TS ${inTs ? 'has' : 'MISSING'}, Go ${inGo ? 'has' : 'MISSING'}`);
}
for (const name of Object.keys(LIMITS)) {
  check(`TS LIMITS.${name} exists in the schema`, SCHEMA_LIMITS.some((f) => f.name === name),
    'not a Limits field in capabilities.proto');
}
for (const name of GO_LIMIT_FIELDS) {
  check(`Go Limits.${name} exists in the schema`, SCHEMA_LIMITS.some((f) => f.name === name),
    'not a Limits field in capabilities.proto');
}

// ── 2. the Limits values ─────────────────────────────────────────────────────
// The defaults are the server's binding values. A codec compiled with a LARGER
// one accepts frames the schema refuses.

console.log('\nLimits defaults match the value documented on the .proto field:');
for (const f of SCHEMA_LIMITS) {
  const want = DOCUMENTED.get(f.name);
  if (want === undefined) { check(`${f.name} is documented in capabilities.proto`, false); continue; }
  const ts = (LIMITS as Record<string, number>)[f.name];
  const go = GO_LIMIT_VALUES.get(f.name);
  if (ts === undefined && go === undefined) continue;   // already reported in §1
  check(`${f.name} = ${want}`, ts === want && go === want,
    `schema ${want}, TS ${ts ?? 'absent'}, Go ${go ?? 'absent'}`);
}

// ── 3. the 64-bit fields ─────────────────────────────────────────────────────
// T: 4 is ScalarType.UINT64. A uint64 read through a 32-bit mask wraps silently,
// which is the one failure mode jstype = JS_STRING exists to prevent.

console.log('\n64-bit Limits fields are not read through a 32-bit mask:');
{
  const client = read('lib/ccwire/client.ts');
  const masks32 = /function u32Of[\s\S]*?0xffffffffn/.test(client);
  const readsVia = /const take = \(dst: keyof typeof LIMITS, field: number\) => \{\s*const v = u32Of/.test(client);
  for (const f of SCHEMA_LIMITS.filter((x) => x.T === 4)) {
    if (!(f.name in LIMITS)) continue;   // already reported in §1
    if (masks32 && readsVia) divergence(`limits-width:${f.name}`, `${f.name} (uint64)`, 'client.ts reads it via u32Of');
    else check(`${f.name} (uint64)`, true);
  }
}

// ── 4. the Frame.body oneof ──────────────────────────────────────────────────
// The oneof is CLOSED. A number in one codec and not the other is a body one
// side routes and the other refuses as a protocol violation.

// From the `{`, not from `var`: the declaration itself contains both the array
// length and the `32` of `uint32`, which would count as entries.
const GO_BODY_FIELDS = [...slice(slice(GO_CODEC, 'var BodyFields = ', '\n}'), '{').matchAll(/(\d+)/g)]
  .map((m) => Number(m[1]));
const GO_BODY_CONSTS = new Map<number, string>(
  [...GO_CODEC.matchAll(/\tBody(\w+)\s+uint32 = (\d+)/g)]
    .map((m) => [Number(m[2]), m[1].toLowerCase()] as [number, string]));

console.log(`\nFrame.body: all ${SCHEMA_BODIES.length} oneof arms, same number and same name in both codecs:`);
{
  // `[28]uint32` — a wrong length would be a compile error in Go, so it is the
  // one place the array's own claim can be checked against the schema.
  const declared = /var BodyFields = \[(\d+)\]uint32/.exec(GO_CODEC)?.[1];
  check(`Go BodyFields is declared [${SCHEMA_BODIES.length}]uint32`,
    declared === String(SCHEMA_BODIES.length), `declared [${declared}]`);
  check(`Go BodyFields holds ${SCHEMA_BODIES.length} entries`,
    GO_BODY_FIELDS.length === SCHEMA_BODIES.length, `${GO_BODY_FIELDS.length}`);
}
for (const f of SCHEMA_BODIES) {
  const ts = BODY_NAMES[f.no];
  const go = GO_BODY_FIELDS.includes(f.no);
  // Go const names are CamelCase with no separator (BodyReAuth vs `reauth`), so
  // the comparison drops the underscores rather than guessing word boundaries.
  const goName = GO_BODY_CONSTS.get(f.no);
  check(`${f.no} ${f.name}`,
    ts === f.name && go && goName === f.name.replace(/_/g, ''),
    `TS ${ts ?? 'MISSING'}, Go ${go ? goName : 'MISSING'}`);
}
for (const n of Object.keys(BODY_NAMES).map(Number)) {
  check(`TS BODY_NAMES[${n}] is a real oneof arm`, SCHEMA_BODIES.some((f) => f.no === n),
    'not in the envelope.proto oneof');
}
for (const n of GO_BODY_FIELDS) {
  check(`Go BodyFields ${n} is a real oneof arm`, SCHEMA_BODIES.some((f) => f.no === n),
    'not in the envelope.proto oneof');
}

// ── 5. the ErrorCode mapping ─────────────────────────────────────────────────
// Both codecs map a refusal to a number the peer reads out of errors.proto. The
// numbers must exist there, the two codecs must agree, and the comment each
// writes beside a number must be the name the schema gives that number —
// a comment that has drifted is how the wrong number gets copied next.

const GO_ERRORS = new Map<string, string>(
  [...GO_CODEC.matchAll(/(Err\w+)\s+CodecError = "([A-Z_0-9]+)"/g)]
    .map((m) => [m[1], m[2]] as [string, string]));
const GO_ERROR_CODE = new Map<string, number>();
{
  const body = slice(GO_CODEC, 'func (e CodecError) ErrorCode() uint32 {');
  const fallback = Number(/default:\s*\n\s*return (\d+)/.exec(body)?.[1]);
  for (const name of GO_ERRORS.values()) GO_ERROR_CODE.set(name, fallback);
  for (const m of body.matchAll(/case ([^:\n]+):\s*\n\s*return (\d+)/g)) {
    for (const c of m[1].split(',')) {
      const name = GO_ERRORS.get(c.trim());
      if (name) GO_ERROR_CODE.set(name, Number(m[2]));
      else check(`Go switch case ${c.trim()} is a declared CodecError`, false);
    }
  }
  check('Go ErrorCode() has a default arm', Number.isFinite(fallback));
}

console.log('\nErrorCode: both codecs map every refusal to the same schema code:');
for (const name of Object.keys(ERROR_CODE)) {
  const ts = ERROR_CODE[name as keyof typeof ERROR_CODE];
  const go = GO_ERROR_CODE.get(name);
  check(`${name} → ${ts}`,
    go === ts && SCHEMA_ERROR_CODES.some((e) => e.no === ts),
    go !== ts ? `TS ${ts}, Go ${go ?? 'MISSING'}`
              : `${ts} is not an ErrorCode in errors.proto`);
}
for (const name of GO_ERROR_CODE.keys()) {
  check(`Go ${name} exists in codec.ts`, name in ERROR_CODE, 'TS has no such CodecError');
}

console.log('\nEvery ERROR_CODE_* comment names the number the schema gives it:');
for (const [file, src] of [
  ['lib/ccwire/codec.ts', read('lib/ccwire/codec.ts')],
  ['internal/ccwire/codec.go', GO_CODEC],
] as const) {
  for (const m of src.matchAll(/(\d+)[,;]?\s*\/\/\s*(ERROR_CODE_[A-Z_]+)/g)) {
    const want = SCHEMA_ERROR_CODES.find((e) => e.name === m[2]);
    check(`${file}: ${m[2]} = ${m[1]}`, want?.no === Number(m[1]),
      want ? `errors.proto says ${want.no}` : 'no such ErrorCode in errors.proto');
  }
}

// ── 6. AppEvent.event ────────────────────────────────────────────────────────
// Not a schema field-table question — .proto carries no length bound — but the
// same class of drift, and the one the two codecs actually differ on.

console.log('\nAppEvent.event is bounded the same on both sides:');
{
  const tsBound = /function readAppEvent[\s\S]*?field === 1 && wire === 2\) m\.event = readString\(r\)/
    .test(read('lib/ccwire/codec.ts')) ? LIMITS.max_string_field_bytes : null;
  const goBound = Number(/if t == 10 \{\s*\n\s*limit = (\d+)/
    .exec(read('vaultchat-backend-go/internal/realtime/ccwire_app_events.go'))?.[1]);
  check('the bound is readable on both sides', tsBound !== null && Number.isFinite(goBound),
    `TS ${tsBound}, Go ${goBound}`);
  if (tsBound !== null && Number.isFinite(goBound)) {
    if (tsBound !== goBound) divergence('appevent-event-bound', 'AppEvent.event bound', `TS ${tsBound}, Go ${goBound}`);
    else check(`AppEvent.event bound = ${tsBound}`, true);
  }
}

// ── the known list, reconciled ───────────────────────────────────────────────
// A KNOWN entry nothing raised is a divergence that was FIXED. The fix is to
// delete the line, so the guard says so instead of holding the door open.

console.log('\nEvery known divergence is still real:');
for (const id of KNOWN.keys()) {
  check(`${id} still diverges`, seen.has(id), 'no longer diverges — delete it from KNOWN');
}

console.log(failures
  ? `\n  ${failures} FAILED — a hand-written codec has drifted from proto/ccwire/v1\n`
  : `\n  all schema conformance checks passed (${KNOWN.size} known divergences recorded)\n`);
process.exit(failures ? 1 : 0);
