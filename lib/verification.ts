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

/** Contact ids the user has marked as verified. */
export async function getVerifiedContacts(): Promise<string[]> {
  const r = await api<{ verified: string[] }>('/user/contact-verifications');
  return r?.verified ?? [];
}

/** Set or clear the verified flag for a contact. */
export async function setContactVerified(contactId: string, verified: boolean): Promise<void> {
  await api('/user/contact-verifications', { method: 'POST', json: { contactId, verified } });
}

export default {};
