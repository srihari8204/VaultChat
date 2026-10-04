// lib/groups/serverContracts.ts — the client side of the round-4 group
// endpoints (contracts C7–C10 in the R4 backend log; vaultchat-backend-go
// chats_membership.go, communities.go, chats_calendar.go).
//
// WRITTEN, NOT DEPLOYED. Until the Go service is copied to prod, every new route
// here answers 404 ("route not migrated to go backend", the catch-all in
// cmd/api/main.go) or 405, and every new field is absent. Each helper says what
// "absent" means, and each caller keeps today's behaviour in that case.
//
// Pure apart from the request wrappers, which load lib/api lazily, so the
// self-test runs under tsx without react-native.

/** An error thrown by lib/api: message, HTTP status, parsed JSON body. */
export interface ApiError { message?: string; status?: number; body?: any }

// ── C7: structured 409 codes on POST /chats/:id/membership/request ──

/** What a refused "ask to join" means for the screen, or null for a real failure. */
export type JoinRefusal = 'member' | 'asked';

export function joinRefusal(e: ApiError | null | undefined): JoinRefusal | null {
  if (e?.status !== 409) return null;
  const code = e.body?.code;
  if (code === 'already_member') return 'member';
  if (code === 'already_requested') return 'asked';
  if (typeof code === 'string') return null; // invite_only, cooldown: the server's message says why
  // ponytail: today's server sends these 409s as prose only, so the text is
  // matched (chats_membership.go). Delete these two lines once C7 is deployed.
  const msg = String(e.message ?? '');
  if (/already in this group/i.test(msg)) return 'member';
  if (/already have a request|already have an invitation/i.test(msg)) return 'asked';
  return null;
}

// ── a route that does not exist yet ──

/**
 * True when the server does not have this route at all (not deployed), as
 * opposed to a real answer from it. A missing route is 405 (another method
 * exists on the path) or 404 with a message that is none of the route's own
 * documented 404s.
 */
export function routeMissing(e: ApiError | null | undefined, own404s: readonly string[]): boolean {
  if (e?.status === 405) return true;
  if (e?.status !== 404) return false;
  return !own404s.includes(String(e.message ?? ''));
}

// ── C9: communities edit / delete / leave / attach ──

const COMMUNITY_404 = ['Community not found'] as const;
const ATTACH_404 = ['Community not found', 'Group not found'] as const;

/** Thrown in place of the API error when the server has no such route yet. */
export class NotAvailableYet extends Error {
  constructor() { super('This is not available yet. It needs a server update.'); this.name = 'NotAvailableYet'; }
}

async function call<T>(path: string, opts: { method: string; json?: unknown }, own404s: readonly string[]): Promise<T> {
  const { api } = await import('../api');
  try {
    return await api<T>(path, opts);
  } catch (e: any) {
    if (routeMissing(e, own404s)) { managementKnown = false; throw new NotAvailableYet(); }
    throw e;
  }
}

const cid = (id: string) => encodeURIComponent(id);

/** Owner only. An empty description clears it. */
export function editCommunity(id: string, patch: { name?: string; description?: string }) {
  return call<{ id: string; name: string; description: string | null; photoURL: string | null }>(
    `/communities/${cid(id)}`, { method: 'PATCH', json: patch }, COMMUNITY_404);
}

/** Owner only. Its groups are kept as standalone groups. */
export function deleteCommunity(id: string) {
  return call<{ ok: true }>(`/communities/${cid(id)}`, { method: 'DELETE' }, COMMUNITY_404);
}

/** Leave every group of the community you are in. The owner gets 409 owner_cannot_leave. */
export function leaveCommunity(id: string) {
  return call<{ ok: true; leftChatIds: string[] }>(`/communities/${cid(id)}/members/me`, { method: 'DELETE' }, COMMUNITY_404);
}

/** Attach a group the caller administers (edit_settings). */
export function attachGroupToCommunity(id: string, chatId: string) {
  return call<{ ok: true; id: string; already?: boolean }>(
    `/communities/${cid(id)}/groups/${cid(chatId)}`, { method: 'POST' }, ATTACH_404);
}

/**
 * What the support probe's answer means. The probe is `PATCH /communities/:id`
 * with an empty body: on a server with the C9 routes that is refused before
 * anything is written (400 "name or description required", 403 for a
 * non-owner, 404 "Community not found"); on today's server the route is
 * missing (405, or the gateway's catch-all 404). Anything else (offline, a 5xx)
 * says nothing: null.
 */
export function managementProbeResult(e: ApiError | null | undefined): boolean | null {
  if (!e) return true;
  if (routeMissing(e, COMMUNITY_404)) return false;
  if (e.status === 400 || e.status === 403 || e.status === 404) return true;
  return null;
}

// ponytail: remembered for the app session, so a server deployed while the
// app is open is noticed only after a restart. Replace with a server-sent
// capability list if one is ever added.
let managementKnown: boolean | undefined;

/**
 * Whether this server has community edit / delete / leave / attach (C9).
 * Probes once per app session (the routes ship together, so one answers for
 * all four); null = could not tell this time (the actions stay, with their
 * "Not available yet" fallback).
 */
export async function communityManagementSupported(id: string): Promise<boolean | null> {
  if (managementKnown !== undefined) return managementKnown;
  const { api } = await import('../api');
  let known: boolean | null;
  try {
    await api(`/communities/${cid(id)}`, { method: 'PATCH', json: {} });
    known = true;
  } catch (e: any) {
    known = managementProbeResult(e);
  }
  if (known !== null) managementKnown = known;
  return known;
}

// ── C8: one approval queue ──

/** A row of GET /chats/:id/membership/pending?include=link. `source` is absent on today's server. */
export interface QueueRow {
  id: number | null;
  source?: 'invitation' | 'link';
  userId: string | null;
  name: string | null;
  photoURL: string | null;
  status: string;
  requested: boolean;
  inviterName: string | null;
  createdAt: string;
  acceptedAt: string | null;
  canApprove: boolean;
  canReject: boolean;
}

/** A row from an invite LINK: approved through /join-requests by user id, not by invitation id. */
export const isLinkRow = (r: QueueRow): boolean => r.source === 'link';

/** A stable key: link rows have no invitation id. */
export const queueKey = (r: QueueRow): string => (isLinkRow(r) ? `link:${r.userId}` : `inv:${r.id}`);

/**
 * True when the server answered in the merged (C8) shape: every row carries
 * `source`. Today's server sends none. An empty queue says nothing either way,
 * but then there are no link requests to show twice.
 */
export const queueMerged = (rows: readonly QueueRow[]): boolean => rows.some((r) => r.source !== undefined);

/** Invitations and (once deployed) invite-link requests, in one list. Today: invitations only. */
export async function approvalQueue(chatId: string): Promise<QueueRow[]> {
  const { api } = await import('../api');
  return api<QueueRow[]>(`/chats/${cid(chatId)}/membership/pending?include=link`);
}

// ── C10: who sealed a calendar event ──

/**
 * The member whose key opens this event's payload: the last writer when the
 * server records it (`updatedBy`), else the author (today: edits are
 * author-only, so the two are the same).
 */
export function eventWriter(row: { createdBy: string | null; updatedBy?: string | null }): string {
  return row.updatedBy ?? row.createdBy ?? '';
}

/** True when the server says who last wrote each event, so anyone it lets edit may edit. */
export const writerRecorded = (rows: readonly { updatedBy?: string | null }[]): boolean =>
  rows.some((r) => typeof r.updatedBy === 'string');
