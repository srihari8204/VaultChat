// lib/reactionMerge.ts — fold reaction messages into per-message summaries.
//
// Reactions are ordinary messages (type 'reaction') carrying {reactsTo, emoji,
// op}. The timeline folds them into a summary per target message. That fold is
// keyed on the whole message array, which the chat rebuilds on every incoming
// message, receipt and optimistic send — so a naive implementation hands every
// reacted message a brand-new array each time, the bubble's memo comparator
// (`a.reactionsForMsg === b.reactionsForMsg`) fails, and messages re-render
// because something unrelated arrived at the other end of the conversation.
//
// So the fold caches by target id and returns the PREVIOUS array whenever the
// summary is unchanged. Identity is the whole point; the counting is incidental.
//
// Lives in lib/ rather than the screen so it can be executed by a test.

export interface ReactionSummary { emoji: string; count: number; mine: boolean }

export interface ReactionSourceMsg {
  id: number;
  type?: string | null;
  content?: string | null;
  senderId?: string;
  createdAt?: string | null;
  deletedAt?: string | null;
  [k: string]: any;
}

/** Same shape twice? Then the old array can be reused. */
function sameSummary(a: ReactionSummary[], b: ReactionSummary[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].emoji !== b[i].emoji || a[i].count !== b[i].count || a[i].mine !== b[i].mine) {
      return false;
    }
  }
  return true;
}

/**
 * Fold reaction rows into `{ [targetMessageId]: ReactionSummary[] }`.
 *
 * `prev` is the previous result. Any target whose summary is unchanged keeps
 * its EXACT previous array reference, so memoized bubbles skip the render.
 * Pass nothing on the first call.
 *
 * Last-write-wins per (target, sender), ordered by createdAt then id, so an
 * optimistic reaction is superseded by the server row rather than doubling.
 */
export function mergeReactions(
  messages: ReactionSourceMsg[],
  meId: string | null,
  prev?: Record<number, ReactionSummary[]>,
): Record<number, ReactionSummary[]> {
  const latest = new Map<string, { at: string; emoji: string | null; mine: boolean; target: number }>();
  for (const m of messages) {
    if (m.type !== 'reaction' || !m.content || m.deletedAt) continue;
    let p: any;
    try { p = JSON.parse(m.content); } catch { continue; }
    const target = Number(p?.reactsTo);
    if (!Number.isFinite(target) || target <= 0) continue;
    const key = `${target}:${m.senderId}`;
    const at = `${m.createdAt ?? ''}#${String(m.id ?? 0).padStart(12, '0')}`;
    const before = latest.get(key);
    if (before && before.at >= at) continue;
    latest.set(key, {
      at,
      emoji: p.op === 'remove' ? null : String(p.emoji || ''),
      mine: m.senderId === meId,
      target,
    });
  }

  const out: Record<number, ReactionSummary[]> = {};
  for (const v of latest.values()) {
    if (!v.emoji) continue;
    const list = out[v.target] ?? (out[v.target] = []);
    const hit = list.find(r => r.emoji === v.emoji);
    if (hit) { hit.count++; hit.mine = hit.mine || v.mine; }
    else list.push({ emoji: v.emoji, count: 1, mine: v.mine });
  }

  // Reuse the previous array wherever the summary did not actually change.
  // Without this every reacted message re-renders on unrelated traffic.
  if (prev) {
    for (const k of Object.keys(out)) {
      const id = Number(k);
      const old = prev[id];
      if (old && sameSummary(old, out[id])) out[id] = old;
    }
  }
  return out;
}

export default mergeReactions;
