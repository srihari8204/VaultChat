// lib/call/diag.ts — call-setup diagnostics that can be correlated across two
// devices without shipping any secret to the log.
//
// WHY THIS EXISTS
// ---------------
// A failing call is a two-phone event, and until now the two logcat streams had
// nothing in common to join on. The caller printed "gathered {host:2,srflx:4,
// relay:6}" and then silence; the callee printed "openCallOffer failed — aes/gcm:
// invalid ghash tag". Whether those two lines described the SAME envelope — i.e.
// whether the callee was rejecting the offer we had just re-sealed, or an older
// one it had latched onto — was unanswerable, and that was precisely the
// question that mattered.
//
// `offerTag` answers it. It is a short, deterministic fingerprint of the sealed
// offer wire, so the caller and the callee independently derive the SAME tag for
// the same envelope and a different tag the moment a re-seal produces a new one.
// Grep one tag across both devices and the whole exchange lines up.
//
// WHAT IT MUST NEVER BE
// ---------------------
// Not a secret, and not a source of truth. The envelope it fingerprints contains
// the ratchet-wrapped call key, so the wire itself must never be logged — which
// is the other half of why this hashes rather than prints. FNV-1a is chosen
// BECAUSE it is not cryptographic: nothing may ever be tempted to treat this as
// an authenticator. It is a log join key and nothing else.
//
// It is also not the call's identity. `calls.id` (CALL_SESSIONS) is that, and
// inventing a second authoritative id was explicitly not the goal here — this
// changes on every re-seal, which is the property that makes it useful for
// diagnosis and useless as state.

/** FNV-1a offset basis. */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/** Returned when there is nothing to fingerprint, so a log line still lines up. */
const UNKNOWN = '--------';

/**
 * Short stable fingerprint of a sealed offer wire.
 *
 * Accepts the object OR the JSON string of it, because the offer crosses the
 * incoming-call screen as a route param (a string) and reaches the engine as an
 * object — and both sides must produce the same tag or the join key is useless.
 */
export function offerTag(wire: any): string {
  // Guarded BEFORE stringify: JSON.stringify(null) is the four-character string
  // "null", which hashes to a perfectly ordinary-looking tag. A missing offer
  // would then be indistinguishable in the log from a real envelope — and worse,
  // two independent missing offers would tag IDENTICALLY, so the staleness
  // predicate would call them the same envelope and refuse the retry.
  if (wire == null) return UNKNOWN;
  let s: string;
  try {
    s = typeof wire === 'string' ? wire : JSON.stringify(wire);
  } catch {
    return UNKNOWN;                       // circular / unserialisable
  }
  if (!s) return UNKNOWN;
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);          // imul keeps this 32-bit, unlike `*`
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * One structured line per call-setup stage.
 *
 * `console.warn` rather than `console.log` deliberately: React Native strips
 * console.log in release builds, and the stages worth reading are the ones only
 * reproducible on a real device in a real release build.
 */
export function callStage(tag: string, stage: string, detail?: string): void {
  console.warn(`[call][${tag}][${stage}]${detail ? ` ${detail}` : ''}`);
}

/**
 * One structured line per call-setup FAILURE, in a fixed shape so it can be
 * grepped and counted rather than read.
 *
 *   [call][<tag>][FAIL] stage=OFFER_DECRYPT code=E2EE_SESSION_STALE retry=1 recoverable=false
 *
 * `code` is an internal enum-ish string, never surfaced to the user — the screen
 * shows the friendly message the engine throws. Keeping the two separate is what
 * lets the log say "the ratchet session was stale" while the user reads
 * "reconnecting the secure session".
 */
export function callFail(
  tag: string,
  stage: string,
  code: string,
  opts: { retry: number; recoverable: boolean },
): void {
  console.warn(
    `[call][${tag}][FAIL] stage=${stage} code=${code} retry=${opts.retry} recoverable=${opts.recoverable}`,
  );
}

export default {};
