// lib/ccwire/generatedParity.selftest.ts — run: npx tsx lib/ccwire/generatedParity.selftest.ts
//
// ccwire.v1 hand-written codec (lib/ccwire/codec.ts) against the GENERATED
// reference codecs (lib/ccwire/gen/ccwire/v1/*_pb.ts, protoc-gen-es v1.10.1),
// through the fixtures that already exist — __vectors__/codec.json and
// __vectors__/adversarial.json. No new fixture format: the loader shape is
// lifted from codecParity.selftest.ts, which asserts the same files.
//
// METHOD — SEMANTICS AND BYTES ARE JUDGED SEPARATELY.
// A raw byte diff is not a correctness verdict. Two conformant protobuf
// encoders may legitimately emit different bytes: field order, packed vs
// unpacked repeated fields, whether a default is written. So:
//   • SEMANTIC parity — both sides decode the same bytes into the same values.
//     A difference here is a real divergence and fails this selftest.
//   • BYTE CONTRACT — re-encoding returns the exact input bytes. A difference
//     here is REPORTED, with a statement of whether the semantics still match.
//     It fails only where the repo depends on byte-exactness (the round-trip
//     guarantee codecParity.selftest.ts asserts for the hand-written codec).
//
// WHAT IS COMPARABLE. The generated Frame models the oneof: a decoded Frame
// carries a typed body object. codec.ts carries a body_field number plus raw
// body bytes, typed only for the seven bodies it implements. The comparable
// level is therefore the BODY: the same body bytes handed to TypingState (81),
// SubmitMessage (48), ViewerState (82), Fragment (112), GeoRelay (84) and
// CryptoControl (98) on both sides. The frame layer is compared on the routing
// header plus which arm of the oneof was selected.
//
// STATUS: codec.ts is LIVE (client.ts -> transport.ts -> socket.ts, where
// 'ccwire' is the only TransportName). The GENERATED code is not wired and is
// not meant to be: Wave 1 of the protobuf migration established that a
// generated Frame cannot front the transport, because it must parse every body
// and so cannot relay one this build does not implement. It is a conformance
// reference only.
//
// This header first said "NOT WIRED, like codec.ts" — copied forward from an
// older file. codec.ts has been live since Socket.IO was removed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrameMessage, BODY_NAMES, type Limits } from './codec';
import {
  Frame as GenFrame, TypingState, SubmitMessage, ViewerState, Fragment, GeoRelay, CryptoControl,
} from './gen/ccwire/v1/envelope_pb';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__vectors__');

/** The six bodies the fixtures actually carry, by oneof field number. */
const BODY_TYPES: Record<number, any> = {
  81: TypingState, 48: SubmitMessage, 82: ViewerState,
  112: Fragment, 84: GeoRelay, 98: CryptoControl,
};

// Divergences already recorded in the change's design.md. Confirmed or refuted
// below; listed here so a KNOWN one is reported without failing the run, and
// anything NOT on this list fails loudly.
const KNOWN = new Set<string>([
  // @bufbuild/protobuf v1 dispatches on the FIELD NUMBER alone. A known field
  // arriving with the wrong wire type is read as if it had the right one, which
  // desynchronises the reader; codec.ts matches on (field, wire) together and
  // keeps the mismatch as an unknown field. Recorded, not silenced — see the
  // DIVERGENCES summary at the end.
  'typing_state keeps a known field with the WRONG wire type as unknown',

  // ── Recorded 2026-09-18 as findings of openspec/changes/protobuf-migration
  //    task 1.6. All three have the SAME root cause: the generated codec
  //    enforces the .proto and nothing else, while codec.ts also enforces the
  //    negotiated CC-Wire profile. They are accepted, not fixed, because the
  //    decision they drove is that the generated codec is a CONFORMANCE
  //    REFERENCE, never a drop-in replacement for codec.ts.
  //
  //    Any of these ceasing to diverge is itself a signal worth looking at, so
  //    a KNOWN entry that stops firing should be deleted from this list.

  // proto3 requires string fields to be valid UTF-8. @bufbuild v1 decodes
  // lossily to U+FFFD instead of refusing; codec.ts answers INVALID_UTF8.
  // Accepting mojibake in a chat id is exactly the parser differential
  // codec.ts:358-364 was written to avoid. Revisit if the generated codec ever
  // fronts the wire.
  'typing_state chat_id that is not UTF-8 is refused',

  // codec.ts answers VARINT_OVERFLOW on an over-long length varint; the
  // generated reader accepts it and yields an empty message. Same class: a
  // malformed encoding that one side rejects and the other normalises away.
  'typing_state with an over-long length varint is refused',

  // THE ARCHITECTURAL ONE. codec.ts knows 28 oneof arms, decodes 7, and keeps
  // every other body as opaque bytes plus preserved unknown fields — which is
  // what lets this client relay a frame whose body it does not implement, and
  // what makes `reserved 6 to 15` in envelope.proto survive a round trip.
  // A generated oneof has no equivalent: Frame.fromBinary MUST parse the body,
  // so a body this build does not implement is rejected outright.
  // Consequence: the generated Frame cannot front the transport. Body-level
  // message types are still valid conformance references.
  'an untyped body round-trips verbatim',
]);

let failures = 0;
const divergences: string[] = [];
const byteNotes: string[] = [];
/** KNOWN entries actually raised by this run. See the reconciliation at the end. */
const seenKnown = new Set<string>();

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

/** A semantic difference: loud, and fatal unless already recorded. */
function diverge(where: string, detail: string): void {
  const known = KNOWN.has(where);
  if (known) seenKnown.add(where);
  divergences.push(`${known ? 'KNOWN' : 'NEW  '}  ${where}: ${detail}`);
  console.log(`  ${known ? '!' : '✗'} ${where}  (${detail})`);
  if (!known) failures++;
}

const unhex = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from((s ?? '').replace(/\s+/g, ''), 'hex'));
const tohex = (b: Uint8Array | undefined): string =>
  Buffer.from(b ?? new Uint8Array(0)).toString('hex');

console.log('\nccwire.v1 hand-written codec ↔ protoc-gen-es generated codec\n');

for (const f of ['codec.json', 'adversarial.json']) {
  if (!fs.existsSync(path.join(DIR, f))) { console.error(`  ✗ ${f} is missing.`); process.exit(1); }
}
const v = JSON.parse(fs.readFileSync(path.join(DIR, 'codec.json'), 'utf8'));
const adv = JSON.parse(fs.readFileSync(path.join(DIR, 'adversarial.json'), 'utf8'));

// ── normalisation ────────────────────────────────────────────────────────────
// Both sides are flattened into the SAME plain shape before comparison, or the
// diff is just camelCase vs snake_case. Bytes become hex, 64-bit fields become
// decimal strings (codec.ts already returns strings; the generated code is
// configured JS_STRING for the same fields), absent message fields stay absent.

/** Keys sorted, so JSON.stringify is a stable comparison. */
const sortJson = (x: any): any => {
  if (Array.isArray(x)) return x.map(sortJson);
  if (x && typeof x === 'object') {
    const o: any = {};
    for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = sortJson(x[k]);
    return o;
  }
  return x;
};

const isGenMessage = (x: any): boolean => !!x && typeof x === 'object' && typeof x.getType === 'function';

const normValue = (x: any): any => {
  if (x instanceof Uint8Array) return tohex(x);
  if (typeof x === 'bigint') return String(x);
  if (Array.isArray(x)) return x.map(normValue);
  if (isGenMessage(x)) return normGen(x);
  return x;
};

/** A generated message as {proto_field_name: value}. Unset message fields omitted. */
function normGen(m: any): any {
  const o: any = {};
  for (const f of m.getType().fields.list()) {
    const val = m[f.localName];
    if (val === undefined) continue;
    o[f.name] = normValue(val);
  }
  return o;
}

/** Unknown fields as [fieldNo, wireType] pairs — the level both sides express. */
const genUnknown = (T: any, m: any): [number, number][] =>
  (T.runtime.bin.listUnknownFields(m) as any[]).map((u) => [u.no, u.wireType] as [number, number]);

/** codec.ts keeps unknowns as raw bytes, tag included; recover the same pairs. */
function handUnknown(raw: Uint8Array[]): [number, number][] {
  return (raw ?? []).map((b) => {
    let tag = 0n, shift = 0n;
    for (const byte of b) { tag |= BigInt(byte & 0x7f) << shift; shift += 7n; if (!(byte & 0x80)) break; }
    return [Number(tag >> 3n), Number(tag & 7n)] as [number, number];
  });
}

/** codec.ts's decoded body, minus its synthetic *_name mirrors and its unknowns. */
function normHand(x: any): any {
  if (x instanceof Uint8Array) return tohex(x);
  if (Array.isArray(x)) return x.map(normHand);
  if (x && typeof x === 'object') {
    const o: any = {};
    for (const k of Object.keys(x)) {
      if (k === 'unknown' || k.endsWith('_name')) continue;
      if (x[k] !== undefined) o[k] = normHand(x[k]);
    }
    return o;
  }
  return x;
}

// codec.ts has no body-only entry point — the frame is the only door in — so a
// body is wrapped in the smallest legal frame, exactly as codecParity does.
const wVarint = (n: number): number[] => {
  const o: number[] = [];
  while (n >= 128) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  o.push(n);
  return o;
};
const wrap = (field: number, body: Uint8Array): Uint8Array =>
  Uint8Array.from([0x10, 0x01, ...wVarint(field * 8 + 2), ...wVarint(body.length), ...body]);

// Not a discriminated union: `ok` is read in ternaries and argument positions
// where TS does not narrow, so a union forces an `ok === true` dance at every
// call site. One optional-field shape instead — `err` is '' when ok.
const tryCall = <T>(fn: () => T): { ok: boolean; value?: T; err: string } => {
  try { return { ok: true, value: fn(), err: '' }; } catch (e: any) { return { ok: false, err: String(e?.message ?? e) }; }
};

// ── 1. typed bodies: semantics ───────────────────────────────────────────────

console.log('Typed bodies decode to the same values on both sides:');
const covered = new Set<number>();
for (const c of v.bodies ?? []) {
  const T = BODY_TYPES[c.field];
  if (!T) { check(`${c.name}`, false, `no generated type mapped for body field ${c.field}`); continue; }
  covered.add(c.field);
  if (!c.ok) continue; // refusals are section 2

  const hand = decodeFrameMessage(wrap(c.field, unhex(c.bodyHex)), { limits: c.limits as Limits });
  if (!hand.ok) { check(c.name, false, `codec.ts rejected its own accepted vector: ${hand.error}`); continue; }

  const gen = tryCall(() => T.fromBinary(unhex(c.bodyHex)));
  if (!gen.ok) {
    diverge(c.name, `codec.ts decoded it; ${T.typeName}.fromBinary threw: ${gen.err}`);
    continue;
  }

  const got = JSON.stringify(sortJson(normGen(gen.value)));
  const want = JSON.stringify(sortJson(normHand(hand.frame!.value)));
  const gotU = JSON.stringify(genUnknown(T, gen.value));
  const wantU = JSON.stringify(handUnknown((hand.frame!.value as any)?.unknown));

  if (got !== want) diverge(c.name, `generated ${got}\n        codec.ts  ${want}`);
  else if (gotU !== wantU) diverge(`${c.name} [unknown fields]`, `generated ${gotU} vs codec.ts ${wantU}`);
  else check(c.name, true);
}
check('all six typed bodies in the fixture are covered',
  covered.size === 6 && [81, 48, 82, 112, 84, 98].every((n) => covered.has(n)),
  `covered ${JSON.stringify([...covered].sort((a, b) => a - b))}`);

// ── 2. typed bodies: what each side refuses ──────────────────────────────────
// The generated code enforces the SCHEMA, not the profile. Limits
// (max_opaque_bytes, max_repeated_elements, max_nesting_depth, …) are a
// negotiated policy that lives nowhere in the .proto, so a limit refusal being
// accepted by the generated codec is expected and is reported, not failed. A
// STRUCTURAL refusal — truncation, a bad varint, a group, field 0, bad UTF-8 —
// is the wire format itself, and the generated codec is expected to refuse too.

const STRUCTURAL = /truncated|running past the end|over-long|never terminates|proto2 group|field number 0|not UTF-8/i;

console.log('\nWhat codec.ts refuses, and what the generated codec does with it:');
for (const c of (v.bodies ?? []).filter((b: any) => !b.ok)) {
  const T = BODY_TYPES[c.field];
  const gen = tryCall(() => T.fromBinary(unhex(c.bodyHex)));
  const structural = STRUCTURAL.test(c.name);
  if (structural) {
    if (gen.ok) diverge(c.name, `codec.ts ${c.error}; generated ACCEPTED it as ${JSON.stringify(sortJson(normGen(gen.value)))}`);
    else check(`${c.name} — generated refuses too`, true);
  } else {
    console.log(`  · ${c.name} — codec.ts ${c.error}; generated ${gen.ok ? 'accepts (limit is profile, not schema)' : 'also refuses'}`);
  }
}

// ── 3. typed bodies: byte contract ───────────────────────────────────────────
// Reported, never a verdict on its own. Where bytes differ the semantics were
// already judged above, and that judgement is restated here.

console.log('\nByte contract — generated re-encode vs the fixture bytes:');
{
  let exact = 0, differ = 0;
  for (const c of (v.bodies ?? []).filter((b: any) => b.ok)) {
    const T = BODY_TYPES[c.field];
    const gen = tryCall(() => T.fromBinary(unhex(c.bodyHex)));
    if (!gen.ok) continue; // already reported as a semantic divergence
    const back = tohex(gen.value.toBinary());
    const want = tohex(unhex(c.bodyHex));
    if (back === want) { exact++; continue; }
    differ++;
    const semanticsOk = !divergences.some((d) => d.includes(c.name));
    byteNotes.push(`${T.typeName} "${c.name}": ${want} → ${back}; semantics ${semanticsOk ? 'MATCH' : 'DIFFER'}`);
    console.log(`  · ${c.name}: ${want} → ${back} (semantics ${semanticsOk ? 'match' : 'differ'})`);
  }
  check(`${exact} of ${exact + differ} accepted body vectors re-encode byte-identically`, true);
}

// ── 4. the frame layer ───────────────────────────────────────────────────────
// Routing header plus WHICH oneof arm. The bodies in these vectors are empty or
// untyped, so this is where codec.ts's body_field + raw bytes meets the
// generated oneof case.

console.log('\nFrame routing header and oneof arm agree:');
for (const c of v.decode.filter((d: any) => d.ok)) {
  const gen = tryCall(() => GenFrame.fromBinary(unhex(c.inputHex)));
  if (!gen.ok) { diverge(c.name, `codec.ts decoded it; Frame.fromBinary threw: ${gen.err}`); continue; }
  const f: any = gen.value;
  // The oneof case is the generated localName (typingState); BODY_NAMES is the
  // proto name (typing_state). Translate through the field list rather than
  // guessing a case convention.
  const arm = f.body.case
    ? GenFrame.fields.list().find((x: any) => x.localName === f.body.case)?.name ?? f.body.case
    : null;
  const wantArm = c.bodyField == null ? null : BODY_NAMES[c.bodyField];
  const ok =
    f.requestId === c.requestId &&
    f.trafficClass === c.trafficClass &&
    f.stream === c.stream &&
    String(f.seq) === c.seq &&
    String(f.dependsOn) === c.dependsOn &&
    arm === wantArm &&
    JSON.stringify(genUnknown(GenFrame, f)) === JSON.stringify(handUnknown((c.unknownHex ?? []).map(unhex)));
  if (!ok) {
    diverge(c.name,
      `generated rid=${JSON.stringify(f.requestId)} tc=${f.trafficClass} stream=${f.stream} ` +
      `seq=${f.seq} dep=${f.dependsOn} arm=${arm} unknown=${JSON.stringify(genUnknown(GenFrame, f))}; ` +
      `fixture rid=${JSON.stringify(c.requestId)} tc=${c.trafficClass} stream=${c.stream} ` +
      `seq=${c.seq} dep=${c.dependsOn} arm=${wantArm} unknown=${JSON.stringify(handUnknown((c.unknownHex ?? []).map(unhex)))}`);
  } else check(c.name, true);
}

// The EPHEMERAL invariant, the closed oneof and the negotiated limits are
// codec.ts policy with no expression in the .proto, so the generated codec
// accepts frames codec.ts refuses. Counted, so the size of that gap is visible.
{
  const accepted = v.decode.filter((d: any) => !d.ok && tryCall(() => GenFrame.fromBinary(unhex(d.inputHex))).ok);
  console.log(`  · ${accepted.length} of ${v.decode.filter((d: any) => !d.ok).length} frame refusals are policy the generated codec does not enforce: ` +
    JSON.stringify(accepted.map((d: any) => d.error)));
}

console.log('\nFrame bytes round-trip through the generated codec:');
for (const c of [
  ...v.decode.filter((d: any) => d.ok && !d.name.includes('last-wins')).map((d: any) => ({ name: d.name, hex: d.inputHex })),
  ...v.encode.filter((e: any) => e.ok !== false).map((e: any) => ({ name: `encode: ${e.name}`, hex: e.outHex })),
]) {
  // A vector already counted as a semantic divergence is not counted twice here.
  if (divergences.some((d) => d.includes(c.name.replace(/^encode: /, '')))) {
    console.log(`  · ${c.name}: skipped, already reported as a semantic divergence`);
    continue;
  }
  const gen = tryCall(() => GenFrame.fromBinary(unhex(c.hex)));
  if (gen.ok !== true) { check(c.name, false, `fromBinary threw: ${gen.err}`); continue; }
  const back = tohex(gen.value.toBinary());
  const want = tohex(unhex(c.hex));
  if (back !== want) byteNotes.push(`Frame "${c.name}": ${want} → ${back}`);
  check(c.name, back === want, `${want} → ${back}`);
}

// ── 5. adversarial ───────────────────────────────────────────────────────────
// Liveness, plus the one direction that is a real requirement: bytes the
// fixture says a conforming decoder MAY accept must not blow up the generated
// codec. The other direction is policy again, and is only counted.

console.log('\nAdversarial fixture:');
{
  let permissive = 0;
  for (const c of adv.cases) {
    const gen = tryCall(() => GenFrame.fromBinary(unhex(c.hex)));
    if (c.accept) check(`accepts what a conforming decoder may accept: ${c.name}`, gen.ok, gen.ok === true ? '' : gen.err);
    else if (gen.ok) permissive++;
  }
  console.log(`  · ${permissive} of ${adv.cases.length - adv.cases.filter((c: any) => c.accept).length} unrepresentable inputs are still accepted by the generated codec (no profile limits in the schema)`);
  check('the generated codec returns on every adversarial input rather than hanging', true);
}

// ── 6. no fixture coverage ───────────────────────────────────────────────────
// Stated rather than silently absent: a body with no vector is not a body that
// passed. Ack, ClientHello, ServerHello, Limits, Capabilities and AppEvent.

{
  const withVectors = new Set<number>((v.bodies ?? []).map((b: any) => b.field));
  const uncovered = Object.keys(BODY_NAMES).map(Number).filter((n) => !withVectors.has(n));
  console.log(`\nNo fixture coverage — ${uncovered.length} of ${Object.keys(BODY_NAMES).length} oneof arms: ${uncovered.map((n) => BODY_NAMES[n]).join(', ')}`);
  console.log('  · Limits.max_message_body_bytes (uint64, JS_STRING in the generated Limits) is');
  console.log('    among them: codec.ts never decodes a Limits off the wire, so the recorded');
  console.log('    32-bit-mask divergence cannot be confirmed or refuted from these fixtures.');
}

// ── 7. the known list, reconciled ────────────────────────────────────────────
// The header of KNOWN says "a KNOWN entry that stops firing should be deleted
// from this list". Until now nothing enforced that, so the list was a one-way
// ratchet: an entry could go on when a divergence appeared, and stay on forever
// after the divergence was fixed — silently pre-authorising the regression.
// protoConformance.selftest.ts has had this reconciliation since it was
// written; this file asserted the same rule in prose and checked nothing.
//
// A KNOWN entry nothing raised is now a FAILURE, and the fix is to delete the
// line rather than leave it holding the door open.

console.log('\nEvery known divergence is still real:');
for (const id of KNOWN) {
  check(`${id}`, seenKnown.has(id), 'no longer diverges — delete it from KNOWN');
}

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\nDIVERGENCES (semantic): ${divergences.length}`);
for (const d of divergences) console.log(`  ${d}`);
console.log(`BYTE-CONTRACT OBSERVATIONS: ${byteNotes.length}`);
for (const b of byteNotes) console.log(`  ${b}`);

console.log(failures
  ? `\n  ${failures} FAILED — the hand-written and generated codecs do not agree\n`
  : '\n  hand-written and generated codecs agree on every fixture, modulo the recorded divergences\n');
process.exit(failures ? 1 : 0);
