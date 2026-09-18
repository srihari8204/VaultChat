// lib/appVersionPolicy.ts — the version-floor DECISION, with no imports.
//
// Split out of appVersion.ts on purpose: that module needs expo-constants and
// the server URL, which drag in react-native and cannot be loaded under Node.
// The decision is the part worth testing — it is the one control that can lock
// every user out of the app at once — so it lives where a test can reach it.
//
// THE RULE: block only on a CLEAR instruction from the server. Silence,
// timeouts, garbage and unknown builds all mean "allowed".

export interface VersionGate {
  /** The server's hard floor. 0 (the default) blocks nobody. */
  minBuild: number;
  /** Soft floor — below this, nag but keep working. */
  adviseBuild: number;
  updateUrl: string;
  /** Server-supplied reason, shown on the blocking screen. */
  message: string;
}

export type VersionVerdict = 'ok' | 'advise' | 'blocked';

/**
 * Decide, given this build and whatever the server said.
 *
 * `gate === null` is "no usable answer" — offline, a timeout, a captive portal
 * returning HTML — and must never block: this app is local-first and works
 * offline by design, so a bad network must not look like a forced update.
 *
 * `build <= 0` is "cannot read the native build number" (Expo Go, web, a
 * malformed config). Also never blocked: locking a developer out because the
 * native config was unreadable would be a self-inflicted outage.
 *
 * The comparison is numeric because versionCode is a monotonic integer.
 * versionName is marketing text and sorts wrong — as strings "1.2.10" is below
 * "1.2.9", so a string floor would block the NEWER build.
 */
export function verdictFor(build: number, gate: VersionGate | null): VersionVerdict {
  if (!gate) return 'ok';
  if (build <= 0) return 'ok';
  if (gate.minBuild > 0 && build < gate.minBuild) return 'blocked';
  if (gate.adviseBuild > 0 && build < gate.adviseBuild) return 'advise';
  return 'ok';
}

// ─── Reading the answer ──────────────────────────────────────────────────────
//
// protobuf-migration task 3.1: /app/version is the first operation that can
// answer in binary. The request asks for BOTH representations, so a server that
// has never heard of protobuf — every deployment before this one — answers JSON
// exactly as it always did and the client takes the JSON branch. Nothing else
// in the app negotiates; this header is set at one call site on purpose.
export const APP_VERSION_ACCEPT = 'application/protobuf, application/json';

/** Narrow whatever the server sent into the gate. Never throws. */
function gateOf(d: any): VersionGate {
  return {
    minBuild: Number(d?.minBuild) || 0,
    adviseBuild: Number(d?.adviseBuild) || 0,
    updateUrl: typeof d?.updateUrl === 'string' ? d.updateUrl : '',
    message: typeof d?.message === 'string' ? d.message : '',
  };
}

/** The JSON body, unchanged from what fetchVersionGate did inline before. */
export function gateFromJson(text: string): VersionGate | null {
  try {
    return gateOf(JSON.parse(text));
  } catch {
    return null;                      // a captive portal's HTML is not a policy
  }
}

/**
 * The protobuf body (ccwire.v1.AppVersionGate).
 *
 * The generated codec is imported DYNAMICALLY so @bufbuild/protobuf stays off
 * the cold-start path — the same reason lib/ccwire is only ever reached through
 * an import() (see buf.gen.yaml). Nothing is loaded unless a server actually
 * answered in binary.
 *
 * Corrupt bytes give null, which verdictFor reads as "no usable answer" — the
 * failure direction that lets people keep using the app.
 */
export async function gateFromProtobuf(bytes: Uint8Array): Promise<VersionGate | null> {
  try {
    // NO `.js` SUFFIX. tsc accepts it (moduleResolution: bundler) but METRO
    // DOES NOT: metro-resolver appends each sourceExt to the full requested
    // path, so `…_pb.js` is probed as `_pb.js`, `_pb.js.ts`, `_pb.js.tsx` —
    // none of which exist, because the generated file is `_pb.ts`.
    //
    // Metro resolves import() at BUILD time, so this would have been a bundling
    // failure, not something the try/catch below could rescue. Typecheck stayed
    // clean throughout. Caught by audit before the first APK build.
    const { AppVersionGate } = await import('./ccwire/gen/ccwire/v1/app_version_pb');
    const m = AppVersionGate.fromBinary(bytes);
    // int64 arrives as bigint; the floors are versionCodes, far inside Number.
    return gateOf({
      minBuild: Number(m.minBuild),
      adviseBuild: Number(m.adviseBuild),
      updateUrl: m.updateUrl,
      message: m.message,
    });
  } catch {
    return null;
  }
}

export default { verdictFor, gateFromJson, gateFromProtobuf };
