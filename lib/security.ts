// lib/security.ts — real account-security data for the Security Hub.

import { api } from './api';

export interface SecurityOverview {
  activeSessions: number;
  linkedDevices: number;
  blockedContacts: number;
  e2eeKeyPublished: boolean;
  accountCreatedAt: string | null;
  settings: {
    discoverable: boolean | null;
    readReceipts: boolean | null;
    lastSeenVisible: boolean | null;
  };
}

// protobuf-migration task 4.3. Decodes the typed answer into the SAME object
// the JSON path produces — including the nulls.
//
// `?? null` is not cosmetic here. An absent proto field reads as `undefined`,
// and app/dashboard.tsx persists this object with writeCache('dashboard'):
// JSON.stringify DROPS an undefined value, so a settings flag that has never
// been chosen would come back from the cache as a MISSING key instead of an
// explicit null, and buildChecks would read it as "off". Absent stays null, all
// the way into the cache file.
//
// The dynamic import carries no `.js` suffix: Metro cannot resolve one, and tsc
// does not catch it.
async function decodeSecurityOverview(bytes: Uint8Array): Promise<SecurityOverview> {
  const { SecurityOverview: Wire } = await import('./ccwire/gen/ccwire/v1/security_overview_pb');
  const o = Wire.fromBinary(bytes);
  return {
    activeSessions:   o.activeSessions,
    linkedDevices:    o.linkedDevices,
    blockedContacts:  o.blockedContacts,
    e2eeKeyPublished: o.e2eeKeyPublished,
    accountCreatedAt: o.accountCreatedAt ?? null,
    settings: {
      discoverable:    o.settings?.discoverable ?? null,
      readReceipts:    o.settings?.readReceipts ?? null,
      lastSeenVisible: o.settings?.lastSeenVisible ?? null,
    },
  };
}

export async function getSecurityOverview(): Promise<SecurityOverview> {
  // Passing a decoder only OFFERS protobuf. A server that answers JSON — every
  // deployment until the Go half ships — is parsed by the unchanged path in
  // api(), with no second request.
  return api<SecurityOverview>('/user/security-overview', { proto: decodeSecurityOverview });
}
