// db/chitti.ts — Lucky Draw (chit-fund) store: groups, members, collections.
//
// v1 covers groups + members + manual collection marking (paid/pending/overdue).
// Auctions & dividends are intentionally out of scope for this pass. Local-only.
// Internal identifiers (table/type names, "chitti") are unchanged from the
// original "Chitti Paata" build — only user-facing text says Lucky Draw.

import { financeDb, uuid, now } from './financeDb';
import { addTimeline } from './financeTimeline';
import { splitEvenly, toPaise, fromPaise } from '../utils/money';
import { normalizeMobile, groupStatusFor, chittiTermEnd } from '../utils/financeRules';
import { fmtDate } from '../utils/financeFormat';

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
  address: string | null;
  number: number;
  created_at: number;
}

// Mobile validation is pure and shared with the ledger forms and CSV import,
// so it lives in utils/financeRules; re-exported here for existing callers.
export { normalizeMobile };

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
  // Money is normalised to paise AT THE WRITE BOUNDARY, so nothing downstream
  // (dividends, totals, exports) ever has to trust a raw typed-in float.
  const full: ChittiGroup = {
    ...row, id: uuid(), created_at: now(),
    chit_value: fromPaise(toPaise(row.chit_value)),
    installment: fromPaise(toPaise(row.installment)),
  };
  await d.runAsync(
    `INSERT INTO chitti_groups (id,user_id,name,chit_value,installment,members,duration,start_date,foreman,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [full.id, full.user_id, full.name, full.chit_value, full.installment, full.members, full.duration,
     full.start_date, full.foreman, full.status, full.created_at],
  );
  await addTimeline('chitti', full.id, 'created', `Group created · ${full.members} members · ${full.duration} months`);
  return full;
}

/**
 * Close every ACTIVE group whose last auction day has passed (utils/financeRules
 * groupStatusFor). Run on every read, so the Active / Closed tabs, the dashboard
 * and reports agree without a background job. Each change is timelined.
 */
async function syncGroupStatuses(rows: ChittiGroup[]): Promise<ChittiGroup[]> {
  const t = now();
  const out: ChittiGroup[] = [];
  for (const g of rows) {
    const next = groupStatusFor(g, t);
    if (next !== g.status) {
      const d = await financeDb();
      // Only the read whose UPDATE changed the row records it (overlapping reads).
      const r = await d.runAsync(`UPDATE chitti_groups SET status = ? WHERE id = ? AND status = ?`, [next, g.id, g.status]);
      if (r.changes > 0) await addTimeline('chitti', g.id, 'status',
        `Closed automatically · the last auction (month ${g.duration}) was on ${fmtDate(chittiTermEnd(g))}`);
      out.push({ ...g, status: next });
    } else out.push(g);
  }
  return out;
}

export async function listGroups(userId: string, status?: ChittiStatus): Promise<ChittiGroup[]> {
  const d = await financeDb();
  const rows = await syncGroupStatuses(await d.getAllAsync<ChittiGroup>(
    `SELECT * FROM chitti_groups WHERE user_id = ? ORDER BY created_at DESC`, [userId]));
  return status ? rows.filter(g => g.status === status) : rows;
}

export async function getGroup(id: string): Promise<ChittiGroup | null> {
  const d = await financeDb();
  const g = await d.getFirstAsync<ChittiGroup>(`SELECT * FROM chitti_groups WHERE id = ?`, [id]);
  return g ? (await syncGroupStatuses([g]))[0] : null;
}

/** Paid installments per group in one query (the list screen's progress rings). */
export async function paidCountsByGroup(userId: string): Promise<Record<string, number>> {
  const d = await financeDb();
  const rows = await d.getAllAsync<{ group_id: string; n: number }>(
    `SELECT c.group_id AS group_id, COUNT(*) AS n FROM chitti_collections c
       JOIN chitti_groups g ON g.id = c.group_id
      WHERE g.user_id = ? AND c.status = 'paid' GROUP BY c.group_id`, [userId]);
  return Object.fromEntries(rows.map(r => [r.group_id, r.n]));
}

/**
 * Delete a group and EVERY row that hangs off it. SQLite foreign keys are off
 * here and the schema declares no cascades, so each child table must be named
 * explicitly — `chitti_auctions` was missing, so auction rows survived their
 * group forever: unreachable (no screen can show them), excluded from backups
 * (those scope by existing group ids), and growing without bound.
 * Timeline rows go too — after the group is gone nothing can render them.
 */
export async function deleteGroup(id: string): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`DELETE FROM chitti_groups WHERE id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_members WHERE group_id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_collections WHERE group_id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_auctions WHERE group_id = ?`, [id]);
  await d.runAsync(`DELETE FROM finance_timeline WHERE ref_type = 'chitti' AND ref_id = ?`, [id]);
}

export async function setGroupStatus(id: string, status: ChittiStatus): Promise<void> {
  const d = await financeDb();
  await d.runAsync(`UPDATE chitti_groups SET status = ? WHERE id = ?`, [status, id]);
  await addTimeline('chitti', id, 'edit', `Status changed to ${status}`);
}

// ── Members ─────────────────────────────────────────────────────────
export async function insertMember(row: Omit<ChittiMember, 'id' | 'created_at'>): Promise<ChittiMember> {
  const d = await financeDb();
  const full: ChittiMember = { ...row, id: uuid(), created_at: now() };
  await d.runAsync(
    `INSERT INTO chitti_members (id,group_id,name,phone,address,number,created_at) VALUES (?,?,?,?,?,?,?)`,
    [full.id, full.group_id, full.name, full.phone, full.address, full.number, full.created_at],
  );
  await addTimeline('chitti', full.group_id, 'update', `Member added · ${full.name}`);
  return full;
}

/** Every member of every group the user owns (finance search). */
export async function listAllMembers(userId: string): Promise<ChittiMember[]> {
  const d = await financeDb();
  return d.getAllAsync<ChittiMember>(
    `SELECT m.* FROM chitti_members m JOIN chitti_groups g ON g.id = m.group_id WHERE g.user_id = ? ORDER BY m.name`, [userId]);
}

export async function listMembers(groupId: string): Promise<ChittiMember[]> {
  const d = await financeDb();
  return d.getAllAsync<ChittiMember>(`SELECT * FROM chitti_members WHERE group_id = ? ORDER BY number ASC`, [groupId]);
}

/** Partial update — pass only the fields that changed. */
export async function updateMember(id: string, patch: Partial<Pick<ChittiMember, 'name' | 'phone' | 'address'>>): Promise<void> {
  const cols = Object.keys(patch) as (keyof typeof patch)[];
  if (cols.length === 0) return;
  const d = await financeDb();
  const before = await d.getFirstAsync<ChittiMember>(`SELECT * FROM chitti_members WHERE id = ?`, [id]);
  await d.runAsync(
    `UPDATE chitti_members SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map(c => patch[c] ?? null), id],
  );
  if (before) {
    // Name the fields that actually changed — "edited" alone settles no dispute.
    const changed = cols.filter(c => (before[c] ?? null) !== (patch[c] ?? null));
    if (changed.length) {
      await addTimeline('chitti', before.group_id, 'edit',
        `Member updated · ${patch.name ?? before.name} (${changed.join(', ')})`);
    }
  }
}

export async function deleteMember(id: string): Promise<void> {
  const d = await financeDb();
  const before = await d.getFirstAsync<ChittiMember>(`SELECT * FROM chitti_members WHERE id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_members WHERE id = ?`, [id]);
  if (before) await addTimeline('chitti', before.group_id, 'update', `Member removed · ${before.name}`);
}

// ── Collections ─────────────────────────────────────────────────────
/** Mark a member's installment for a given month; upserts by (group,member,month). */
export async function markCollection(groupId: string, memberId: string, month: number, rawAmount: number, status: CollectionStatus): Promise<void> {
  const d = await financeDb();
  const amount = fromPaise(toPaise(rawAmount));   // paise-exact, same rule as every other write
  const existing = await d.getFirstAsync<ChittiCollection>(
    `SELECT * FROM chitti_collections WHERE group_id = ? AND member_id = ? AND month = ?`, [groupId, memberId, month]);
  if (existing) {
    // Skip only when NOTHING changed. Guarding on status alone silently dropped
    // an amount change (e.g. the group's installment was edited), leaving a due
    // recorded at the old figure.
    if (existing.status === status && existing.amount === amount) return;
    await d.runAsync(`UPDATE chitti_collections SET status = ?, amount = ?, at = ? WHERE id = ?`, [status, amount, now(), existing.id]);
  } else {
    await d.runAsync(`INSERT INTO chitti_collections (id,group_id,member_id,month,amount,status,at) VALUES (?,?,?,?,?,?,?)`,
      [uuid(), groupId, memberId, month, amount, status, now()]);
  }
  // Who was marked what, when — this is the record that settles a collection dispute.
  const m = await d.getFirstAsync<ChittiMember>(`SELECT name FROM chitti_members WHERE id = ?`, [memberId]);
  await addTimeline('chitti', groupId, 'update', `M${month} · ${m?.name ?? 'Member'} marked ${status}`);
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
 *   dividend = floor((winning_bid − commission) / members)   ← in paise
 * One auction per (group, month) — re-recording replaces the earlier one.
 *
 * The share is FLOORED, not rounded (utils/money.splitEvenly): rounding each
 * share made them sum to more than the pot (₹1000 ÷ 7 → ₹142.86 × 7 = ₹1000.02),
 * telling the organizer to pay out money they never collected. Any paise that
 * cannot divide evenly stay in the pot rather than being invented.
 */
export async function recordAuction(
  group: ChittiGroup, month: number, winnerId: string | null, winnerName: string, winningBid: number, commission: number,
): Promise<ChittiAuction> {
  const d = await financeDb();
  const { each: dividend } = splitEvenly(Math.max(0, winningBid - commission), group.members || 1);
  const at = now();
  const existing = await d.getFirstAsync<ChittiAuction>(`SELECT * FROM chitti_auctions WHERE group_id = ? AND month = ?`, [group.id, month]);
  // Amounts stored paise-exact. `dividend` is already exact from splitEvenly —
  // re-rounding it here is what used to break the sum, so it must not come back.
  const row: ChittiAuction = {
    id: existing?.id ?? uuid(), group_id: group.id, month,
    winner_id: winnerId, winner_name: winnerName,
    winning_bid: fromPaise(toPaise(winningBid)), commission: fromPaise(toPaise(commission)),
    dividend, at,
  };
  if (existing) {
    await d.runAsync(`UPDATE chitti_auctions SET winner_id=?, winner_name=?, winning_bid=?, commission=?, dividend=?, at=? WHERE id=?`,
      [row.winner_id, row.winner_name, row.winning_bid, row.commission, row.dividend, row.at, row.id]);
  } else {
    await d.runAsync(`INSERT INTO chitti_auctions (id,group_id,month,winner_id,winner_name,winning_bid,commission,dividend,at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [row.id, row.group_id, row.month, row.winner_id, row.winner_name, row.winning_bid, row.commission, row.dividend, row.at]);
  }
  await addTimeline('chitti', row.group_id, 'update',
    `M${row.month} auction · winner ${row.winner_name} · bid ${row.winning_bid} · dividend ${row.dividend}`);
  return row;
}

export async function listAuctions(groupId: string): Promise<ChittiAuction[]> {
  const d = await financeDb();
  return d.getAllAsync<ChittiAuction>(`SELECT * FROM chitti_auctions WHERE group_id = ? ORDER BY month ASC`, [groupId]);
}

export async function deleteAuction(id: string): Promise<void> {
  const d = await financeDb();
  const before = await d.getFirstAsync<ChittiAuction>(`SELECT * FROM chitti_auctions WHERE id = ?`, [id]);
  await d.runAsync(`DELETE FROM chitti_auctions WHERE id = ?`, [id]);
  // A deleted auction (month, bid, winner) is exactly what a dispute is about,
  // so it leaves a trace like every other change to the group.
  if (before) {
    await addTimeline('chitti', before.group_id, 'update',
      `M${before.month} auction deleted · winner ${before.winner_name} · bid ${before.winning_bid}`);
  }
}

export default {
  insertGroup, listGroups, getGroup, deleteGroup, setGroupStatus,
  insertMember, listMembers, updateMember, deleteMember, markCollection, listCollections,
  recordAuction, listAuctions, deleteAuction, normalizeMobile, paidCountsByGroup, listAllMembers,
};
