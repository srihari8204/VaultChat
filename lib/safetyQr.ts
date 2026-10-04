// lib/safetyQr.ts — the safety number as a QR code, and the check of a scanned one.
//
// app/verify-contact.tsx shows this device's safety number as a QR and scans
// the contact's. The number is symmetric (services/security/safetyNumber.ts:
// both devices compute the same 60 digits), so a match means both sides hold
// the same identity keys. Pure (no react-native) so the selftest runs under tsx.

const PREFIX = 'vcsafety:1:';

/** The QR payload for a 60-digit safety number. */
export function safetyQrPayload(number: string): string {
  return PREFIX + String(number ?? '').replace(/\D/g, '');
}

export type SafetyQrResult = 'match' | 'mismatch' | 'invalid';

/**
 * Compare a scanned QR with this device's safety number.
 * 'invalid' = not a safety-number code at all (another QR, a damaged read);
 * 'mismatch' = a safety-number code with different digits (keys changed, or a
 * different contact's code) — the case the screen must warn about.
 */
export function compareSafetyQr(scanned: string, mine: string): SafetyQrResult {
  const raw = String(scanned ?? '').trim();
  if (!raw.toLowerCase().startsWith(PREFIX)) return 'invalid';
  const digits = raw.slice(PREFIX.length);
  if (!/^\d{60}$/.test(digits)) return 'invalid';
  return digits === String(mine ?? '').replace(/\D/g, '') ? 'match' : 'mismatch';
}
