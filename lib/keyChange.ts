// lib/keyChange.ts — notice when a peer's identity key changes.
//
// WHY THIS MATTERS MORE THAN THE SAFETY NUMBER SCREEN
// ---------------------------------------------------
// app/verify-contact.tsx already shows a safety number, but it only helps
// someone who thinks to go and look. A key substitution is invisible in normal
// use: the padlock still shows, messages still decrypt, the conversation feels
// identical. The user has no reason to check on the one day it would matter.
//
// A change is therefore worth SURFACING unprompted. It is also genuinely
// ambiguous — a peer who reinstalled, switched devices, or restored a backup
// gets a new identity key for entirely innocent reasons, and so does an
// attacker relaying the conversation. The protocol cannot tell them apart, so
// the honest thing is to say what happened and let the user judge, rather than
// to block (which trains people to tap through) or stay silent (which is what
// an attacker wants).
//
// Storage is local and per-peer. Nothing is reported to the server: the server
// is exactly who this protects against.
//
// It also remembers WHICH safety number the user verified for a peer (a hash
// of it, lib/verification.safetyFingerprint), so app/verify-contact.tsx can
// say "the security code changed" instead of keeping "Verified" across a key
// change. Every key here starts with vc_peer_ik_, which lib/backupSecretKeys
// keeps out of backups in both directions: a restored bundle must not be able
// to forge a verification any more than it may pre-acknowledge a change.

import AsyncStorage from '@react-native-async-storage/async-storage';

const seenKey = (peerId: string) => `vc_peer_ik_${peerId}`;
const ackKey = (peerId: string) => `vc_peer_ik_ack_${peerId}`;
const verifiedKey = (peerId: string) => `vc_peer_ik_verified_${peerId}`;
/** Stored by acknowledgeKeyChange when no verified number was recorded: a
 *  verification from before the change (or from before numbers were recorded)
 *  no longer counts. Never equal to a real fingerprint. */
export const STALE_VERIFICATION = 'key-changed';

export interface KeyChange {
  peerId: string;
  /** The key we recorded before. Present only for a real change. */
  previousHex: string;
  currentHex: string;
}

/**
 * Compare the peer's current identity key against the last one we saw.
 *
 * Returns null when nothing changed, when this is a first contact (not a
 * change — warning on it would make the alert meaningless), or when the user
 * has already acknowledged this exact key.
 */
export async function checkKeyChange(peerId: string): Promise<KeyChange | null> {
  if (!peerId) return null;
  try {
    const { e2eePeerIdentityKey } = await import('../services/crypto/e2eeSession.rn');
    const current = await e2eePeerIdentityKey(peerId);
    if (!current) return null;                       // no session yet

    const seen = await AsyncStorage.getItem(seenKey(peerId));
    if (!seen) {
      // First time we have seen this peer's key: record it silently. This is
      // the baseline, not an event.
      await AsyncStorage.setItem(seenKey(peerId), current);
      return null;
    }
    if (seen.toLowerCase() === current.toLowerCase()) return null;

    // Already dismissed for THIS key — do not nag on every screen focus. A
    // later change to a different key warns again, which is the point.
    const acked = await AsyncStorage.getItem(ackKey(peerId));
    if (acked && acked.toLowerCase() === current.toLowerCase()) return null;

    return { peerId, previousHex: seen, currentHex: current };
  } catch {
    return null;    // never let this break a chat that would otherwise work
  }
}

/**
 * The user has seen the warning. Records the new key as the baseline so the
 * banner does not return for it — but a FURTHER change will warn again.
 */
export async function acknowledgeKeyChange(peerId: string, currentHex: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ackKey(peerId), currentHex);
    await AsyncStorage.setItem(seenKey(peerId), currentHex);
    // After this the change is no longer "pending", so verify-contact could not
    // tell an old, unrecorded verification from a current one. Mark it stale.
    // A recorded number needs nothing: it no longer matches by itself.
    if (!(await AsyncStorage.getItem(verifiedKey(peerId)))) {
      await AsyncStorage.setItem(verifiedKey(peerId), STALE_VERIFICATION);
    }
  } catch { /* best effort — the banner reappearing is a far smaller problem */ }
}

/** The fingerprint of the safety number last verified for this peer on this
 *  device, STALE_VERIFICATION, or null when none was recorded. */
export async function getVerifiedFingerprint(peerId: string): Promise<string | null> {
  return AsyncStorage.getItem(verifiedKey(peerId));
}

/** Record (or with null, forget) the verified safety number's fingerprint. */
export async function setVerifiedFingerprint(peerId: string, fingerprint: string | null): Promise<void> {
  if (fingerprint) await AsyncStorage.setItem(verifiedKey(peerId), fingerprint);
  else await AsyncStorage.removeItem(verifiedKey(peerId));
}

export default { checkKeyChange, acknowledgeKeyChange, getVerifiedFingerprint, setVerifiedFingerprint };
