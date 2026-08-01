// db/chitti.ts — Chitti Paata (chit-fund) store: groups, members, collections.
//
// v1 covers groups + members + manual collection marking (paid/pending/overdue).
// Auctions & dividends are intentionally out of scope for this pass. Local-only.

import { financeDb, uuid, now } from './financeDb';

export type ChittiStatus = 'active' | 'closed' | 'draft';
export type CollectionStatus = 'paid' | 'pending' | 'overdue';

export interface ChittiGroup {
  id: string;
  user_id: string;
  name: string;
  chit_value: number;
  installment: number;
  members: number;        // planned member count
  duration: number;       // months
  start_date: number;
  foreman: string | null;
  status: ChittiStatus;
  created_at: number;
}

export interface ChittiMember {
  id: string;
  group_id: string;
  name: string;
  phone: string | null;
  number: number;
  created_at: number;
}

export interface ChittiCollection {
  id: string;
  group_id: string;
  member_id: string;
  month: number;
  amount: number;
  status: CollectionStatus;
  at: number;
}

// ── Groups ──────────────────────────────────────────────────────────
export async function insertGroup(row: Omit<ChittiGroup, 'id' | 'created_at'>): Promise<ChittiGroup> {
  const d = await financeDb();
  const full: ChittiGroup = { ...row, id: uuid(), created_at: now() };
  await d.runAsync(
    `INSERT INTO chitti_groups (id,user_id,name,chit_value,installment,members,duration,start_date,foreman,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.user_id, full.name, full.chit_value, full.installment, full.members, full.duration,
     full.start_date, full.foreman, full.status, full.created_at],
  );
  return full;
}

export async function listGroups(userId: string, status?: ChittiStatus): Promise<ChittiGroup[]> {
  const d = await financeDb();
  return status
    ? d.getAllAsync<ChittiGroup>(`SELECT * FROM chitti_groups WHERE user_id = ? AND status = ? ORDER BY created_at DESC`, [userId, status])
    : d.getAllAsync<ChittiGroup>(`SELECT * FROM chitti_groups WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

export async function getGroup(id: string): Promise<ChittiGroup | null> {
  const d = await financeDb();
  return d.getFirstAsync<ChittiGroup>(`SELECT * FROM chitti_groups WHERE id = ?`, [id]);
}

export async function deleteGroup(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM chitti_groups WHERE id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_members WHERE group_id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_collections WHERE group_id = ?`, [id]);
}

export async function setGroupStatus(id: string, status: ChittiStatus): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE chitti_groups SET status = ? WHERE id = ?`, [status, id]);
}

// ── Members ─────────────────────────────────────────────────────────
export async function insertMember(row: Omit<ChittiMember, 'id' | 'created_at'>): Promise<ChittiMember> {
  const d = await financeDb();
  const full: ChittiMember = { ...row, id: uuid(), created_at: now() };
  await d.runAsync(
    `INSERT INTO chitti_members (id,group_id,name,phone,number,created_at) VALUES (?,?,?,?,?,?)`,
    [full.id, full.group_id, full.name, full.phone, full.number, full.created_at],
  );
  return full;
}

export async function listMembers(groupId: string): Promise<ChittiMember[]> {
  const d = await financeDb();
  return d.getAllAsync<ChittiMember>(`SELECT * FROM chitti_members WHERE group_id = ? ORDER BY number ASC`, [groupId]);
}

export async function deleteMember(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM chitti_members WHERE id = ?`, [id]);
}

// ── Collections ─────────────────────────────────────────────────────
/** Mark a member's installment for a given month; upserts by (group,member,month). */
export async function markCollection(groupId: string, memberId: string, month: number, amount: number, status: CollectionStatus): Promise<void> {
  const d = await financeDb();
  const existing = await d.getFirstAsync<ChittiCollection>(
    `SELECT * FROM chitti_collections WHERE group_id = ? AND member_id = ? AND month = ?`, [groupId, memberId, month]);
  if (existing) {
    await d.runAsync(`UPDATE chitti_collections SET status = ?, amount = ?, at = ? WHERE id = ?`, [status, amount, now(), existing.id]);
  } else {
    await d.runAsync(`INSERT INTO chitti_collections (id,group_id,member_id,month,amount,status,at) VALUES (?,?,?,?,?,?,?)`,
      [uuid(), groupId, memberId, month, amount, status, now()]);
  }
}

export async function listCollections(groupId: string, month?: number): Promise<ChittiCollection[]> {
  const d = await financeDb();
  return month != null
    ? d.getAllAsync<ChittiCollection>(`SELECT * FROM chitti_collections WHERE group_id = ? AND month = ?`, [groupId, month])
    : d.getAllAsync<ChittiCollection>(`SELECT * FROM chitti_collections WHERE group_id = ?`, [groupId]);
}

// ── Auctions ────────────────────────────────────────────────────────
export interface ChittiAuction {
  id: string;
  group_id: string;
  month: number;
  winner_id: string | null;
  winner_name: string;
  winning_bid: number;
  commission: number;
  dividend: number;
  at: number;
}

/**
 * Record an auction result. The prize money forgone by the winner (the bid),
 * minus the foreman commission, is shared equally as a dividend to every member.
 *   dividend = (winning_bid − commission) / members
 * One auction per (group, month) — re-recording replaces the earlier one.
 */
export async function recordAuction(
  group: ChittiGroup, month: number, winnerId: string | null, winnerName: string, winningBid: number, commission: number,
): Promise<ChittiAuction> {
  const d = await financeDb();
  const dividend = Math.max(0, (winningBid - commission)) / (group.members || 1);
  const at = now();
  const existing = await d.getFirstAsync<ChittiAuction>(`SELECT * FROM chitti_auctions WHERE group_id = ? AND month = ?`, [group.id, month]);
  const row: ChittiAuction = { id: existing?.id ?? uuid(), group_id: group.id, month, winner_id: winnerId, winner_name: winnerName, winning_bid: winningBid, commission, dividend: Math.round(dividend * 100) / 100, at };
  if (existing) {
    await d.runAsync(`UPDATE chitti_auctions SET winner_id=?, winner_name=?, winning_bid=?, commission=?, dividend=?, at=? WHERE id=?`,
      [row.winner_id, row.winner_name, row.winning_bid, row.commission, row.dividend, row.at, row.id]);
  } else {
    await d.runAsync(`INSERT INTO chitti_auctions (id,group_id,month,winner_id,winner_name,winning_bid,commission,dividend,at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [row.id, row.group_id, row.month, row.winner_id, row.winner_name, row.winning_bid, row.commission, row.dividend, row.at]);
  }
  return row;
}

export async function listAuctions(groupId: string): Promise<ChittiAuction[]> {
  const d = await financeDb();
  return d.getAllAsync<ChittiAuction>(`SELECT * FROM chitti_auctions WHERE group_id = ? ORDER BY month ASC`, [groupId]);
}

export async function deleteAuction(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM chitti_auctions WHERE id = ?`, [id]);
}

export default {
  insertGroup, listGroups, getGroup, deleteGroup, setGroupStatus,
  insertMember, listMembers, deleteMember, markCollection, listCollections,
  recordAuction, listAuctions, deleteAuction,
};
