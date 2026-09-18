// scripts/acceptance.selftest.ts — run: npx tsx scripts/acceptance.selftest.ts
//
// The EXECUTABLE half of docs/ACCEPTANCE.md.
//
// docs/ACCEPTANCE.md catalogues every §20 acceptance criterion and sorts each
// into one of four buckets: (a) runnable here, (b) needs a deployed server,
// (c) needs two real handsets, (d) needs hardware/credentials nobody has. This
// file is bucket (a), and ONLY bucket (a). A criterion that cannot be executed
// from a checkout is not asserted here under a weaker proxy — it is listed in
// the doc as not run, because a green tick that was never earned retires the
// suspicion without answering it.
//
// Two bucket-(a) criteria are NOT in this file and cannot be: §20.23 (every
// migration applies, every migrations/tests/*.sql passes) and §20.18 (RLS
// denies cross-tenant reads) need a Postgres to talk to. They are executed by
// `node scripts/test-migrations.js` and by the DB-gated Go tests in
// internal/routes — both of which SKIP rather than fail without one, which is
// why they stay out of a file whose whole contract is "this always runs".
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// Overlap with an existing suite is not coverage, it is a second place to
// update. So this file does NOT re-check:
//   • Go↔TS frame vectors            — lib/ccwire/parity.selftest.ts
//   • TS↔Rust ccwire.v1.Frame vectors — lib/ccwire/codecParity.selftest.ts
//   • BODY_NAMES / LIMITS vs .proto   — lib/ccwire/codec.selftest.ts
//   • META_PUBLIC_KEYS vs the Go list — lib/msgEnvelope.selftest.ts
// It checks the joins BETWEEN those suites, which is where nothing was looking:
// the two fixtures against each other, and the .proto against the allow-list
// (which envelope.proto itself says MUST exist, and did not).
//
// SOURCE-READING ASSERTIONS STRIP COMMENTS FIRST. Every rule in this repo is
// written down next to the code that implements it, so a raw substring search
// matches the prose describing the rule and passes on a file that has lost the
// rule. Same reasoning, same fix as stripLineComments in
// vaultchat-backend-go/internal/realtime/payload_bounds_test.go.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  encodeFrame, decodeFrame, FRAMING_VERSION, HEADER_BYTES, MAX_FRAME_BYTES,
} from '../lib/ccwire/frame';
import {
  decodeFrameMessage, encodeFrameMessage, LIMITS, ERROR_CODE, TRAFFIC_CLASS_EPHEMERAL,
} from '../lib/ccwire/codec';
import { META_PUBLIC_KEYS } from '../lib/msgEnvelope';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// Remove line and block comments. Naive about a string literal containing "//",
// which is safe because this is only ever used to make an assertion STRICTER —
// never to accept something it would otherwise have refused.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const sorted = (a: readonly string[]) => [...a].sort();
const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

console.log('\nVaultChat acceptance criteria — bucket (a), executable here\n');

// ═══════════════════════════════════════════════════════════════════════════
// A1. The comment stripper actually strips.
//
// Every source-reading assertion below is only as strong as this. envelope.proto
// names four fields in a comment explaining why they are ABSENT from Envelope;
// if the stripper stopped working, a search for one of those names would find
// the prose and conclude the field exists. So prove the removal, don't assume it.
// ═══════════════════════════════════════════════════════════════════════════
console.log('The comment stripper is load-bearing, so it is checked first:');
{
  const raw = read('proto', 'ccwire', 'v1', 'envelope.proto');
  const cooked = stripComments(raw);
  check('envelope.proto mentions content_type only in prose',
    raw.includes('content_type') && !cooked.includes('content_type'),
    `raw=${raw.includes('content_type')} stripped=${cooked.includes('content_type')}`);
  check('stripping removes bulk, not everything',
    cooked.length > 400 && cooked.length < raw.length * 0.5,
    `${raw.length} → ${cooked.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// A2. CC-Wire agrees across all three implementations.
//
// Two fixtures exist and each is asserted by two languages:
//   __vectors__/frame.json — generated by GO, asserted by Go and by TypeScript
//   __vectors__/codec.json — hand-written from the protobuf spec, asserted by
//                            RUST and by TypeScript
// TypeScript is in both, so TS is the hinge — and nothing anywhere compared the
// two fixtures to EACH OTHER. Go's hard framing ceiling and Rust's negotiated
// frame limit are different numbers by design; the invariant that binds them
// (negotiated ≤ hard) lives only in a code comment in codec.ts. Asserted here.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nCC-Wire: the Go fixture, the Rust fixture and TypeScript are one set:');
{
  const fjPath = path.join(ROOT, 'lib', 'ccwire', '__vectors__', 'frame.json');
  const cjPath = path.join(ROOT, 'lib', 'ccwire', '__vectors__', 'codec.json');
  check('both committed fixtures exist', fs.existsSync(fjPath) && fs.existsSync(cjPath));
  const fj = JSON.parse(fs.readFileSync(fjPath, 'utf8'));
  const cj = JSON.parse(fs.readFileSync(cjPath, 'utf8'));

  check('the Go fixture still carries its vectors',
    fj.encode?.length > 0 && fj.decode?.length > 0 && fj.stream?.length > 0,
    `encode=${fj.encode?.length} decode=${fj.decode?.length} stream=${fj.stream?.length}`);
  check('the Rust fixture still carries its vectors',
    cj.decode?.length > 0 && cj.encode?.length > 0,
    `decode=${cj.decode?.length} encode=${cj.encode?.length}`);

  // The hinge: TS holds the same numbers each fixture's other language holds.
  check('framing layer: Go fixture = TypeScript',
    fj.framingVersion === FRAMING_VERSION && fj.headerBytes === HEADER_BYTES
    && fj.maxFrameBytes === MAX_FRAME_BYTES);
  check('message layer: Rust fixture = TypeScript',
    Object.entries(cj.limits).every(([k, v]) => (LIMITS as any)[k] === v),
    JSON.stringify(cj.limits));

  // …therefore Go and Rust, which share no fixture and no test, agree too.
  check('negotiated frame limit (Rust side) fits inside the hard ceiling (Go side)',
    cj.limits.max_frame_bytes <= fj.maxFrameBytes,
    `${cj.limits.max_frame_bytes} > ${fj.maxFrameBytes}`);
  check('the EPHEMERAL traffic class number agrees',
    cj.trafficClassEphemeral === TRAFFIC_CLASS_EPHEMERAL);
}

// ═══════════════════════════════════════════════════════════════════════════
// A3. The bounds refuse what they must — and are mutually consistent.
//
// codec.selftest.ts already hammers the decoder with hostile bytes. What it does
// not do is check the numbers against EACH OTHER. A limit set can be individually
// correct and collectively impossible: if max_fragments_per_message × frame size
// were below max_message_body_bytes, a message the protocol says is legal could
// never be sent, and no single-value assertion would notice.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nccwire.v1.Frame bounds refuse what they must:');
{
  // Refusal happens before allocation: a declared 3 MiB length in a 5-byte buffer.
  const header = new Uint8Array([FRAMING_VERSION, 0x00, 0x30, 0x00, 0x00]);
  const over = decodeFrame(header);
  check('a length above the ceiling is refused before any allocation',
    !over.ok && over.error === 'LENGTH_OVER_MAX', JSON.stringify(over));

  let threw = false;
  try { encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1)); } catch { threw = true; }
  check('encodeFrame refuses to produce an over-ceiling frame', threw);

  const big = decodeFrameMessage(new Uint8Array(LIMITS.max_frame_bytes + 1));
  check('a payload over the negotiated frame size is SIZE_OVER_MAX',
    !big.ok && big.error === 'SIZE_OVER_MAX' && big.errorCode === ERROR_CODE.SIZE_OVER_MAX,
    JSON.stringify(big));

  // envelope.proto: "A crypto_control or device_event in an EPHEMERAL frame is a
  // protocol violation and MUST be refused — never handled leniently."
  const bad = encodeFrameMessage({
    traffic_class: TRAFFIC_CLASS_EPHEMERAL, stream: 5, body_field: 98, raw: new Uint8Array(0),
  } as any);
  check('crypto_control in an EPHEMERAL frame is refused at ENCODE too',
    !bad.ok && bad.errorCode === ERROR_CODE.PROTOCOL_VIOLATION, JSON.stringify(bad));
  const ok = encodeFrameMessage({
    traffic_class: TRAFFIC_CLASS_EPHEMERAL, stream: 5, body_field: 81, raw: new Uint8Array(0),
  } as any);
  check('typing_state in an EPHEMERAL frame is still accepted', ok.ok, JSON.stringify(ok));

  // Collective consistency — nothing else checks these.
  check('a max-size message body is actually sendable as fragments',
    LIMITS.max_fragments_per_message * LIMITS.max_frame_bytes >= LIMITS.max_message_body_bytes,
    `${LIMITS.max_fragments_per_message} × ${LIMITS.max_frame_bytes} < ${LIMITS.max_message_body_bytes}`);
  check('an opaque field cannot exceed the frame that must carry it',
    LIMITS.max_opaque_bytes < LIMITS.max_frame_bytes);
  check('a string field cannot exceed an opaque field',
    LIMITS.max_string_field_bytes < LIMITS.max_opaque_bytes);
  check('the negotiated frame size is below the hard ceiling',
    LIMITS.max_frame_bytes < MAX_FRAME_BYTES);
}

// ═══════════════════════════════════════════════════════════════════════════
// A4. The metadata allow-list has ONE definition, in four places.
//
// envelope.proto, in the PublicMeta message itself:
//
//   "The cross-language assertion in msgEnvelope.selftest.ts (which reads the Go
//    source) MUST be extended to read this .proto as a third source of truth —
//    otherwise CC-Wire becomes the drift path the selftest exists to prevent."
//
// It had not been. msgEnvelope.selftest.ts pins TypeScript against Go; this pins
// the .proto and the CC-Wire decoder against the same list. A field added to
// PublicMeta but not to META_PUBLIC_KEYS is a server-visible metadata leak that
// ships with nothing objecting — which is the exact failure the allow-list exists
// to make impossible.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nPublicMeta is the META_PUBLIC_KEYS allow-list, verbatim:');
{
  // Declared fields plus the numbers `reserved` accounts for. A RETIRED field
  // must leave a `reserved N;` behind — that is protobuf's own rule, and the
  // contiguity check below is what makes forgetting it impossible. Only NUMBER
  // reservations are collected: `reserved "old_name";` reserves a name, retires
  // no number, and must not excuse a gap.
  function parseMessage(src: string, name: string) {
    const body = stripComments(src).match(new RegExp(`message\\s+${name}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    const fields = [...body.matchAll(/^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)\s*;/gm)]
      .map((m) => ({ name: m[1], num: Number(m[2]) }));
    const top = Math.max(0, ...fields.map((f) => f.num));   // `to max` clamps here
    const reserved: number[] = [];
    for (const r of body.matchAll(/^\s*reserved\s+([^;]*);/gm)) {
      for (const part of r[1].split(',')) {
        const range = part.trim().match(/^(\d+)\s+to\s+(\d+|max)$/);
        if (range) {
          const end = range[2] === 'max' ? top : Number(range[2]);
          for (let i = Number(range[1]); i <= end; i++) reserved.push(i);
        } else if (/^\d+$/.test(part.trim())) reserved.push(Number(part.trim()));
      }
    }
    return { fields, reserved };
  }

  // Used ∪ reserved is exactly 1..N, each number once. A skipped number is not
  // in either set (fails); a reused number appears twice (fails); a number both
  // declared and reserved appears twice (fails); a retired number is present
  // exactly once, via `reserved` (passes). Same guarantee, retirement allowed.
  const contiguous = (m: { fields: { num: number }[]; reserved: number[] }) => {
    const nums = [...m.fields.map((f) => f.num), ...m.reserved];
    return same(nums.map(String), nums.map((_, i) => String(i + 1)));
  };

  const meta = parseMessage(read('proto', 'ccwire', 'v1', 'envelope.proto'), 'PublicMeta');
  const fields = meta.fields;

  check('the PublicMeta message was found and parsed', fields.length > 0,
    `parsed ${fields.length} fields`);
  check('its field numbers are 1..n with no gap and no reuse (a gap MUST be `reserved`)',
    contiguous(meta),
    `${fields.map((f) => `${f.num}:${f.name}`).join(' ')} reserved=[${meta.reserved}]`);

  const fromProto = fields.map((f) => snakeToCamel(f.name));
  check(`the .proto and META_PUBLIC_KEYS hold the same ${META_PUBLIC_KEYS.length} keys`,
    same(fromProto, META_PUBLIC_KEYS),
    `proto=${JSON.stringify(sorted(fromProto))} ts=${JSON.stringify(sorted(META_PUBLIC_KEYS))}`);

  // The CC-Wire decoder materialises these by name. If it drops one, the field
  // survives the .proto and the allow-list and still vanishes on the wire.
  const codecSrc = stripComments(read('lib', 'ccwire', 'codec.ts'));
  const iface = codecSrc.match(/export\s+interface\s+PublicMeta\s*\{([^}]*)\}/)?.[1] ?? '';
  const decoded = [...iface.matchAll(/(\w+)\??\s*:/g)].map((m) => m[1]).filter((n) => n !== 'unknown');
  check('the CC-Wire decoder types exactly those fields',
    same(decoded, fields.map((f) => f.name)),
    `codec=${JSON.stringify(sorted(decoded))}`);

  // Pinned individually: server code reads these by name, so losing one from the
  // list is a feature that stops working silently rather than a test that fails.
  for (const k of ['attachmentId', 'viewOnce', 'silent', 'groupId', 'game', 'room']) {
    check(`${k} survives all four definitions`,
      META_PUBLIC_KEYS.includes(k) && fromProto.includes(k));
  }

  // The rule above is only worth what it REFUSES, and the .proto has no
  // `reserved` in PublicMeta today — so the refusals are proven against
  // synthetic messages here rather than by editing the schema.
  // One declaration per line, as in the real .proto: the field and reserved
  // patterns are line-anchored so a name inside a string or an expression
  // cannot be read as a declaration.
  const synth = (lines: string[]) => contiguous(parseMessage(`message T {\n${lines.join('\n')}\n}`, 'T'));
  for (const [why, src, want] of [
    ['a clean 1..n passes',                     ['string a = 1;', 'bool b = 2;'], true],
    ['an UNRESERVED gap is refused',            ['string a = 1;', 'bool c = 3;'], false],
    ['a REUSED number is refused',              ['string a = 1;', 'bool b = 1;'], false],
    ['a gap closed by `reserved` passes',       ['string a = 1;', 'reserved 2;', 'bool c = 3;'], true],
    ['`reserved N to M` passes',                ['string a = 1;', 'reserved 2 to 4;', 'bool e = 5;'], true],
    ['`reserved "name"` does not excuse a gap', ['string a = 1;', 'reserved "b";', 'bool c = 3;'], false],
    ['reserving a LIVE number is refused',      ['string a = 1;', 'bool b = 2;', 'reserved 2;'], false],
    ['a `reserved` in a comment does not count', ['string a = 1;', '// reserved 2;', 'bool c = 3;'], false],
  ] as [string, string[], boolean][]) {
    check(`retirement rule: ${why}`, synth(src) === want, `got ${synth(src)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A5. Every route resolves; no screen is a dead file.
//
// expo-router is filesystem-routed, so a navigation target is a string that is
// only checked when a user taps the thing. Two static facts can stand in for the
// tap: every file under app/ exports a component for the router to mount, and
// every statically-written navigation target names a file that exists.
//
// Only STATIC targets are checked. A target built from a variable
// (`router.push(next)`) is genuinely unknowable here and is not counted as
// verified — see docs/ACCEPTANCE.md, which says so rather than rounding up.
// ═══════════════════════════════════════════════════════════════════════════
console.log('\nEvery app route resolves:');
{
  const walk = (d: string, out: string[] = []): string[] => {
    let es: fs.Dirent[];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  };
  const isSrc = (f: string) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f);
  const APP = path.join(ROOT, 'app');
  const appFiles = walk(APP).filter(isSrc);

  check('app/ was found', appFiles.length > 50, `${appFiles.length} files`);

  // 1. every file the router can mount exports something to mount.
  const noDefault = appFiles.filter((f) => !/export\s+default\b/.test(stripComments(fs.readFileSync(f, 'utf8'))))
    .map((f) => path.relative(ROOT, f));
  check(`all ${appFiles.length} files under app/ have a default export`,
    noDefault.length === 0, noDefault.join(', '));

  // 2. build the route table the way expo-router does.
  const routes: string[][] = [];
  for (const f of appFiles) {
    const rel = path.relative(APP, f).split(path.sep).join('/').replace(/\.tsx?$/, '');
    if (/(^|\/)_layout$/.test(rel)) continue;           // layouts are not routes
    let segs = rel.split('/').filter((s) => !(s.startsWith('(') && s.endsWith(')')));
    if (segs[segs.length - 1] === 'index') segs = segs.slice(0, -1);
    routes.push(segs);
  }

  const resolves = (target: string, isPrefix: boolean): boolean => {
    const t = target.replace(/[?#].*$/, '').split('/').filter(Boolean)
      .filter((s) => !(s.startsWith('(') && s.endsWith(')')));
    return routes.some((rs) => {
      // A truncated target (it ran into a `${`) only has to match a prefix.
      if (isPrefix) { if (rs.length < t.length) return false; }
      else if (rs.length !== t.length && !rs.some((s) => s.startsWith('[...'))) return false;
      for (let i = 0; i < t.length; i++) {
        const r = rs[i];
        if (r === undefined) return false;
        if (r.startsWith('[...')) return true;          // catch-all swallows the rest
        if (r.startsWith('[')) continue;                // dynamic segment matches any
        if (r !== t[i]) return false;
      }
      return true;
    });
  };

  // 3. collect every statically-known navigation target. Comments are stripped
  //    first: this repo's docs quote route paths, and a removed screen still
  //    named in a comment would otherwise be counted as still reachable.
  const PATTERNS = [
    /router\s*\.\s*(?:push|replace|navigate)\s*\(\s*['"`](\/[^'"`${]*)(\$\{)?/g,
    /pathname\s*:\s*['"`](\/[^'"`${]*)(\$\{)?/g,
    /<Link\b[^>]*?\bhref\s*=\s*['"`{]*['"`](\/[^'"`${]*)(\$\{)?/g,
  ];
  const targets = new Map<string, string[]>();
  for (const f of appFiles.concat(walk(path.join(ROOT, 'components')).filter(isSrc))) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const re of PATTERNS) {
      for (const m of s.matchAll(re)) {
        const key = m[1] + (m[2] ? '*' : '');            // '*' = truncated, prefix match
        if (!targets.has(key)) targets.set(key, []);
        targets.get(key)!.push(path.relative(ROOT, f));
      }
    }
  }

  check('navigation targets were actually found', targets.size > 20, `${targets.size} targets`);
  const dead = [...targets.keys()].filter((k) =>
    !resolves(k.endsWith('*') ? k.slice(0, -1) : k, k.endsWith('*')));
  check(`all ${targets.size} static navigation targets resolve to a route`,
    dead.length === 0,
    dead.map((d) => `${d} ← ${targets.get(d)![0]}`).join('; '));
  console.log(`    (${routes.length} routes, ${targets.size} static targets; dynamic targets are not checkable here)`);
}

console.log(failures
  ? `\n  ${failures} FAILED — an acceptance criterion regressed\n`
  : '\n  all executable acceptance criteria passed — see docs/ACCEPTANCE.md for what is NOT run here\n');
process.exit(failures ? 1 : 0);
