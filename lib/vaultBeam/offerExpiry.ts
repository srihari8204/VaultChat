// lib/vaultBeam/offerExpiry.ts — how long an unaccepted transfer offer stays
// acceptable.
//
// THE ONE GAP THE AUDIT FOUND. Everything else the security review asked for
// already existed: identity and session (session.ts), AES-256-GCM per chunk,
// SHA-256 on the whole file, bitmap resume, session-version replay rejection
// (session.ts:223), idempotent chunk verification, and recipient authorization
// — which is cryptographic, not procedural: the manifest carrying keyB64 rides
// only inside the ratchet-encrypted message, so a wrong recipient never obtains
// the key. Nothing here duplicates any of that.
//
// WHAT THIS IS, AND IS NOT
//
// This is HYGIENE, not authorization. It stops a months-old offer card from
// silently starting a transfer when someone finally taps it. Authorization is
// already absolute without it. That distinction decides the failure mode below.
//
// WHY THE CLOCK IS NOT OURS
//
// `now` and `offerCreatedAt` are both passed in. This module owns no clock and
// reads no device time, so it introduces no second time authority — the caller
// supplies Message.createdAt, which the SERVER stamped. A phone with a wrong
// clock cannot expire a fresh offer or revive a stale one on its own.
//
// WHY IT FAILS OPEN
//
// A missing, malformed, or future-dated timestamp yields 'ok'. Failing closed
// would mean a parsing quirk or a skewed clock permanently blocks a legitimate
// file — a real, user-visible loss — to tighten a control that is not what
// keeps the file safe. Every genuine security property here fails CLOSED
// already (a bad GCM tag, a wrong SHA-256, a stale session version).
//
// Pure: no react-native / expo imports, so it runs under `npx tsx`.

/**
 * How long an offer stays acceptable after the server stamped it.
 *
 * 24h, and NOT an arbitrary number: lib/vaultBeamQueue.ts records that the
 * relay TTL is 24h. Past that the relay copy is gone, so an offer accepted
 * later cannot complete on the relay tier anyway — this simply stops the app
 * from starting a transfer whose backing object has already been swept. Tying
 * the two together means one number moves if retention ever changes, rather
 * than two drifting apart.
 *
 * Deliberately NOT a transfer-duration limit. A 50 GB transfer may run for days
 * once accepted; see `alreadyStarted` below.
 */
export const P2P_TRANSFER_OFFER_TTL_MS = 24 * 60 * 60 * 1000;

export type OfferVerdict = 'ok' | 'expired';

export interface OfferCheck {
  /** Message.createdAt — the SERVER's stamp for the offer. */
  offerCreatedAt?: string | number | null;
  /** Caller-supplied wall clock (ms). */
  now: number;
  /**
   * Has this transfer already been accepted and made progress? A non-empty
   * receive bitmap is proof of it.
   *
   * THIS IS THE FIELD THAT KEEPS EXPIRY OFF ACTIVE TRANSFERS. Resume after an
   * app restart re-enters the same accept path with the same (old) message, so
   * without this an accepted, half-finished transfer would be killed by its own
   * offer's age — turning a resume feature into data loss.
   */
  alreadyStarted: boolean;
  ttlMs?: number;
}

/** Milliseconds since the offer was stamped, or null if unusable. */
function ageOf(offerCreatedAt: OfferCheck['offerCreatedAt'], now: number): number | null {
  if (offerCreatedAt == null || offerCreatedAt === '') return null;
  const t = typeof offerCreatedAt === 'number' ? offerCreatedAt : Date.parse(String(offerCreatedAt));
  if (!Number.isFinite(t)) return null;
  return now - t;
}

export function offerVerdict(a: OfferCheck): OfferVerdict {
  if (a.alreadyStarted) return 'ok';            // accepted already — age is irrelevant
  const age = ageOf(a.offerCreatedAt, a.now);
  if (age == null) return 'ok';                 // no/unparseable stamp → fail open
  if (age < 0) return 'ok';                     // clock skew: server ahead of us
  return age >= (a.ttlMs ?? P2P_TRANSFER_OFFER_TTL_MS) ? 'expired' : 'ok';
}

/** Convenience wrapper — reads better at the call site than a string compare. */
export function isOfferExpired(a: OfferCheck): boolean {
  return offerVerdict(a) === 'expired';
}

export default { P2P_TRANSFER_OFFER_TTL_MS, offerVerdict, isOfferExpired };

// ── self-check ────────────────────────────────────────────────────
// Deterministic: every case supplies its own `now`, so there is no sleep and
// no dependence on the machine's clock.
if (require.main === module) {
  let failures = 0;
  const A = (ok: boolean, what: string) => {
    if (!ok) { failures++; console.error('  FAIL', what); } else console.log('  ok  ', what);
  };
  const T0 = 1_700_000_000_000;                 // fixed epoch, not Date.now()
  const iso = (ms: number) => new Date(ms).toISOString();
  const TTL = P2P_TRANSFER_OFFER_TTL_MS;

  console.log('\nVaultBeam offer expiry\n');

  // 1-3: the basic window.
  A(offerVerdict({ offerCreatedAt: iso(T0), now: T0, alreadyStarted: false }) === 'ok',
    '1. a brand-new offer is acceptable');
  A(offerVerdict({ offerCreatedAt: iso(T0), now: T0 + TTL - 1, alreadyStarted: false }) === 'ok',
    '2. one millisecond inside the window is still acceptable');
  A(offerVerdict({ offerCreatedAt: iso(T0), now: T0 + TTL, alreadyStarted: false }) === 'expired',
    '3. exactly at the TTL it is expired (boundary is inclusive)');
  A(offerVerdict({ offerCreatedAt: iso(T0), now: T0 + TTL * 30, alreadyStarted: false }) === 'expired',
    '3b. a month-old offer is expired');

  // 4: THE IMPORTANT ONE — an accepted transfer never expires, however old the
  // offer is. This is what makes resume-after-restart safe.
  A(offerVerdict({ offerCreatedAt: iso(T0), now: T0 + TTL * 100, alreadyStarted: true }) === 'ok',
    '4. an already-started transfer ignores offer age entirely');
  A(isOfferExpired({ offerCreatedAt: iso(T0), now: T0 + TTL * 100, alreadyStarted: true }) === false,
    '4b. …so a long-running large transfer is never killed by its offer');

  // 5-8: fail-open cases. Each would otherwise destroy a legitimate transfer.
  A(offerVerdict({ now: T0, alreadyStarted: false }) === 'ok',
    '5. a missing stamp is acceptable (old senders send none)');
  A(offerVerdict({ offerCreatedAt: null, now: T0, alreadyStarted: false }) === 'ok',
    '6. an explicit null is acceptable');
  A(offerVerdict({ offerCreatedAt: '', now: T0, alreadyStarted: false }) === 'ok',
    '7. an empty string is acceptable');
  A(offerVerdict({ offerCreatedAt: 'not-a-date', now: T0, alreadyStarted: false }) === 'ok',
    '8. an unparseable stamp is acceptable, never a silent block');

  // 9: clock skew. A server stamp in our future must not read as "very old".
  A(offerVerdict({ offerCreatedAt: iso(T0 + 60_000), now: T0, alreadyStarted: false }) === 'ok',
    '9. a future-dated stamp is acceptable, not treated as aged');

  // 10: numeric epochs work as well as ISO strings.
  A(offerVerdict({ offerCreatedAt: T0, now: T0 + TTL, alreadyStarted: false }) === 'expired',
    '10. a numeric epoch is handled like an ISO stamp');

  // 11: the TTL is the relay TTL, and that link is worth pinning — if someone
  // shortens this to "an hour" the reasoning in the header stops being true.
  A(TTL === 24 * 60 * 60 * 1000, '11. the TTL matches the documented 24h relay retention');

  // 12: expiry is a pure function of its inputs — no hidden clock, so the same
  // question asked twice cannot answer differently.
  const q = { offerCreatedAt: iso(T0), now: T0 + TTL + 5, alreadyStarted: false } as const;
  A(offerVerdict(q) === offerVerdict(q), '12. the verdict is deterministic');

  // 13: an explicit ttlMs override is honoured (used by tests and any future
  // server-driven policy), without changing the default.
  A(offerVerdict({ offerCreatedAt: iso(T0), now: T0 + 5_000, alreadyStarted: false, ttlMs: 1_000 }) === 'expired',
    '13. a caller-supplied ttlMs overrides the default');
  A(P2P_TRANSFER_OFFER_TTL_MS === 24 * 60 * 60 * 1000,
    '13b. …and does not mutate the default');

  console.log(failures === 0 ? '\nALL OFFER-EXPIRY CHECKS PASSED ✓\n' : `\n${failures} FAILED ✗\n`);
  process.exit(failures === 0 ? 0 : 1);
}
