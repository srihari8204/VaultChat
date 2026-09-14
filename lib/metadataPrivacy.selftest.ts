// lib/metadataPrivacy.selftest.ts — run: npx tsx lib/metadataPrivacy.selftest.ts
//
// WHAT THIS PROTECTS
//
// The routing allow-list — "what the server is allowed to learn about a
// message" — now exists in FOUR places:
//
//   1. lib/msgEnvelope.ts            META_PUBLIC_KEYS   (what the client SENDS)
//   2. internal/jobs/meta_public.go  MetaPublicKeys     (what the server KEEPS)
//   3. proto/ccwire/v1/envelope.proto  message PublicMeta (the future wire)
//   4. lib/ccwire/codec.ts           interface PublicMeta (that wire's decoder)
//
// The SET EQUALITY between those four is covered, and is NOT repeated here:
//
//   TS = Go        lib/msgEnvelope.selftest.ts
//   Go = proto     vaultchat-backend-go/internal/jobs/meta_public_proto_test.go
//   proto = codec  scripts/acceptance.selftest.ts §A4
//
// That closes the loop. Overlap is not coverage, it is a second place to update.
//
// This file asserts what none of those do. First, the codec's PublicMeta
// *implementation*: acceptance §A4 compares the TypeScript interface, but a
// field can be declared in the interface and missing from readPublicMeta or
// writePublicMeta — in which case it survives every allow-list check and still
// vanishes on the wire.
//
// Second, and mainly, the NEGATIVE half of the contract. envelope.proto lists five
// fields that are deliberately absent from Envelope — sender_uid, client_ts,
// content_length, reply_to, content_type — each with a reason. That list lives
// in a COMMENT, so a naive substring search for "reply_to" finds the comment
// that forbids it and passes on a file that declares it. Every source read here
// is comment-stripped first, for exactly that reason.
//
// This file asserts only. It changes no behaviour and reads no runtime state.
// See docs/METADATA_PRIVACY.md for the audit it belongs to — in particular for
// the retained routing columns (messages.type, messages.reply_to_id) that this
// allow-list does NOT cover and that cannot be fixed without a wire break.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { META_PUBLIC_KEYS } from './msgEnvelope';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}

/**
 * Remove `//` line comments so an assertion tests the CODE and not the prose
 * describing it. Mirrors stripLineComments in
 * vaultchat-backend-go/internal/realtime/payload_bounds_test.go, deliberately
 * naive for the same reason: it is only ever used to make a search STRICTER,
 * never to accept something. (A `//` inside a string literal would truncate the
 * line — none of the three files read here has one.)
 */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

function read(...parts: string[]): string {
  return stripLineComments(readFileSync(join(ROOT, ...parts), 'utf8'));
}

/**
 * Extract the body of `<kind> <Name> ... {...}` from comment-stripped source.
 * `[^{\n]*` skips a function signature without ever crossing a line break, so
 * this cannot silently latch onto a later declaration of the same kind.
 */
function block(src: string, kind: string, name: string): string {
  const re = new RegExp(`${kind}\\s+${name}\\b[^{\\n]*\\{([\\s\\S]*?)\\n\\}`);
  const m = src.match(re);
  return m?.[1] ?? '';
}

const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const protoSrc = read('proto', 'ccwire', 'v1', 'envelope.proto');
const codecSrc = read('lib', 'ccwire', 'codec.ts');
const goSrc = read('vaultchat-backend-go', 'internal', 'jobs', 'meta_public.go');

// ── source 3: the .proto ──────────────────────────────────────────────────
console.log('\nenvelope.proto is readable as a source of truth:');
const protoMeta = block(protoSrc, 'message', 'PublicMeta');
// `[repeated] <type> <name> = <n>;`
const protoKeys = [...protoMeta.matchAll(/(\w+)\s*=\s*\d+\s*;/g)].map((m) => snakeToCamel(m[1]));
check('message PublicMeta was found and parsed', protoKeys.length > 0, `parsed: ${protoKeys.length}`);

// ── source 4: the decoder that implements it ──────────────────────────────
const codecMeta = block(codecSrc, 'interface', 'PublicMeta');
const codecKeys = [...codecMeta.matchAll(/(\w+)\??\s*:/g)]
  .map((m) => snakeToCamel(m[1]))
  // `unknown` is the preserved-unknown-fields sidecar every message in codec.ts
  // carries (envelope.proto: "unknown fields = PRESERVED"). It is not a field.
  .filter((k) => k !== 'unknown');
check('codec.ts interface PublicMeta was found and parsed', codecKeys.length > 0, `parsed: ${codecKeys.length}`);

// ── set equality is asserted ELSEWHERE — deliberately not repeated here ───
//
// scripts/acceptance.selftest.ts (§A4) pins META_PUBLIC_KEYS against the .proto
// and against codec.ts's PublicMeta *interface*, including field-number
// contiguity. internal/jobs/meta_public_proto_test.go pins the GO list against
// the .proto, which is the leg neither TypeScript suite can reach.
//
// Together those close the loop: TS=Go (msgEnvelope.selftest.ts), Go=proto (the
// Go test), proto=codec (acceptance §A4). Repeating the equality a fourth time
// here would not be coverage, only a fourth place to update. The keys are still
// parsed above because the checks below need the names.
//
// What follows is what none of them assert.

// The decoder must also implement every field it declares, or a field is
// silently dropped (readable in the type, absent from the wire) — which reads
// as "the allow-list is honoured" while the opposite is true.
console.log('\nThe decoder actually reads and writes every field it declares:');
const readFn = block(codecSrc, 'function', 'readPublicMeta');
const writeFn = block(codecSrc, 'function', 'writePublicMeta');
for (const key of protoKeys) {
  const snake = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  check(`${snake} is decoded and encoded`,
    readFn.includes(snake) && writeFn.includes(snake));
}

// ── the deliberately-absent fields ────────────────────────────────────────
//
// Each of these is named ONLY in a comment in envelope.proto, which is why the
// source is comment-stripped above: an un-stripped search would match the
// prohibition itself and pass on a file that had added the field.
console.log('\nEnvelope still refuses the five fields it was built without:');
const protoEnvelope = block(protoSrc, 'message', 'Envelope');
const codecEnvelope = block(codecSrc, 'interface', 'Envelope');
const ABSENT: Record<string, string> = {
  sender_uid: 'server stamps it on delivery; a client field re-creates the typing_start spoof',
  client_ts: 'a client clock the server would have to trust or ignore',
  content_length: 'a side channel on short messages',
  reply_to: 'a conversation graph the server has no need to build',
  content_type: 'MIME is content — private in META_PUBLIC_KEYS and stays private',
};
for (const [field, why] of Object.entries(ABSENT)) {
  check(`envelope.proto Envelope declares no ${field} (${why})`, !protoEnvelope.includes(field));
  check(`codec.ts Envelope declares no ${snakeToCamel(field)}`,
    !codecEnvelope.includes(field) && !codecEnvelope.includes(snakeToCamel(field)));
}
// The prohibition is worth nothing if the comment that carries the reasoning is
// deleted along with it — the next person adds sender_uid and there is no
// record of why it was refused.
console.log('\n...and the reasoning survives in the file, not only in this test:');
const protoRaw = readFileSync(join(ROOT, 'proto', 'ccwire', 'v1', 'envelope.proto'), 'utf8');
for (const field of Object.keys(ABSENT)) {
  check(`${field} is still listed as deliberately absent`,
    protoRaw.includes(field), 'the NOT PRESENT block lost an entry');
}

// ── the allow-list is still an allow-list ─────────────────────────────────
//
// Both implementations must select what is PUBLIC. The failure mode this rules
// out is a rewrite to a deny-list, which fails open: the next meta field ships
// server-visible and nobody notices until an audit.
console.log('\nBoth splits are allow-lists, not deny-lists:');
const tsSrc = read('lib', 'msgEnvelope.ts');
check('msgEnvelope splitMeta branches on membership of the public set',
  /if\s*\(PUBLIC\.has\(k\)\)\s*pub\[k\]/.test(tsSrc), 'splitMeta no longer selects by allow-list');
check('jobs.SplitMeta branches on MetaPublicKeySet',
  /if\s+MetaPublicKeySet\[k\]\s*\{/.test(goSrc), 'SplitMeta no longer selects by allow-list');
// The delete-on-delivery sweep is the third writer of messages.meta and the one
// that runs against rows written before the split existed. It must rebuild meta
// from the allow-list parameter, never merely subtract known-bad keys.
const jobsSrc = read('vaultchat-backend-go', 'internal', 'jobs', 'jobs.go');
const sweep = jobsSrc.match(/const deliveredMessagesSQL = `([\s\S]*?)`/)?.[1] ?? '';
check('the delete-on-delivery sweep was found', sweep.length > 0);
check('it rebuilds meta from the allow-list parameter',
  sweep.includes('e.key = ANY($4::text[])'), 'the sweep stopped filtering meta by the allow-list');
check('...and is passed MetaPublicKeys as that parameter',
  /deliveredMessagesSQL,[\s\S]{0,120}MetaPublicKeys/.test(jobsSrc));
check('it re-derives optionCount so poll votes stay bounds-checkable',
  sweep.includes("'optionCount'"));
check('it re-derives mentionUserIds so mute-override survives without names',
  sweep.includes("'mentionUserIds'") && sweep.includes("x->>'userId'"));

// ── the leak that started all of this ─────────────────────────────────────
// Pinned by NAME in every source, because "thumb" is the field that was
// measured on production: 22 of 24 image/video messages carried a base64 JPEG
// preview the server could read.
console.log('\nThe measured leak cannot return through any of the four doors:');
for (const leak of ['thumb', 'filename', 'mime', 'waveform', 'options', 'mentions', 'linkPreview']) {
  check(`${leak} is not on the client allow-list`, !META_PUBLIC_KEYS.includes(leak));
  check(`${leak} is not a PublicMeta field`, !protoKeys.includes(leak) && !codecKeys.includes(leak));
}

assert.ok(true);
console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
