// components/chat/chatFormat.ts — the chat's small pure formatters and the
// poll-vote patch. Moved out of components/chat/MessageBubble.tsx unchanged
// (that file passed 1,800 lines); the header, menu, composer and bubbles all
// import them from here.

import type { ChatMember, PollVoteSummary, ScreenshotMode } from '../../lib/chatService';

// Pretty-print the screenshot-mode for header-menu display.
export function formatScreenshotMode(mode: ScreenshotMode): string {
  switch (mode) {
    case 'allow':         return 'Allowed';
    case 'allow_notify':  return 'Allowed + notify';
    case 'block_silent':  return 'Blocked silently';
    case 'block':
    default:              return 'Blocked';
  }
}

// Pretty-print a disappearing-messages timer (e.g. "24 h", "7 d", "90 d").
export function formatDisappearing(seconds: number | null | undefined): string {
  if (!seconds) return 'Off';
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600  === 0) return `${seconds / 3600} h`;
  if (seconds % 60    === 0) return `${seconds / 60} m`;
  return `${seconds} s`;
}

export const DISAPPEARING_PRESETS: { label: string; seconds: number | null }[] = [
  { label: 'Off',      seconds: null },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days',   seconds: 7 * 86400 },
  { label: '90 days',  seconds: 90 * 86400 },
];

// Time-to-live remaining on an expiring message ("23h", "5d", "2m").
// Past-due returns "expiring" so the bubble visibly indicates pending wipe.
export function formatTtlRemaining(iso: string): string {
  try {
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'expiring';
    if (ms < 60_000)        return `${Math.max(1, Math.floor(ms / 1000))}s`;
    if (ms < 3600_000)      return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86400_000)     return `${Math.floor(ms / 3600_000)}h`;
    return `${Math.floor(ms / 86400_000)}d`;
  } catch { return ''; }
}

// Human-friendly "last seen" — same scale as the chat-list relative time.
export function formatLastSeen(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000)        return 'just now';
    if (diff < 3600_000)      return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)     return `${Math.floor(diff / 3600_000)}h ago`;
    if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)}d ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return ''; }
}

export function formatRecDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// Apply a ±1 patch to the per-message poll vote summary, optimistic-style.
// Used both by the user's own tap (via PollBubble.onChange) and by inbound
// socket events. Removes the bucket entirely when the count hits zero so
// the UI doesn't render a "0" pill. `fromMe` updates the caller's `mine`
// list (which drives the radio/check selected state).
export function bumpPollVote(
  prev: Record<number, PollVoteSummary>,
  messageId: number,
  optionIndex: number,
  delta: 1 | -1,
  fromMe: boolean,
): Record<number, PollVoteSummary> {
  const cur = prev[messageId] ?? { counts: {}, mine: [], total: 0 };
  const key = String(optionIndex);
  const oldCount = cur.counts[key] || 0;
  const newCount = Math.max(0, oldCount + delta);
  const counts = { ...cur.counts };
  if (newCount === 0) delete counts[key]; else counts[key] = newCount;
  let mine = cur.mine;
  if (fromMe) {
    if (delta > 0) {
      if (!mine.includes(optionIndex)) mine = [...mine, optionIndex];
    } else {
      mine = mine.filter(x => x !== optionIndex);
    }
  }
  const total = Math.max(0, cur.total + delta);
  return { ...prev, [messageId]: { counts, mine, total } };
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Date separators (U6) ─────────────────────────────────────────────
export function isSameCalendarDay(a: string, b: string): boolean {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (isSameCalendarDay(iso, now.toISOString())) return 'Today';
  if (isSameCalendarDay(iso, yest.toISOString())) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export type TickState = 'pending' | 'sent' | 'delivered' | 'read' | null;

// The status tick of a message: only meaningful for your own messages.
// WhatsApp group semantics: blue (read) only when EVERY current recipient has
// read; double-grey (delivered) only when every current recipient received.
// Exclude members who LEFT (leftAt) so a departed member never blocks a tick,
// and members who JOINED AFTER this message (they were never a recipient of it).
// Guard the empty set because [].every() is vacuously true (would false-blue).
// read implies delivered, so fold read into the delivered test — a dropped
// `message_delivered` event must not strand a since-read message at 'sent'.
export function tickStateOf(
  msg: { id: number; createdAt: string; deletedAt?: string | null; _state?: 'pending' | 'failed' },
  isMine: boolean,
  otherMembers: Pick<ChatMember, 'leftAt' | 'joinedAt' | 'lastReadMessageId' | 'lastDeliveredMessageId'>[],
): TickState {
  let tickState: TickState = null;
  // The pending test must come BEFORE the id check. A queued message has no
  // server id yet (id is 0 until the POST is acked), so gating the whole block
  // on `msg.id > 0` meant an offline message showed no status icon at all —
  // just the "sending…" caption, which reads as stuck rather than waiting.
  if (isMine && !msg.deletedAt && (msg._state === 'pending' || msg._state === 'failed')) {
    tickState = msg._state === 'pending' ? 'pending' : null;
  } else if (isMine && msg.id > 0 && !msg.deletedAt) {
    const recipients = otherMembers.filter(
      m => !m.leftAt && (!m.joinedAt || m.joinedAt <= msg.createdAt),
    );
    if (recipients.length === 0) {
      tickState = 'sent';
    } else if (recipients.every(m => (m.lastReadMessageId ?? 0) >= msg.id)) {
      tickState = 'read';
    } else if (recipients.every(m => Math.max(m.lastDeliveredMessageId ?? 0, m.lastReadMessageId ?? 0) >= msg.id)) {
      tickState = 'delivered';
    } else {
      tickState = 'sent';
    }
  }
  return tickState;
}
