// components/chat/bubbleA11yActions.ts — what a screen-reader user can do with
// a message bubble.
//
// The bubble is ONE accessible element (it speaks a single summary, see
// bubbleA11yLabel), so on iOS every control nested in it — the quoted reply,
// the play button, a poll option, the link, the view-once shield — is folded
// into it and cannot be focused. Each of those is offered here as a named
// accessibility action instead (VoiceOver's Actions rotor, TalkBack's actions
// menu). Pure, so components/chat/bubbleA11yActions.selftest.ts can run it.

export type BubbleA11yAction = { name: string; label: string };

export interface BubbleA11yFacts {
  /** Optimistic bubble: 'failed' gets Retry/Delete, 'pending' Cancel. */
  state?: 'pending' | 'failed';
  /** Server-confirmed, not deleted, not a system row. */
  confirmed: boolean;
  /** Has a quoted reply that can be jumped to. */
  quote: boolean;
  /** View-once media this recipient has not opened yet. */
  revealOnce: 'photo' | 'video' | null;
  /** Media that opens or plays right now (not revoked, not a spent view-once). */
  media: 'photo' | 'video' | 'voice' | 'file' | null;
  location: boolean;
  /** Label of a group/game card's own action, e.g. "Open Book club". */
  card: string | null;
  /** A link in the visible text or its preview card. */
  link: boolean;
  longRead: boolean;
  poll: { label: string; mine: boolean }[];
}

export function bubbleA11yActions(f: BubbleA11yFacts): BubbleA11yAction[] {
  const out: BubbleA11yAction[] = [{
    name: 'longpress',
    label: f.state === 'failed' ? 'Retry or delete' : f.state === 'pending' ? 'Cancel sending' : 'Message actions',
  }];
  if (f.confirmed && !f.state) {
    out.push({ name: 'reply', label: 'Reply' });
    out.push({ name: 'react', label: 'React' });
  }
  if (f.quote) out.push({ name: 'quote', label: 'Go to quoted message' });
  if (f.revealOnce) out.push({ name: 'reveal', label: `View ${f.revealOnce} once` });
  else if (f.media === 'photo') out.push({ name: 'open', label: 'Open photo' });
  else if (f.media === 'video') out.push({ name: 'open', label: 'Play video' });
  else if (f.media === 'file') out.push({ name: 'open', label: 'Open file' });
  else if (f.media === 'voice') out.push({ name: 'play', label: 'Play or pause voice message' });
  if (f.location) out.push({ name: 'location', label: 'Open in Maps' });
  if (f.card) out.push({ name: 'card', label: f.card });
  if (f.link) out.push({ name: 'link', label: 'Open link' });
  if (f.longRead) out.push({ name: 'reader', label: 'Read as page' });
  f.poll.forEach((o, i) => out.push({ name: `vote:${i}`, label: `${o.mine ? 'Remove vote for' : 'Vote for'} ${o.label}` }));
  return out;
}
