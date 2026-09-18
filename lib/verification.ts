// lib/verification.ts — contact safety-number verification (#101).
//
// Fetches the public identity keys used to build a safety number, and persists
// the user's out-of-band "verified" decision (synced across devices via the
// backend). No secret material crosses this boundary — identity keys are public.

import { api } from './api';

/** A user's public packed identity key (base64), or null if they haven't provisioned E2EE. */
export async function fetchIdentityKey(userId: string): Promise<string | null> {
  try {
    const r = await api<{ identityKey: string }>(`/user/${encodeURIComponent(userId)}/identity`);
    return r?.identityKey ?? null;
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

// protobuf-migration. Decodes the typed answer into the SAME object the JSON
// path produces.
//
// `?? []` is belt-and-braces, not decoration: protobuf-es initialises a
// repeated field to [], so an account with no verifications arrives as a
// ZERO-BYTE body and still decodes to an empty array — never undefined, which
// getVerifiedContacts would otherwise have to paper over a second time.
//
// The dynamic import carries no `.js` suffix: Metro cannot resolve one, and tsc
// does not catch it.
async function decodeContactVerifications(bytes: Uint8Array): Promise<{ verified: string[] }> {
  const { ContactVerifications: Wire } = await import('./ccwire/gen/ccwire/v1/contact_verifications_pb');
  return { verified: Wire.fromBinary(bytes).verified ?? [] };
}

/** Contact ids the user has marked as verified. */
export async function getVerifiedContacts(): Promise<string[]> {
  // Passing a decoder only OFFERS protobuf. A server that answers JSON — every
  // deployment until the Go half ships — is parsed by the unchanged path in
  // api(), with no second request.
  const r = await api<{ verified: string[] }>('/user/contact-verifications',
    { proto: decodeContactVerifications });
  return r?.verified ?? [];
}

/** Set or clear the verified flag for a contact. */
export async function setContactVerified(contactId: string, verified: boolean): Promise<void> {
  await api('/user/contact-verifications', { method: 'POST', json: { contactId, verified } });
}

export default {};
