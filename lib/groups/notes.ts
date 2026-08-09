// lib/groups/notes.ts — shared group notes (Groups & Circles, G4.5).
//
// WHY NOT lib/notesCrypto.ts, WHICH THE PLAN CALLED FOR
// The existing encrypted-notes feature seals with a DEVICE-LOCAL key. That is
// exactly right for a private notebook and exactly wrong for a shared one: a
// note encrypted with it is readable only by the phone that wrote it, so
// "shared notes" built on it would be shared in name only.
//
// Group notes therefore use the GROUP's own encryption (the same sender-key
// session that protects its messages) and ride the message spine as an event
// log, like group tasks. That inherits the offline outbox, delta sync, and the
// property that a note is exactly as private as a message in the same group.
//
// The fold is deliberately the same shape as tasks: sort by timestamp, apply,
// deletion terminal. Two different orderings for two event logs in one codebase
// would be a bug waiting to happen.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/notes.ts

export const NOTE_PREFIX = 'VCNOTE1:';

export interface Note {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
}

export type NoteOp =
  | { k: 'add'; id: string; at: number; by: string; title: string; body?: string }
  | { k: 'edit'; id: string; at: number; by: string; title?: string; body?: string }
  | { k: 'pin'; id: string; at: number; by: string; pinned: boolean }
  | { k: 'del'; id: string; at: number; by: string };

export function encodeNoteOp(op: NoteOp): string {
  return NOTE_PREFIX + JSON.stringify(op);
}

/** Parse a decrypted body. Anything malformed returns null rather than throwing. */
export function decodeNoteOp(body: string | null | undefined): NoteOp | null {
  if (!body || !body.startsWith(NOTE_PREFIX)) return null;
  try {
    const o = JSON.parse(body.slice(NOTE_PREFIX.length));
    if (!o || typeof o.id !== 'string' || !o.id) return null;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
    if (typeof o.by !== 'string') return null;
    switch (o.k) {
      case 'add': return typeof o.title === 'string' && o.title ? o as NoteOp : null;
      case 'edit':
      case 'del': return o as NoteOp;
      case 'pin': return typeof o.pinned === 'boolean' ? o as NoteOp : null;
      default: return null;   // an op from a newer client: ignore, never crash
    }
  } catch { return null; }
}

/** Same total order as tasks: time, then author, then kind. */
function compareOps(a: NoteOp, b: NoteOp): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
}

/**
 * Fold events into the current notes.
 *
 * Field-level last-write-wins: an edit that carries only a title leaves the
 * body alone. Two people editing different halves of the same note therefore
 * both keep their work, instead of whoever saved last silently discarding the
 * other's paragraph.
 */
export function foldNotes(ops: NoteOp[]): Note[] {
  const byId = new Map<string, Note>();
  const deleted = new Set<string>();

  for (const op of [...ops].sort(compareOps)) {
    if (deleted.has(op.id)) continue;

    if (op.k === 'del') { deleted.add(op.id); byId.delete(op.id); continue; }

    if (op.k === 'add') {
      if (byId.has(op.id)) continue;   // duplicate delivery must not reset edits
      byId.set(op.id, {
        id: op.id, title: op.title, body: op.body ?? '', pinned: false,
        createdAt: op.at, updatedAt: op.at, createdBy: op.by, updatedBy: op.by,
      });
      continue;
    }

    const cur = byId.get(op.id);
    if (!cur) continue;   // edit before its add arrived: the add is in flight

    if (op.k === 'edit') {
      byId.set(op.id, {
        ...cur,
        title: op.title !== undefined ? op.title : cur.title,
        body: op.body !== undefined ? op.body : cur.body,
        updatedAt: op.at, updatedBy: op.by,
      });
    } else if (op.k === 'pin') {
      // Pinning is not an edit: it must not claim authorship of the content.
      byId.set(op.id, { ...cur, pinned: op.pinned });
    }
  }
  return [...byId.values()];
}

/** Pinned first, then most recently updated. */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** First line of the body, for the list preview. */
export function preview(n: Note, max = 90): string {
  const line = (n.body || '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

export function newNoteId(rand: () => number = Math.random): string {
  return `n_${Math.floor(rand() * 1e12).toString(36)}`;
}

// ── self-check ──
if (require.main === module) {
  const t0 = 1_700_000_000_000;
  const add = (id: string, title: string, at: number, by = 'u1', body = ''): NoteOp =>
    ({ k: 'add', id, title, body, at, by });

  // 1. round trip and rejection of anything else
  if (decodeNoteOp(encodeNoteOp(add('a', 'A', t0)))?.id !== 'a') throw new Error('round trip');
  for (const junk of ['hi', '', null, NOTE_PREFIX + '{', NOTE_PREFIX + '{}']) {
    if (decodeNoteOp(junk as any) !== null) throw new Error('should not decode: ' + junk);
  }
  // a task event must NOT decode as a note — the two logs share one thread
  if (decodeNoteOp('VCTASK1:{"k":"add","id":"x","at":1,"by":"u","title":"t"}') !== null) {
    throw new Error('a task event must not be read as a note');
  }

  // 2. arrival order does not matter
  const ops: NoteOp[] = [
    add('a', 'Trip', t0, 'u1', 'first line'),
    { k: 'edit', id: 'a', at: t0 + 10, by: 'u2', body: 'second line' },
    { k: 'pin', id: 'a', at: t0 + 20, by: 'u2', pinned: true },
  ];
  if (JSON.stringify(foldNotes(ops)) !== JSON.stringify(foldNotes([ops[2], ops[0], ops[1]]))) {
    throw new Error('fold must not depend on arrival order');
  }

  // 3. FIELD-LEVEL merge — the property that stops one person's save wiping
  //    the other's. Two concurrent edits to different halves both survive.
  const merged = foldNotes([
    add('a', 'Old title', t0, 'u1', 'Old body'),
    { k: 'edit', id: 'a', at: t0 + 10, by: 'u1', title: 'New title' },
    { k: 'edit', id: 'a', at: t0 + 20, by: 'u2', body: 'New body' },
  ])[0];
  if (merged.title !== 'New title' || merged.body !== 'New body') {
    throw new Error('separate fields should both survive: ' + JSON.stringify(merged));
  }

  // 4. an omitted field leaves the value alone; an empty string CLEARS it
  const cleared = foldNotes([
    add('a', 'T', t0, 'u1', 'has body'),
    { k: 'edit', id: 'a', at: t0 + 5, by: 'u1', body: '' },
  ])[0];
  if (cleared.body !== '') throw new Error('empty string should clear the body');
  if (cleared.title !== 'T') throw new Error('omitted title must be preserved');

  // 5. pinning does not claim authorship of the content
  const pinned = foldNotes([
    add('a', 'T', t0, 'author'),
    { k: 'pin', id: 'a', at: t0 + 10, by: 'someone-else', pinned: true },
  ])[0];
  if (pinned.updatedBy !== 'author') throw new Error('pinning must not rewrite updatedBy');
  if (pinned.updatedAt !== t0) throw new Error('pinning must not bump updatedAt');
  if (!pinned.pinned) throw new Error('pin should apply');

  // 6. deletion is terminal
  if (foldNotes([
    add('a', 'T', t0),
    { k: 'del', id: 'a', at: t0 + 10, by: 'u1' },
    { k: 'edit', id: 'a', at: t0 + 20, by: 'u2', title: 'Zombie' },
  ]).length !== 0) throw new Error('deleted note must stay deleted');

  // 7. duplicate add does not reset edits
  const dup = foldNotes([
    add('a', 'T', t0),
    { k: 'edit', id: 'a', at: t0 + 5, by: 'u1', title: 'Edited' },
    add('a', 'T', t0 + 9),
  ])[0];
  if (dup.title !== 'Edited') throw new Error('duplicate add must not clobber an edit');

  // 8. an older edit cannot beat a newer one
  const lww = foldNotes([
    add('a', 'T', t0),
    { k: 'edit', id: 'a', at: t0 + 50, by: 'u1', title: 'Newer' },
    { k: 'edit', id: 'a', at: t0 + 10, by: 'u2', title: 'Older' },
  ])[0];
  if (lww.title !== 'Newer') throw new Error('older edit must not win');

  // 9. sort: pinned first, then most recent
  const s = sortNotes([
    foldNotes([add('a', 'A', t0)])[0],
    foldNotes([add('b', 'B', t0 + 100)])[0],
    { ...foldNotes([add('c', 'C', t0 - 500)])[0], pinned: true },
  ]).map((n) => n.id);
  if (s.join(',') !== 'c,b,a') throw new Error('sort order wrong: ' + s);

  // 10. preview takes the first non-empty line and truncates
  if (preview({ ...foldNotes([add('a', 'T', t0, 'u1', '\n\n  hello\nworld')])[0] }) !== '  hello') {
    throw new Error('preview should take the first non-empty line');
  }
  const long = preview({ ...foldNotes([add('a', 'T', t0, 'u1', 'x'.repeat(200))])[0] });
  if (long.length !== 90 || !long.endsWith('…')) throw new Error('preview should truncate with an ellipsis');

  if (!newNoteId(() => 0.5).startsWith('n_')) throw new Error('id prefix');

  console.log('groups/notes self-check OK');
}
