// lib/messageState.ts — the message send-state machine (Phase 1.2).
//
// One place that defines legal transitions + the tick icon per state, so the
// queue (lib/messageQueue) and the chat UI stop hand-rolling `_state` strings.
// Illegal transitions throw in dev, warn+no-op in prod.
//
//   QUEUED → SENDING → SENT → DELIVERED → READ
//   QUEUED ↔ WAITING_KEYS         (no prekey session yet / keys arrived)
//   SENDING → QUEUED              (transient retry)
//   SENDING → FAILED              (after MAX_RETRIES)
//   FAILED  → QUEUED              (manual tap-to-retry)

export type MsgState =
  | 'QUEUED' | 'WAITING_KEYS' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

const NEXT: Record<MsgState, readonly MsgState[]> = {
  QUEUED:       ['SENDING', 'WAITING_KEYS', 'FAILED'],
  WAITING_KEYS: ['QUEUED', 'SENDING'],
  SENDING:      ['SENT', 'QUEUED', 'WAITING_KEYS', 'FAILED'],
  SENT:         ['DELIVERED', 'READ'],   // READ may skip DELIVERED (receipt race)
  DELIVERED:    ['READ'],
  READ:         [],
  FAILED:       ['QUEUED'],
};

export function canTransition(from: MsgState, to: MsgState): boolean {
  return from === to || (NEXT[from]?.includes(to) ?? false);
}

/** Return `to` if legal, else keep `from` (throw in dev so bad flows surface). */
export function transition(from: MsgState, to: MsgState): MsgState {
  if (canTransition(from, to)) return to;
  const msg = `[messageState] illegal transition ${from} → ${to}`;
  if (typeof __DEV__ !== 'undefined' && __DEV__) throw new Error(msg);
  console.warn(msg);
  return from;
}

export type TickIcon = 'clock' | 'tick' | 'double' | 'double-gold' | 'failed' | null;

/** Tick icon for a state (QUEUED/WAITING_KEYS/SENDING = clock, READ = gold). */
export function tickFor(s: MsgState): TickIcon {
  switch (s) {
    case 'QUEUED': case 'WAITING_KEYS': case 'SENDING': return 'clock';
    case 'SENT':      return 'tick';
    case 'DELIVERED': return 'double';
    case 'READ':      return 'double-gold';
    case 'FAILED':    return 'failed';
    default:          return null;
  }
}

// ── self-check (Phase-1 invariants) — run: npx tsx lib/messageState.ts ──
export function _selfCheck(): void {
  const ok = (c: boolean, m: string) => { if (!c) throw new Error('messageState self-check FAILED: ' + m); };
  ok(canTransition('QUEUED', 'SENDING'), 'QUEUED→SENDING legal');
  ok(canTransition('QUEUED', 'WAITING_KEYS'), 'QUEUED→WAITING_KEYS legal');
  ok(canTransition('WAITING_KEYS', 'QUEUED'), 'keys-arrive legal');
  ok(canTransition('SENDING', 'QUEUED'), 'retry legal');
  ok(canTransition('SENDING', 'FAILED'), 'give-up legal');
  ok(canTransition('FAILED', 'QUEUED'), 'manual retry legal');
  ok(canTransition('SENT', 'READ'), 'read may skip delivered');
  ok(!canTransition('READ', 'SENT'), 'no going back from READ');
  ok(!canTransition('DELIVERED', 'QUEUED'), 'no un-deliver');
  ok(!canTransition('SENT', 'SENDING'), 'no un-send');
  ok(tickFor('WAITING_KEYS') === 'clock' && tickFor('READ') === 'double-gold', 'tick map');
  console.log('messageState self-check: OK');
}
if (typeof require !== 'undefined' && require.main === module) _selfCheck();

export default {};
