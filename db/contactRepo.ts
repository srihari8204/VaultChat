// db/contactRepo.ts — typed data access for contacts / presence cache (Task 3).
// last_seen is cached from socket presence events so the chat header can show
// "online / last seen …" instantly without waiting for the network.

import { getDb } from './database';
import type { ContactRow } from './chatTypes';

function rows(res: { rows: any[] }): ContactRow[] {
  return (res.rows ?? []) as ContactRow[];
}

export function getById(id: string): ContactRow | null {
  const res = getDb().executeSync(`SELECT * FROM contacts WHERE id = ? LIMIT 1`, [id]);
  return (rows(res)[0] ?? null);
}

export function upsert(c: Partial<ContactRow> & { id: string }): void {
  const db = getDb();
  db.executeSync(
    `INSERT OR IGNORE INTO contacts (id, display_name, avatar_local_path, last_seen, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [c.id, c.display_name ?? null, c.avatar_local_path ?? null, c.last_seen ?? null, Date.now()]);
  db.executeSync(
    `UPDATE contacts
        SET display_name      = COALESCE(?, display_name),
            avatar_local_path = COALESCE(?, avatar_local_path),
            last_seen         = COALESCE(?, last_seen),
            updated_at        = ?
      WHERE id = ?`,
    [c.display_name ?? null, c.avatar_local_path ?? null, c.last_seen ?? null, Date.now(), c.id]);
}

/** Record a presence timestamp (0/null = currently online is tracked by caller). */
export function setLastSeen(id: string, lastSeen: number): void {
  const db = getDb();
  db.executeSync(`INSERT OR IGNORE INTO contacts (id, updated_at) VALUES (?, ?)`, [id, Date.now()]);
  db.executeSync(`UPDATE contacts SET last_seen = ?, updated_at = ? WHERE id = ?`, [lastSeen, Date.now(), id]);
}

export default { getById, upsert, setLastSeen };
