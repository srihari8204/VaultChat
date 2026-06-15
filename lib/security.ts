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

export async function getSecurityOverview(): Promise<SecurityOverview> {
  return api<SecurityOverview>('/user/security-overview');
}
