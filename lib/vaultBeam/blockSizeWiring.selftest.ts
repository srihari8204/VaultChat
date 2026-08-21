// blockSizeWiring.selftest.ts — the physical block size is configurable; the
// logical crypto chunk is NOT, and must be provably untouched.
//
// The pure arithmetic lives in blockSize.ts. What that cannot check is the part
// that would actually be dangerous: whether someone later routes the new setting
// into the crypto path, renumbers the adaptive buckets, or lets an unvalidated
// size reach a buffer. Those are wiring facts, so this reads source.
//
// STRUCTURAL: reads files, transfers nothing.
//
//   npx tsx lib/vaultBeam/blockSizeWiring.selftest.ts

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const strip = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const SEG = read('lib', 'vaultBeamSegments.ts');
const RELAY = strip(read('lib', 'vaultBeam', 'drivers', 'relay.ts'));
const NET = read('lib', 'networkState.ts');
const SET = strip(read('lib', 'vaultBeamSettings.ts'));
const BS = strip(read('lib', 'vaultBeam', 'blockSize.ts'));
const RUST = read('services', 'vaultbeam', 'rust', 'src', 'chunk.rs');

let failures = 0;
const A = (ok: boolean, what: string): void => {
  if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
};

console.log('\nPhysical block size — wiring, and the crypto chunk it must not touch\n');

// ── THE LOGICAL CHUNK IS UNTOUCHED ─────────────────────────────────
A(/export const CHUNK_BYTES = 512 \* 1024;/.test(SEG),
  '1. the canonical logical chunk is still 512 KiB in vaultBeamSegments');
A(/never adaptive/.test(SEG),
  '2. and still documented as fixed, never adaptive');
A(/IdScheme::Canonical => plain_offset \/ chunk_bytes/.test(RUST),
  '3. the Rust chunk id is still plain_offset / chunk_bytes');
A(/u64_be\(chunkId\)|u64 big-endian chunkId/.test(RUST),
  '4. the GCM nonce is still derived from the chunk id');
A(/SEGMENT_PLAN_V2/.test(SEG) && !/SEGMENT_PLAN_V3/.test(SEG),
  '5. no segment-plan v3 was introduced');

// The new module must not be able to reach the crypto unit.
A(!/nonce|gcm|seal|aead|encrypt|decrypt/i.test(BS),
  '6. the block-size module contains no crypto surface at all');
A(/blockBytes % CHUNK_BYTES === 0/.test(BS) || /% CHUNK_BYTES === 0/.test(BS),
  '7. and asserts blocks are whole logical chunks');

// ── THE ADAPTIVE TABLE IS UNCHANGED ────────────────────────────────
//
// networkStateStore persists the bucket INDEX, so adding or reordering rows
// would silently reinterpret every existing user's stored value.
// Count TABLE ROWS only. The first version of this counted the
// `interface Bucket { maxMbps: ... }` declaration as a fifth row and failed on
// an untouched file.
const rows = (NET.match(/^\s+\{ maxMbps:/gm) ?? []).length;
A(rows === 4, `8. the adaptive bucket table still has exactly 4 rows (${rows})`);
A(/const DEFAULT_BUCKET = 1;/.test(NET),
  '9. and its default bucket index is unchanged');
A(!/524288|1048576|2097152/.test(NET),
  '10. the new sizes were NOT injected into the adaptive table');

// ── ONE SEAM, AND IT VALIDATES ─────────────────────────────────────
A(/resolveBlockBytes\(getSettingsCached\(\)\.blockBytes, adaptive\)/.test(RELAY),
  '11. the relay resolves its block size through the validated helper');
A((RELAY.match(/nextBlockBytes/g) ?? []).length >= 1 &&
  (RELAY.match(/startingGeometry/g) ?? []).length === 1,
  '12. there is exactly one place the adaptive geometry is read');
A(/return adaptive;/.test(RELAY),
  '13. a settings failure falls back to adaptive rather than failing the transfer');
A(/Math\.max\(blockBytes, CHUNK_BYTES\)/.test(RELAY),
  '14. appendSegment is still floored at one logical chunk');

// ── SETTINGS: VALIDATED, AND DEFAULTED TO TODAY'S BEHAVIOUR ────────
A(/blockBytes: normalizeBlockBytes\(raw\.blockBytes\)/.test(SET),
  '15. stored preferences are normalised, so an arbitrary size cannot survive a reload');
A(/blockBytes: null,/.test(SET),
  '16. the default is null — adaptive — so shipped behaviour is unchanged');
A(!/blockBytes: 524288,|blockBytes: 1048576,|blockBytes: 2097152,/.test(SET),
  '17. the default was not silently pinned to a fixed size');

// ── NAMING: the UI must not call this the encryption chunk ─────────
A(!/[Ee]ncryption chunk|crypto chunk size|chunk size/i.test(
  (BS.match(/label: '[^']*'/g) ?? []).join(' ')),
  '18. no option label calls the physical block an encryption/chunk size');
A(/label: 'Automatic'/.test(BS),
  '19. "Automatic" is offered, so the adaptive default is reachable from the UI');

// ── constants that must not have moved ─────────────────────────────
const DIRECT = read('lib', 'vaultBeamDirect.ts');
A(/const FRAME = 16 \* 1024;/.test(DIRECT), '20. FRAME is still 16 KiB');
A(/const BP_HIGH = 4 \* 1024 \* 1024;/.test(DIRECT), '21. BP_HIGH is still 4 MiB');
A(/const STALL_MS\s+= 15000;/.test(DIRECT), '22. STALL_MS is still 15 s');

console.log(failures === 0
  ? '\nALL BLOCK-SIZE WIRING CHECKS PASSED ✓  (device evidence separate)\n'
  : `\n${failures} FAILED ✗\n`);
process.exit(failures === 0 ? 0 : 1);
