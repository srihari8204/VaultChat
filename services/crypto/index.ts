/**
 * services/crypto/index.ts — THE crypto facade (Rust-core Phase 1, Step 4).
 *
 * Single import point for the E2EE core. Backend is chosen ONCE at module
 * load from EXPO_PUBLIC_CRYPTO_BACKEND ('ts' | 'rust', default 'ts'):
 *
 *   'ts'   → the proven pure-TS implementations (e2ee.ts / senderKey.ts /
 *            shamir.ts). Default, and the permanent fallback.
 *   'rust' → the native crypto-core (Nitro HybridObject over the Rust crate),
 *            IF it binds and passes its self-check. Any init failure falls
 *            back to TS with a Sentry breadcrumb — never a crash, never
 *            blocked messaging.
 *
 * Both backends read/write identical persisted formats (proven by the golden
 * vectors + parity suite), so flipping the flag is safe mid-conversation.
 * Kill switch: set EXPO_PUBLIC_CRYPTO_BACKEND=ts (or unset) and rebuild.
 */
import * as tsE2ee from './e2ee';
import * as tsSenderKey from './senderKey';
import * as tsShamir from './shamir';

export type {
  Envelope,
  InitialHeader,
  KeyPair,
  PreKeyBundle,
  RatchetHeader,
  RatchetState,
} from './e2ee';
export type { GroupCipher, OwnSenderKey, PeerSenderKey, SenderKeyDistribution } from './senderKey';
export type { SplitOptions } from './shamir';

// Format helpers are backend-independent (frozen by the golden vectors) and
// always run in TS — the native boundary itself round-trips through them.
export {
  bytesToHex,
  decodeEnvelope,
  deserializeState,
  encodeEnvelope,
  fromUtf8,
  hexToBytes,
  randomBytes,
  serializeState,
  utf8,
} from './e2ee';

type NativeModule = typeof import('./native/CryptoCore');

let backend: 'ts' | 'rust' = 'ts';
let native: NativeModule | null = null;

function breadcrumb(reason: string): void {
  console.warn(`[crypto] rust backend unavailable — TS fallback: ${reason}`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/react-native');
    Sentry.addBreadcrumb({
      category: 'crypto',
      level: 'warning',
      message: `crypto-core rust init failed → ts fallback: ${reason}`,
    });
  } catch {
    // Sentry unavailable (Node tests) — the console.warn above suffices.
  }
}

(function selectBackend(): void {
  const want = String(process.env.EXPO_PUBLIC_CRYPTO_BACKEND || 'ts').toLowerCase();
  if (want !== 'rust') return;
  try {
    // Lazy require so 'ts' sessions and Node test runs never touch native.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./native/CryptoCore') as NativeModule;
    if (mod.initNativeCrypto()) {
      native = mod;
      backend = 'rust';
      return;
    }
    breadcrumb(mod.nativeCryptoInitError() || 'unknown init error');
  } catch (e) {
    breadcrumb(String((e as Error)?.message || e));
  }
})();

/** Which backend is live — for QA screens, diagnostics, and tests. */
export function cryptoBackend(): 'ts' | 'rust' {
  return backend;
}

// ── switched crypto API (one line per op keeps this greppable) ─────────

export const generateDH = native ? native.generateDH : tsE2ee.generateDH;
export const generateSigningKey = native ? native.generateSigningKey : tsE2ee.generateSigningKey;
export const sign = native ? native.sign : tsE2ee.sign;
export const verify = native ? native.verify : tsE2ee.verify;
export const x3dhInitiator = native ? native.x3dhInitiator : tsE2ee.x3dhInitiator;
export const x3dhResponder = native ? native.x3dhResponder : tsE2ee.x3dhResponder;
export const ratchetInitAlice = native ? native.ratchetInitAlice : tsE2ee.ratchetInitAlice;
export const ratchetInitBob = native ? native.ratchetInitBob : tsE2ee.ratchetInitBob;
export const ratchetEncrypt = native ? native.ratchetEncrypt : tsE2ee.ratchetEncrypt;
export const ratchetDecrypt = native ? native.ratchetDecrypt : tsE2ee.ratchetDecrypt;

export const createSenderKey = native ? native.createSenderKey : tsSenderKey.createSenderKey;
export const distributionMessage = native
  ? native.distributionMessage
  : tsSenderKey.distributionMessage;
export const processDistribution = native
  ? native.processDistribution
  : tsSenderKey.processDistribution;
export const groupEncrypt = native ? native.groupEncrypt : tsSenderKey.groupEncrypt;
export const groupDecrypt = native ? native.groupDecrypt : tsSenderKey.groupDecrypt;

export const splitSecret = native ? native.splitSecret : tsShamir.splitSecret;
export const combineShares = native ? native.combineShares : tsShamir.combineShares;
export const shareThreshold = native ? native.shareThreshold : tsShamir.shareThreshold;
export const splitString = native ? native.splitString : tsShamir.splitString;
export const combineString = native ? native.combineString : tsShamir.combineString;
