// lib/termsPolicy.ts — is there a terms version this user has not accepted?
//
// AUDIT F10. One rule, stated once, so the client and the server cannot drift
// on what "outstanding" means. The server decides it authoritatively (see
// internal/routes/terms.go); this exists so the client can reason about the
// answer offline, and so the rule can be tested without a network.
//
// Deliberately free of react-native imports; see lib/termsPolicy.selftest.ts.

export interface TermsState {
  /** The label now in force. Empty string or null means nobody is asked. */
  requiredVersion?: string | null;
  /** What this user accepted, if anything. */
  acceptedVersion?: string | null;
  acceptedAt?: string | null;
  url?: string | null;
}

/**
 * Must this user accept something before continuing?
 *
 * FAILS OPEN, and that is the whole design. Every path that cannot produce a
 * confident "yes" answers false:
 *
 *   - no required version configured → nobody is asked, so an operator who has
 *     not set VAULTCHAT_TERMS_VERSION cannot accidentally put a blocking screen
 *     in front of every user;
 *   - the request failed, or the server is old → the app keeps working. An
 *     acceptance screen nobody can get past because the network is down is a
 *     worse outcome than an acceptance recorded a day later.
 *
 * The comparison is EQUALITY, never ordering. The version is an opaque label
 * chosen by whoever publishes the terms — "2026-09" and "1.1" are both
 * reasonable — so any attempt to decide which is "newer" would be wrong for
 * most labels a person would actually pick.
 */
export function termsOutstanding(state: TermsState | null | undefined): boolean {
  if (!state) return false;
  const required = (state.requiredVersion ?? '').trim();
  if (!required) return false;
  const accepted = (state.acceptedVersion ?? '').trim();
  return accepted !== required;
}

/**
 * Has this user accepted anything before?
 *
 * Separates "new here" from "the terms changed", which are different screens:
 * one is part of signing up, the other is an interruption and has to say what
 * changed and why it is being asked again.
 */
export function termsAreAnUpdate(state: TermsState | null | undefined): boolean {
  return !!(state && (state.acceptedVersion ?? '').trim() !== '');
}

/**
 * The protobuf body (ccwire.v1.TermsState) — protobuf-migration.
 *
 * Lives here rather than in lib/terms.ts because this is the react-native-free
 * half: it can be run, and is run, under plain Node.
 *
 * DECODES TO THE SAME OBJECT THE JSON PATH PRODUCES, key for key. Two things
 * make that non-obvious:
 *
 *   1. `?? null`, not `??  undefined` and not a conditional key. proto3 absence
 *      arrives as undefined, the JSON writes an explicit `null`, and
 *      JSON.stringify DROPS undefined — so an undefined here would compare equal
 *      through a stringify and unequal through `in` or Object.keys. lib/terms.ts
 *      caches this object for the life of the process; losing a key on the typed
 *      path only is exactly the kind of difference that shows up months later.
 *   2. `outstanding` is carried even though TermsState does not declare it and
 *      nothing reads it — termsOutstanding() recomputes the rule. It is here
 *      because the JSON has it, and dropping it would make the two
 *      representations different objects for no gain.
 *
 * IT THROWS ON BAD BYTES, DELIBERATELY. fetchTermsState() has always wrapped its
 * call in a try/catch that returns null, and termsOutstanding(null) is false —
 * so a corrupt body lands on the same fail-open path as being offline. A decoder
 * that returned a default-filled object instead could produce outstanding=true
 * from garbage, i.e. an acceptance screen nobody can dismiss.
 *
 * The dynamic import carries NO `.js` suffix: tsc accepts one, Metro cannot
 * resolve it (see lib/appVersionPolicy.ts). It also keeps @bufbuild/protobuf off
 * the cold-start path until a server actually answers in binary.
 */
export async function termsFromProtobuf(
  bytes: Uint8Array,
): Promise<TermsState & { outstanding: boolean }> {
  const { TermsState: Wire } = await import('./ccwire/gen/ccwire/v1/terms_pb');
  const m = Wire.fromBinary(bytes);
  return {
    requiredVersion: m.requiredVersion,
    acceptedVersion: m.acceptedVersion ?? null,
    acceptedAt: m.acceptedAt ?? null,
    outstanding: m.outstanding,
    url: m.url,
  };
}
