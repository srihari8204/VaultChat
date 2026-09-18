// lib/remoteFlagPolicy.ts — how a remote flag and a build-time flag combine.
//
// AUDIT F11. One rule, and it is an asymmetry:
//
//     effective = buildTimeDefault AND (remote !== false)
//
// The server can only turn things OFF. A remote `true` does nothing.
//
// WHY THE ASYMMETRY IS THE WHOLE DESIGN
// -------------------------------------
// Turning a feature off remotely is always safe: the worst outcome is a feature
// the user cannot reach, which is precisely what was intended. Turning one ON
// remotely would activate a code path the installed build may not contain, may
// have shipped half-finished, or may never have been tested in that
// combination — and /app/flags is unauthenticated, so that would be a
// remote-enable primitive pointed at every installation of the app.
//
// It is a kill switch. Kill switches only kill.
//
// Deliberately free of react-native imports; see lib/remoteFlags.selftest.ts.

export type RemoteFlags = Record<string, boolean>;

/**
 * The effective value of a flag.
 *
 * FAILS TO THE BUILD'S OWN INTENT on every uncertain path — no flags fetched,
 * the request failed, the name absent, a non-boolean value. An app whose
 * features disappear because a network request failed is worse than one that
 * keeps a misbehaving feature for another launch.
 */
export function resolveFlag(
  name: string,
  buildTimeDefault: boolean,
  remote: RemoteFlags | null | undefined,
): boolean {
  if (!buildTimeDefault) return false;           // the build does not have it; nothing can add it
  if (!remote) return buildTimeDefault;          // no answer ⇒ the build decides
  const value = remote[name];
  if (value === false) return false;             // the only thing the server can do
  return buildTimeDefault;                       // true, undefined, or anything else ⇒ unchanged
}

/**
 * Strip anything that is not an explicit `false`.
 *
 * Applied to whatever arrives on the wire, so the rest of the client cannot
 * accidentally treat a stray `true` — or a string, or a number — as an enable.
 * The server does this too; doing it on both sides means neither has to trust
 * the other to have done it.
 */
export function sanitizeFlags(input: unknown): RemoteFlags {
  const out: RemoteFlags = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === false) out[k] = false;
  }
  return out;
}

/**
 * What this client sends for GET /app/flags.
 *
 * Both, in preference order. A server that predates the typed response — which
 * is every deployed server today — answers JSON and the client takes the branch
 * it has always taken.
 */
export const APP_FLAGS_ACCEPT = 'application/protobuf, application/json';

/**
 * The typed representation of the kill switches.
 *
 * Returns null — never `{}` — when the bytes cannot be decoded. That
 * distinction is the safety property: `{}` means "the server says nothing is
 * switched off" and would re-enable a killed feature, while null means "no
 * usable answer" and leaves the persisted snapshot in place. See the caller in
 * lib/remoteFlags.ts, which only assigns on a non-null result.
 *
 * `disabled` is a list of names rather than a map of booleans; proto/ccwire/v1/
 * app_flags.proto explains why at length. The object rebuilt here is exactly
 * what sanitizeFlags() produces from the JSON, so the persisted cache does not
 * depend on which representation the server chose.
 */
export async function flagsFromProtobuf(bytes: Uint8Array): Promise<RemoteFlags | null> {
  try {
    // NO `.js` SUFFIX — see lib/appVersionPolicy.ts for why Metro cannot
    // resolve one against a generated `_pb.ts`, and why tsc would not notice.
    const { AppFlags } = await import('./ccwire/gen/ccwire/v1/app_flags_pb');
    const m = AppFlags.fromBinary(bytes);
    const out: RemoteFlags = {};
    for (const name of m.disabled) if (name) out[name] = false;
    return out;
  } catch {
    return null;
  }
}
