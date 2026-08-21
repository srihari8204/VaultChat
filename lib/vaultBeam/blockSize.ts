// lib/vaultBeam/blockSize.ts — the PHYSICAL block size, and only that.
//
// # TWO SIZES, AND THEY ARE NOT THE SAME THING
//
// LOGICAL CHUNK — 512 KiB, fixed, never configurable. It is the unit of
//   AES-GCM, of the nonce (`nonce = transferId prefix ‖ u64_be(chunkId)`, and
//   `chunkId = plain_offset / CHUNK_BYTES` in services/vaultbeam/rust/src/
//   chunk.rs), of acknowledgement, of the resume bitmap, and of cross-transport
//   equivalence. Changing it would change every nonce and invalidate the golden
//   vectors in services/crypto/__vectors__/vaultbeam.json. NOTHING HERE TOUCHES
//   IT.
//
// PHYSICAL BLOCK — the wire / R2 object unit. One block carries a whole number
//   of logical chunks. Making it smaller shrinks the amount that must be re-sent
//   when a block fails, which is what matters on a bad link; making it larger
//   cuts per-object overhead. It has no cryptographic meaning at all.
//
// The invariant that keeps them separable, enforced below and by
// vaultBeamSegments.appendSegment:
//
//     blockBytes % CHUNK_BYTES === 0
//
//     512 KiB block  -> 1 logical chunk
//    1024 KiB block  -> 2 logical chunks
//    2048 KiB block  -> 4 logical chunks
//
// # WHY THIS IS AN OVERRIDE AND NOT A NEW TABLE
//
// lib/networkState.ts already picks a block size adaptively from measured
// throughput, and networkStateStore PERSISTS the chosen bucket INDEX. Adding
// rows to that table would renumber the buckets, so every user's stored index
// would silently come to mean a different size — a behaviour change for people
// who never asked for one. So the adaptive table is left exactly as it is and
// this sits in front of it: unset (the default) means "adaptive, as before".
//
// PURE — no react-native, no storage. `npx tsx lib/vaultBeam/blockSize.ts`.

/** The logical crypto chunk. Mirrored from vaultBeamSegments; NEVER configurable. */
export const CHUNK_BYTES = 512 * 1024;

/** The physical block sizes a user may pin. Nothing else is accepted. */
export const SUPPORTED_BLOCK_BYTES = [524288, 1048576, 2097152, 4194304, 8388608] as const;
export type SupportedBlockBytes = (typeof SUPPORTED_BLOCK_BYTES)[number];

/**
 * `null` means ADAPTIVE — the existing networkState behaviour, and the default.
 * It is deliberately not one of the pinned sizes: the shipped default today is
 * the adaptive table (whose default bucket is a 4 MiB block), and silently
 * pinning everyone to 512 KiB would be a change nobody asked for.
 */
export const DEFAULT_BLOCK_BYTES: SupportedBlockBytes | null = null;

/** UI labels. KB here means KiB — stated once, so the screen can say "512 KB". */
export const BLOCK_SIZE_OPTIONS: { label: string; bytes: SupportedBlockBytes | null }[] = [
  { label: 'Automatic', bytes: null },
  { label: '512 KB', bytes: 524288 },
  { label: '1024 KB', bytes: 1048576 },
  { label: '2048 KB', bytes: 2097152 },
  { label: '4 MB', bytes: 4194304 },
  { label: '8 MB', bytes: 8388608 },
];

/**
 * Accept a stored or peer-supplied value only if it is one of the three.
 *
 * Anything else — a number from an older build, a hand-edited preference, a
 * hostile value — becomes `null` (adaptive) rather than being trusted. That is
 * what stops an arbitrary size from reaching a buffer allocation.
 */
export function normalizeBlockBytes(v: unknown): SupportedBlockBytes | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return (SUPPORTED_BLOCK_BYTES as readonly number[]).includes(n) ? (n as SupportedBlockBytes) : null;
}

/** How many logical chunks a physical block carries. */
export function chunksPerBlock(blockBytes: number): number {
  return Math.max(1, Math.floor(blockBytes / CHUNK_BYTES));
}

/**
 * The block size a transfer should actually use.
 *
 * `pinned` wins when it is one of the three; otherwise the adaptive value is
 * used unchanged. Floored at CHUNK_BYTES because a block smaller than one
 * logical chunk cannot exist — the same floor relay.ts already applies.
 */
export function resolveBlockBytes(pinned: unknown, adaptive: number): number {
  const p = normalizeBlockBytes(pinned);
  if (p !== null) return p;
  return Math.max(CHUNK_BYTES, adaptive);
}

export default { SUPPORTED_BLOCK_BYTES, normalizeBlockBytes, chunksPerBlock, resolveBlockBytes };

// ── self-check ────────────────────────────────────────────────────
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string): void => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };

  console.log('\nVaultBeam physical block size\n');

  A(CHUNK_BYTES === 524288, '1. the logical crypto chunk is still 512 KiB');
  A(SUPPORTED_BLOCK_BYTES.length === 5, '2. exactly five physical sizes are supported');
  A(SUPPORTED_BLOCK_BYTES[0] === 524288 && SUPPORTED_BLOCK_BYTES[1] === 1048576
    && SUPPORTED_BLOCK_BYTES[2] === 2097152, '3. and they are 524288 / 1048576 / 2097152');

  // THE INVARIANT THAT KEEPS CRYPTO OUT OF THIS.
  for (const b of SUPPORTED_BLOCK_BYTES) {
    A(b % CHUNK_BYTES === 0, `4. ${b / 1024} KB is a whole number of logical chunks`);
  }
  A(chunksPerBlock(524288) === 1, '5. 512 KB block  = 1 logical chunk');
  A(chunksPerBlock(1048576) === 2, '6. 1024 KB block = 2 logical chunks');
  A(chunksPerBlock(2097152) === 4, '7. 2048 KB block = 4 logical chunks');

  // Unsupported values must not survive.
  for (const bad of [0, -1, 1, 100, 262144, 786432, 3145728, 8 * 1024 * 1024 + 1,
                     NaN, Infinity, '512', 'big', null, undefined, {}, []]) {
    A(normalizeBlockBytes(bad) === null, `8. rejects ${JSON.stringify(bad)}`);
  }
  for (const good of SUPPORTED_BLOCK_BYTES) {
    A(normalizeBlockBytes(good) === good, `9. accepts ${good}`);
  }
  // A string that happens to be a supported number is still a number to JSON.
  A(normalizeBlockBytes('1048576') === 1048576, '10. a numeric string is coerced, then validated');

  // DEFAULT MUST NOT PIN ANYTHING — today's behaviour is the adaptive table.
  A(DEFAULT_BLOCK_BYTES === null, '11. the default is ADAPTIVE, so shipped behaviour is unchanged');
  A(BLOCK_SIZE_OPTIONS[0].bytes === null && BLOCK_SIZE_OPTIONS[0].label === 'Automatic',
    '12. and "Automatic" is the first option offered');
  A(BLOCK_SIZE_OPTIONS.length === 6, '13. Automatic plus the five sizes');

  // resolveBlockBytes: pinned wins, otherwise adaptive passes through untouched.
  A(resolveBlockBytes(1048576, 4 * 1024 * 1024) === 1048576, '14. a pinned size wins over adaptive');
  A(resolveBlockBytes(null, 4 * 1024 * 1024) === 4 * 1024 * 1024,
    '15. unpinned leaves the adaptive value EXACTLY as it was');
  A(resolveBlockBytes(999, 8 * 1024 * 1024) === 8 * 1024 * 1024,
    '16. an unsupported pin falls back to adaptive rather than being honoured');
  A(resolveBlockBytes(null, 1024) === CHUNK_BYTES,
    '17. an adaptive value below one chunk is floored, never fractional');

  // Every resolved value must remain block-aligned, whatever came in.
  for (const pin of [null, 524288, 1048576, 2097152, 12345]) {
    for (const ad of [2 * 1024 * 1024, 4 * 1024 * 1024, 8 * 1024 * 1024]) {
      const r = resolveBlockBytes(pin, ad);
      A(r % CHUNK_BYTES === 0, `18. resolved ${r} stays a whole number of logical chunks`);
    }
  }

  // Memory bound. 4 MiB and 8 MiB exceed BP_HIGH (4 MiB), and that is fine: the
  // direct sender streams chunk-by-chunk (readChunk(i), 16 KiB frames) and never
  // holds a block, so a block is a PLANNING unit, not a buffer. The real ceiling
  // is networkState's own invariant — blockBytes <= 8 MiB, so a dropped block is
  // a bounded re-send — and the adaptive table already emits 8 MiB blocks today,
  // so pinning one introduces no memory regime that Automatic did not already.
  A(Math.max(...SUPPORTED_BLOCK_BYTES) <= 8 * 1024 * 1024,
    '19. no pinned block exceeds the 8 MiB bounded-resend ceiling');
  A(SUPPORTED_BLOCK_BYTES.every((b) => b % CHUNK_BYTES === 0),
    '20. every pinned size is a whole number of 512 KiB logical chunks');
  A(SUPPORTED_BLOCK_BYTES.length === BLOCK_SIZE_OPTIONS.filter((o) => o.bytes !== null).length,
    '21. every supported size is offered in the UI, and nothing else is');

  console.log(failures === 0
    ? '\nALL BLOCK-SIZE CHECKS PASSED ✓\n'
    : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
