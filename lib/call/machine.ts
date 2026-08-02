// lib/call/machine.ts — the call lifecycle, as a pure reducer.
//
// WHY A REDUCER, AND WHY PURE
// ---------------------------
// The transition rules already existed — spread across three screens as inline
// guards like `if (state !== 'connected')`, `if (pcRef.current.signalingState
// !== 'have-local-offer')`, `if (!loggedRef.current)`. They were correct, hard
// won, and impossible to test: reproducing them needs a peer, a socket, a TURN
// server and two phones.
//
// Extracting them here makes the rules explicit and checkable in Node. Nothing
// in this file imports react, react-native or WebRTC; `now` is passed in rather
// than read from the clock, so every transition is deterministic.
//
// INVARIANTS THIS ENCODES (each one is a bug that has bitten this code before)
//   1. `ended` is terminal. A late webrtc_end, an ICE failure racing teardown,
//      or an unmount after hangUp can never resurrect or mutate a finished call.
//   2. Connecting is idempotent. The callee re-sends its answer up to 5x and
//      the caller re-rings up to 9x, so "we are connected" arrives repeatedly;
//      only the first stamps connectedAt. Duration must not restart.
//   3. `ringing` is outgoing-only. An incoming call is answering, not ringing.
//   4. endReason is write-once — the FIRST cause wins. A local hangup that
//      triggers an ICE 'failed' a moment later is still a local hangup.
//   5. Unchanged input returns the SAME object reference, so useSyncExternalStore
//      does not wake subscribers for a no-op.

import { IDLE_SNAPSHOT, type CallSnapshot, type EndReason, type Participant } from './types';

/** Local device toggles that never affect the lifecycle. */
export type CallFlag = 'muted' | 'speaker' | 'cameraOff' | 'sharing' | 'held';

export type CallEvent =
  /** Outgoing offer is on the wire (also fired on each re-ring — idempotent). */
  | { type: 'offer_sent' }
  /** Our local media is up; `url` feeds the self-preview. */
  | { type: 'local_stream'; url: string | null }
  /** Remote media arrived for a peer — the authoritative "connected" signal. */
  | { type: 'remote_stream'; uid: string; url: string | null; name?: string }
  /** Remote SDP applied. Connects even before the first frame (audio calls). */
  | { type: 'answer_applied' }
  /** A mesh peer left. In 1:1 this ends the call; the engine decides that. */
  | { type: 'peer_left'; uid: string }
  | { type: 'peer_muted'; uid: string; muted: boolean }
  | { type: 'flag'; key: CallFlag; value: boolean }
  | { type: 'error'; message: string }
  | { type: 'end'; reason: EndReason };

export interface StartParams {
  chatId: string;
  peerUid: string;
  peerName: string;
  kind: CallSnapshot['kind'];
  direction: CallSnapshot['direction'];
  transport?: CallSnapshot['transport'];
}

/** The snapshot a freshly started call begins from. */
export function startSnapshot(p: StartParams): CallSnapshot {
  return {
    ...IDLE_SNAPSHOT,
    status: 'connecting',
    kind: p.kind,
    direction: p.direction,
    transport: p.transport ?? 'mesh',
    chatId: p.chatId,
    peerUid: p.peerUid,
    peerName: p.peerName,
    // Video calls default to speaker, voice calls to earpiece — the shipped
    // behaviour of app/videocall.tsx and app/voicecall.tsx respectively.
    speaker: p.kind === 'video',
    participants: {},
  };
}

function withParticipant(
  s: CallSnapshot, uid: string, patch: Partial<Participant>,
): Readonly<Record<string, Participant>> {
  const prev = s.participants[uid];
  const next: Participant = {
    uid,
    name: prev?.name ?? '',
    streamUrl: prev?.streamUrl ?? null,
    role: prev?.role ?? 'speaker',
    muted: prev?.muted ?? false,
    ...patch,
  };
  if (prev && prev.name === next.name && prev.streamUrl === next.streamUrl
      && prev.role === next.role && prev.muted === next.muted) {
    return s.participants;   // no-op: keep the reference
  }
  return { ...s.participants, [uid]: next };
}

/**
 * Apply one event. Returns `s` unchanged (same reference) when the event is a
 * no-op, which is the common case during the re-send storms around setup.
 */
export function reduce(s: CallSnapshot, e: CallEvent, now: number): CallSnapshot {
  // Invariant 1: terminal.
  if (s.status === 'ended') return s;

  switch (e.type) {
    case 'offer_sent':
      // Invariant 3 + 2: outgoing only, and never demote a live call back to
      // ringing when a re-ring tick fires after connect.
      if (s.direction !== 'outgoing' || s.status !== 'connecting') return s;
      return { ...s, status: 'ringing' };

    case 'local_stream':
      if (s.localUrl === e.url) return s;
      return { ...s, localUrl: e.url };

    case 'remote_stream': {
      const patch: Partial<Participant> = { streamUrl: e.url };
      if (e.name) patch.name = e.name;
      const participants = withParticipant(s, e.uid, patch);
      const connecting = s.status !== 'connected';
      if (participants === s.participants && !connecting) return s;
      return {
        ...s,
        participants,
        status: 'connected',
        // Invariant 2: stamp once.
        connectedAt: s.connectedAt || now,
      };
    }

    case 'answer_applied':
      if (s.status === 'connected') return s;   // invariant 2
      return { ...s, status: 'connected', connectedAt: s.connectedAt || now };

    case 'peer_left': {
      if (!s.participants[e.uid]) return s;
      const next = { ...s.participants };
      delete next[e.uid];
      return { ...s, participants: next };
    }

    case 'peer_muted': {
      const participants = withParticipant(s, e.uid, { muted: e.muted });
      return participants === s.participants ? s : { ...s, participants };
    }

    case 'flag':
      if (s[e.key] === e.value) return s;
      return { ...s, [e.key]: e.value };

    case 'error':
      if (s.error === e.message) return s;
      return { ...s, error: e.message };

    case 'end':
      return {
        ...s,
        status: 'ended',
        // Invariant 4: first cause wins.
        endReason: s.endReason ?? e.reason,
      };

    default:
      return s;
  }
}

/**
 * Seconds of connected media, for the call log. 0 when the call never
 * connected — which is exactly what marks it missed/cancelled.
 */
export function durationSeconds(s: CallSnapshot, now: number): number {
  if (!s.connectedAt) return 0;
  return Math.max(0, Math.round((now - s.connectedAt) / 1000));
}

/** True when this call should be logged as a missed incoming call. */
export function wasMissed(s: CallSnapshot): boolean {
  return s.direction === 'incoming' && !s.connectedAt;
}

/**
 * True when hanging up should also tell the callee's device to stop ringing
 * (which converts their ring into a "missed call"). Only meaningful for an
 * outgoing call abandoned before it was answered.
 */
export function shouldCancelRing(s: CallSnapshot): boolean {
  return s.direction === 'outgoing' && !s.connectedAt;
}

export default {};
