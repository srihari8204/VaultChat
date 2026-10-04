// components/chat/bubbleA11yLabel.ts — what a screen reader says for one chat
// bubble: who sent it, what it is, when, and (for your own) its delivery state.
//
// Pure so the selftest can run it. The privacy rules are the bubble's own:
// Invisible Ink text a recipient has not tilted to reveal is never spoken, and
// view-once / revoked media are named, never described.

export type BubbleTick = 'pending' | 'sent' | 'delivered' | 'read' | null;

export interface BubbleA11yInput {
  isMine: boolean;
  senderName?: string | null;
  type: string;
  /** Decrypted text body ('' when there is none or it is not readable). */
  text: string;
  /** Recipient-side Invisible Ink that has not been revealed by a tilt. */
  inkHidden?: boolean;
  viewOnce?: boolean;
  revoked?: boolean;
  /** Media caption, already extracted from the body. */
  caption?: string;
  filename?: string;
  time: string;
  edited?: boolean;
  failed?: boolean;
  tick?: BubbleTick;
}

const KIND: Record<string, string> = {
  image: 'Photo', video: 'Video', audio: 'Voice message', voice: 'Voice message',
  file: 'File', vaultbeam: 'File', location: 'Location', poll: 'Poll',
  sticker: 'Sticker', game_invite: 'Game invite', group_ref: 'Group invite',
};

export function bubbleA11yLabel(b: BubbleA11yInput): string {
  const who = b.isMine ? 'You' : (b.senderName || 'Someone');
  let body: string;
  if (b.revoked) body = 'Media revoked';
  else if (b.viewOnce && (b.type === 'image' || b.type === 'video')) body = `View once ${KIND[b.type].toLowerCase()}`;
  else if (b.inkHidden) body = 'Invisible Ink message, tilt your phone to read';
  else if (KIND[b.type] && b.type !== 'sticker') {
    const extra = b.caption || (b.type === 'file' ? b.filename : '') || '';
    body = extra ? `${KIND[b.type]}: ${extra}` : KIND[b.type];
  } else body = b.text || KIND[b.type] || 'Message';
  const parts = [`${who}: ${body}`, b.time];
  if (b.edited) parts.push('edited');
  if (b.failed) parts.push('not sent, double tap to retry');
  else if (b.isMine && b.tick) parts.push(b.tick === 'pending' ? 'sending' : b.tick);
  return parts.filter(Boolean).join(', ');
}
