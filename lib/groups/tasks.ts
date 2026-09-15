// lib/groups/tasks.ts — shared group tasks (Groups & Circles, G4.1).
//
// WHY TASKS ARE MESSAGES
// A task list needs offline creation, eventual consistency across devices, and
// end-to-end encryption. crazzychat's message pipeline already provides all
// three: an outbox that survives being offline, delta sync, and E2EE where the
// server stores ciphertext it cannot read. Building a separate tasks table
// would mean reimplementing each of those, and would hand the server a
// plaintext list of what a family is doing.
//
// So a task is not a row — it is an EVENT LOG carried in the group thread. Each
// change is one encrypted message; the current list is the fold of every event.
// That makes the interesting logic pure, which is where the bugs would be.
//
// ORDERING IS BY TIMESTAMP, NOT ARRIVAL. Offline devices deliver events late
// and out of order, so the fold sorts before applying. Folding in arrival order
// would let a stale "completed" from a phone that was in a tunnel resurrect
// itself over a newer edit.
//
// Pure — no react-native imports — so the self-check runs under tsx:
//   npx tsx lib/groups/tasks.ts

/** Marker prefix identifying a task event inside an ordinary group message. */
export const TASK_PREFIX = 'VCTASK1:';

export interface Task {
  id: string;
  title: string;
  assignee: string | null;   // userId, or null for "anyone"
  dueAt: number | null;      // epoch ms
  done: boolean;
  updatedAt: number;
  createdAt: number;
  createdBy: string;
  doneBy: string | null;
}

export type TaskOp =
  | { k: 'add'; id: string; at: number; by: string; title: string; assignee?: string | null; dueAt?: number | null }
  | { k: 'edit'; id: string; at: number; by: string; title?: string; assignee?: string | null; dueAt?: number | null }
  | { k: 'done'; id: string; at: number; by: string; done: boolean }
  | { k: 'del'; id: string; at: number; by: string };

/** Serialise an event into the message body that gets encrypted. */
export function encodeOp(op: TaskOp): string {
  return TASK_PREFIX + JSON.stringify(op);
}

/**
 * Parse a decrypted message body back into an event.
 *
 * Returns null for anything that is not a well-formed task event, so ordinary
 * chat messages, corrupt payloads and events from a FUTURE app version all fall
 * through harmlessly rather than throwing inside the fold.
 */
export function decodeOp(body: string | null | undefined): TaskOp | null {
  if (!body || !body.startsWith(TASK_PREFIX)) return null;
  try {
    const o = JSON.parse(body.slice(TASK_PREFIX.length));
    if (!o || typeof o.id !== 'string' || !o.id) return null;
    if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
    if (typeof o.by !== 'string') return null;
    switch (o.k) {
      case 'add':
        return typeof o.title === 'string' && o.title ? o as TaskOp : null;
      case 'edit':
      case 'del':
        return o as TaskOp;
      case 'done':
        return typeof o.done === 'boolean' ? o as TaskOp : null;
      default:
        return null;   // unknown op from a newer client: ignore, do not crash
    }
  } catch { return null; }
}

/**
 * Deterministic order for events. Timestamp first; ties broken by author then
 * by kind, so every device folds an identical sequence and therefore reaches an
 * identical list. Without the tie-break, two events sharing a millisecond could
 * apply in different orders on different phones.
 */
function compareOps(a: TaskOp, b: TaskOp): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
}

/**
 * Fold events into the current task list.
 *
 * Deletion is TERMINAL: once deleted, later events for that id are ignored
 * rather than resurrecting it. An edit that arrives after a delete is a device
 * that had not heard about the delete yet, and honouring it would make deleted
 * tasks reappear at random.
 */
export function foldTasks(ops: TaskOp[]): Task[] {
  const byId = new Map<string, Task>();
  const deleted = new Set<string>();

  for (const op of [...ops].sort(compareOps)) {
    if (deleted.has(op.id)) continue;

    if (op.k === 'del') { deleted.add(op.id); byId.delete(op.id); continue; }

    if (op.k === 'add') {
      // A duplicate add (the same event delivered twice) must not reset a task
      // that has since been edited or completed.
      if (byId.has(op.id)) continue;
      byId.set(op.id, {
        id: op.id, title: op.title,
        assignee: op.assignee ?? null,
        dueAt: op.dueAt ?? null,
        done: false,
        createdAt: op.at, updatedAt: op.at,
        createdBy: op.by, doneBy: null,
      });
      continue;
    }

    const cur = byId.get(op.id);
    // An edit or completion for a task we have never seen an 'add' for: the add
    // is presumably still in flight. Ignore rather than inventing a titleless
    // task that would flicker into view and then change.
    if (!cur) continue;

    if (op.k === 'edit') {
      byId.set(op.id, {
        ...cur,
        title: op.title !== undefined ? op.title : cur.title,
        assignee: op.assignee !== undefined ? op.assignee : cur.assignee,
        dueAt: op.dueAt !== undefined ? op.dueAt : cur.dueAt,
        updatedAt: op.at,
      });
    } else if (op.k === 'done') {
      byId.set(op.id, {
        ...cur, done: op.done, doneBy: op.done ? op.by : null, updatedAt: op.at,
      });
    }
  }

  return [...byId.values()];
}

/**
 * Display order: outstanding before completed, then by due date (undated last),
 * then newest first. Stable and pure so the list does not reshuffle on refresh.
 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt == null) return 1;
      if (b.dueAt == null) return -1;
      return a.dueAt - b.dueAt;
    }
    return b.createdAt - a.createdAt;
  });
}

export function isOverdue(t: Task, now: number): boolean {
  return !t.done && t.dueAt != null && t.dueAt < now;
}

/** Short id for a new task. Collision-resistant enough for a group's list. */
export function newTaskId(rand: () => number = Math.random): string {
  return `t_${Math.floor(rand() * 1e12).toString(36)}`;
}

// ── self-check ──
if (require.main === module) {
  const t0 = 1_700_000_000_000;
  const add = (id: string, title: string, at: number, by = 'u1', extra: any = {}): TaskOp =>
    ({ k: 'add', id, title, at, by, ...extra });

  // 1. round trip through the wire format
  const op = add('a', 'Milk', t0);
  if (decodeOp(encodeOp(op))?.id !== 'a') throw new Error('round trip failed');

  // 2. non-task messages and junk fall through
  for (const junk of ['hello', '', null, undefined, TASK_PREFIX + 'not json', TASK_PREFIX + '{}']) {
    if (decodeOp(junk as any) !== null) throw new Error(`should not decode: ${junk}`);
  }
  // an op kind from a newer client is ignored, not fatal
  if (decodeOp(TASK_PREFIX + JSON.stringify({ k: 'snooze', id: 'x', at: 1, by: 'u' })) !== null) {
    throw new Error('unknown op kind should be ignored');
  }

  // 3. basic fold
  let list = foldTasks([add('a', 'Milk', t0), add('b', 'Bread', t0 + 1)]);
  if (list.length !== 2) throw new Error('two adds, two tasks');

  // 4. ARRIVAL ORDER MUST NOT MATTER — the property offline sync depends on
  const ops: TaskOp[] = [
    add('a', 'Milk', t0),
    { k: 'edit', id: 'a', at: t0 + 10, by: 'u2', title: 'Oat milk' },
    { k: 'done', id: 'a', at: t0 + 20, by: 'u2', done: true },
  ];
  const forward = foldTasks(ops);
  const shuffled = foldTasks([ops[2], ops[0], ops[1]]);
  if (JSON.stringify(forward) !== JSON.stringify(shuffled)) {
    throw new Error('fold must not depend on arrival order');
  }
  if (forward[0].title !== 'Oat milk' || !forward[0].done) throw new Error('edits and completion should apply');
  if (forward[0].doneBy !== 'u2') throw new Error('completion should record who');

  // 5. a STALE completion cannot override a newer one — the tunnel case
  const stale = foldTasks([
    add('a', 'Milk', t0),
    { k: 'done', id: 'a', at: t0 + 50, by: 'u1', done: false },
    { k: 'done', id: 'a', at: t0 + 10, by: 'u2', done: true },   // arrives late, older
  ]);
  if (stale[0].done !== false) throw new Error('older event must not win over newer');

  // 6. deletion is terminal — a late edit must not resurrect it
  const gone = foldTasks([
    add('a', 'Milk', t0),
    { k: 'del', id: 'a', at: t0 + 10, by: 'u1' },
    { k: 'edit', id: 'a', at: t0 + 20, by: 'u2', title: 'Zombie' },
  ]);
  if (gone.length !== 0) throw new Error('deleted task must stay deleted');

  // 7. a duplicate add must not reset progress
  const dup = foldTasks([
    add('a', 'Milk', t0),
    { k: 'done', id: 'a', at: t0 + 5, by: 'u1', done: true },
    add('a', 'Milk', t0 + 9),   // same id delivered again
  ]);
  if (!dup[0].done) throw new Error('duplicate add must not clear completion');

  // 8. edit/done for an unseen add is ignored rather than inventing a task
  if (foldTasks([{ k: 'done', id: 'ghost', at: t0, by: 'u1', done: true }]).length !== 0) {
    throw new Error('event for an unknown task should be ignored');
  }

  // 9. same-millisecond events fold identically regardless of input order
  const tie: TaskOp[] = [
    add('a', 'T', t0),
    { k: 'edit', id: 'a', at: t0 + 5, by: 'aaa', title: 'A' },
    { k: 'edit', id: 'a', at: t0 + 5, by: 'bbb', title: 'B' },
  ];
  if (JSON.stringify(foldTasks(tie)) !== JSON.stringify(foldTasks([tie[2], tie[1], tie[0]]))) {
    throw new Error('tied timestamps must still fold deterministically');
  }

  // 10. clearing a due date is distinguishable from leaving it alone
  const cleared = foldTasks([
    add('a', 'T', t0, 'u1', { dueAt: t0 + 1000 }),
    { k: 'edit', id: 'a', at: t0 + 10, by: 'u1', dueAt: null },
  ]);
  if (cleared[0].dueAt !== null) throw new Error('explicit null should clear the due date');
  const untouched = foldTasks([
    add('a', 'T', t0, 'u1', { dueAt: t0 + 1000 }),
    { k: 'edit', id: 'a', at: t0 + 10, by: 'u1', title: 'T2' },
  ]);
  if (untouched[0].dueAt !== t0 + 1000) throw new Error('an omitted field must not clear it');

  // 11. sort: outstanding first, then due date, undated last
  const sorted = sortTasks([
    { ...foldTasks([add('c', 'C', t0)])[0], done: true },
    foldTasks([add('a', 'A', t0, 'u1', { dueAt: t0 + 500 })])[0],
    foldTasks([add('b', 'B', t0)])[0],
  ]).map((t) => t.id);
  if (sorted.join(',') !== 'a,b,c') throw new Error('sort order wrong: ' + sorted);

  if (!isOverdue({ ...foldTasks([add('a', 'A', t0, 'u1', { dueAt: t0 })])[0] }, t0 + 1)) {
    throw new Error('past due should be overdue');
  }
  if (isOverdue({ ...foldTasks([add('a', 'A', t0)])[0] }, t0 + 1)) {
    throw new Error('undated task is never overdue');
  }

  // 12. ids are unique enough and prefixed
  if (!newTaskId(() => 0.5).startsWith('t_')) throw new Error('id prefix');

  console.log('groups/tasks self-check OK');
}
