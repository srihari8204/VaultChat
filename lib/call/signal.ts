// lib/call/signal.ts — every socket message a call sends or receives.
//
// One place, so the wire is described once. The events, payload field names and
// re-send cadences below are IDENTICAL to what the three call screens emit
// today — that is what keeps an engine build and a legacy build interoperable,
// and it is why this migration can ship behind a flag at all.
//
// The re-send loops are reliability, not sloppiness, and are preserved exactly:
//   • ring + offer every 3 s, up to 9 times — lets a killed-then-woken callee
//     still catch the offer after the FCM push starts its process.
//   • answer up to 5 times at 1.5 s — the answer is one-shot, and a single
//     socket 'transport error' blip during setup used to drop it permanently and
//     strand the call. The caller's apply is idempotent (see CallPeer.applyAnswer).

import { getSocket } from '../socket';

export interface RingPayload {
  to: string;
  from: string;
  chatId: string;
  type: 'audio' | 'video';
  callerName: string;
  offer: any;
}

type Off = () => void;

/** Attach the three per-call listeners. Returns one detach for all of them. */
export async function attachCallListeners(handlers: {
  peerUid: string;
  onAnswer: (sdp: any) => void;
  onIce: (candidate: any) => void;
  onEnd: () => void;
}): Promise<Off> {
  const s = await getSocket();
  const fromPeer = (d: any) => d?.from === handlers.peerUid || d?.fromUid === handlers.peerUid;

  const onAnswer = (d: any) => { if (fromPeer(d)) handlers.onAnswer(d?.answer ?? d?.sdp); };
  const onIce    = (d: any) => { if (fromPeer(d)) handlers.onIce(d?.candidate); };
  const onEnd    = (d: any) => { if (fromPeer(d)) handlers.onEnd(); };

  s.on('webrtc_answer', onAnswer);
  s.on('webrtc_ice', onIce);
  s.on('webrtc_end', onEnd);
  return () => {
    try { s.off('webrtc_answer', onAnswer); } catch {}
    try { s.off('webrtc_ice', onIce); } catch {}
    try { s.off('webrtc_end', onEnd); } catch {}
  };
}

export async function sendIce(to: string, from: string, candidate: any): Promise<void> {
  try { (await getSocket()).emit('webrtc_ice', { to, from, candidate }); } catch {}
}

export async function sendEnd(to: string, from: string, chatId: string): Promise<void> {
  try { (await getSocket()).emit('webrtc_end', { to, from, chatId }); } catch {}
}

/**
 * Ring the peer and deliver the offer, then keep re-sending BOTH on the same
 * cadence the screens use. `isDone()` stops the loop the moment the call
 * connects or tears down. Returns a canceller.
 *
 * The SAME sealed wire is re-sent every tick — never re-encrypted per tick,
 * because a fresh seal per tick would ratchet needlessly and the callee only
 * applies the first one anyway.
 */
export async function ringAndOffer(
  payload: RingPayload, isDone: () => boolean,
): Promise<Off> {
  const s = await getSocket();
  const offerWire = { to: payload.to, from: payload.from, offer: payload.offer };
  const emitBoth = () => {
    try { s.emit('call_incoming', payload); s.emit('webrtc_offer', offerWire); } catch {}
  };
  emitBoth();

  let rings = 0;
  const timer = setInterval(() => {
    if (isDone() || rings >= 9) { clearInterval(timer); return; }
    rings++;
    emitBoth();
  }, 3000);
  return () => clearInterval(timer);
}

/** Send the answer, then re-send it until connected (max 5 total). */
export async function sendAnswerWithRetry(
  to: string, from: string, answer: any, isDone: () => boolean,
): Promise<Off> {
  const s = await getSocket();
  const wire = { to, from, answer };
  try { s.emit('webrtc_answer', wire); } catch {}

  let tries = 0;
  const timer = setInterval(() => {
    if (isDone() || tries >= 4) { clearInterval(timer); return; }
    tries++;
    try { s.emit('webrtc_answer', wire); } catch {}
  }, 1500);
  return () => clearInterval(timer);
}

export default {};
