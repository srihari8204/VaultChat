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
  /**
   * Optional: return a freshly sealed offer wire, or null to keep the current
   * one. Called before each ring repeat so a session re-key mid-ring can be
   * picked up instead of re-sending an envelope the callee has already proven
   * it cannot open.
   */
  reseal?: () => any | null;
}

type Off = () => void;

/**
 * TWO WIRE SHAPES, both of which must keep working.
 *
 * The 1:1 screens and the mesh screen were written at different times and put
 * the SDP under different keys:
 *
 *   direct (1:1)  webrtc_offer  { to, from, offer }      answer: { to, from, answer }
 *   mesh          webrtc_offer  { to, chatId, sdp }      answer: { to, chatId, sdp }
 *
 * The Go relay forwards the whole payload verbatim and stamps `from`/`fromUid`,
 * so both have always worked — but a build that SENDS the wrong shape is
 * invisible to the sender and silently unreadable to a legacy peer. The engine
 * therefore keeps the shapes separate and picks by mode, which is what lets an
 * engine build and a legacy build call each other in either direction.
 */
export type WireMode = 'direct' | 'mesh' | 'sfu';

/** Read the SDP from either shape. Receivers are deliberately tolerant. */
const readSdp = (d: any) => d?.offer ?? d?.answer ?? d?.sdp;
const senderOf = (d: any): string => d?.from ?? d?.fromUid ?? '';

/**
 * Attach the per-call socket listeners. Routes by SENDER rather than assuming a
 * single peer, so one attachment serves a 1:1 call and an N-way mesh alike —
 * `accept` decides which senders belong to this call.
 */
export async function attachCallListeners(handlers: {
  accept: (from: string) => boolean;
  onOffer?: (from: string, sdp: any) => void;
  onAnswer: (from: string, sdp: any) => void;
  onIce: (from: string, candidate: any) => void;
  onEnd: (from: string) => void;
  onPeerScreenShare: (from: string, on: boolean) => void;
  onChat: (from: string, sealed: any) => void;
  /** The call's shared media key, sealed for us. See sendMediaKey. */
  onMediaKey?: (from: string, sealed: any) => void;
  onReaction: (from: string, sealed: any) => void;
}): Promise<Off> {
  const s = await getSocket();
  const route = (fn: (from: string, d: any) => void) => (d: any) => {
    const from = senderOf(d);
    if (from && handlers.accept(from)) fn(from, d);
  };

  const onOffer   = route((from, d) => handlers.onOffer?.(from, readSdp(d)));
  const onAnswer  = route((from, d) => handlers.onAnswer(from, readSdp(d)));
  const onIce     = route((from, d) => handlers.onIce(from, d?.candidate));
  const onEnd     = route((from) => handlers.onEnd(from));
  const onShare   = route((from) => handlers.onPeerScreenShare(from, true));
  const onUnshare = route((from) => handlers.onPeerScreenShare(from, false));
  const onChat    = route((from, d) => handlers.onChat(from, d?.text));
  const onMediaKey = route((from, d) => handlers.onMediaKey?.(from, d?.key));
  const onEmoji   = route((from, d) => handlers.onReaction(from, d?.emoji));

  s.on('webrtc_offer', onOffer);
  s.on('webrtc_answer', onAnswer);
  s.on('webrtc_ice', onIce);
  s.on('webrtc_end', onEnd);
  s.on('screen_share_start', onShare);
  s.on('screen_share_stop', onUnshare);
  s.on('call_chat', onChat);
  s.on('call_media_key', onMediaKey);
  s.on('call_emoji', onEmoji);
  return () => {
    for (const [e, h] of [['webrtc_offer', onOffer], ['webrtc_answer', onAnswer],
      ['webrtc_ice', onIce], ['webrtc_end', onEnd],
      ['screen_share_start', onShare], ['screen_share_stop', onUnshare],
      ['call_chat', onChat], ['call_emoji', onEmoji],
      ['call_media_key', onMediaKey]] as const) {
      try { s.off(e, h as any); } catch {}
    }
  };
}

export async function sendIce(
  to: string, from: string, chatId: string, candidate: any, mode: WireMode,
): Promise<void> {
  const p = mode === 'mesh' ? { to, chatId, candidate } : { to, from, candidate };
  try { (await getSocket()).emit('webrtc_ice', p); } catch {}
}

export async function sendEnd(to: string, from: string, chatId: string): Promise<void> {
  try { (await getSocket()).emit('webrtc_end', { to, from, chatId }); } catch {}
}

/** Mesh: offer a peer, in the shape the legacy mesh screen expects. */
export async function sendMeshOffer(to: string, chatId: string, sdp: any): Promise<void> {
  try { (await getSocket()).emit('webrtc_offer', { to, chatId, sdp }); } catch {}
}

/** Mesh: answer a peer, in the shape the legacy mesh screen expects. */
export async function sendMeshAnswer(to: string, chatId: string, sdp: any): Promise<void> {
  try { (await getSocket()).emit('webrtc_answer', { to, chatId, sdp }); } catch {}
}

/**
 * Join the server-side call room and subscribe to its roster events.
 *
 * `call_full` is a real outcome, not an error path: the server enforces the mesh
 * cap and refuses the joiner rather than admitting them and degrading the call
 * for everyone already in it.
 */
export async function joinCallRoom(handlers: {
  chatId: string;
  onRoster: (peers: string[]) => void;
  onJoined: (uid: string) => void;
  onLeft: (uid: string) => void;
  onFull: (max: number) => void;
}): Promise<Off> {
  const s = await getSocket();
  const mine = (d: any) => d?.chatId === handlers.chatId;

  const onRoster = (d: any) => { if (mine(d)) handlers.onRoster(Array.isArray(d?.peers) ? d.peers : []); };
  const onJoined = (d: any) => { if (mine(d) && d?.uid) handlers.onJoined(d.uid); };
  const onLeft   = (d: any) => { if (mine(d) && d?.uid) handlers.onLeft(d.uid); };
  const onFull   = (d: any) => { if (mine(d)) handlers.onFull(Number(d?.max) || 5); };

  s.on('call_roster', onRoster);
  s.on('call_peer_joined', onJoined);
  s.on('call_peer_left', onLeft);
  s.on('call_full', onFull);
  s.emit('join_call', { chatId: handlers.chatId });

  return () => {
    try { s.emit('leave_call', { chatId: handlers.chatId }); } catch {}
    for (const [e, h] of [['call_roster', onRoster], ['call_peer_joined', onJoined],
      ['call_peer_left', onLeft], ['call_full', onFull]] as const) {
      try { s.off(e, h as any); } catch {}
    }
  };
}

/**
 * Session events — roles and raised hands (B2/B4).
 *
 * These come from the REST layer's fan-out (emitx.ChatEvent) rather than the
 * per-peer relay the WebRTC signals use, so they arrive on the CHAT room and
 * carry a chatId instead of being sender-routed. That is the right shape for
 * them: a role change is a fact about the call, not a message between two
 * peers, and it must reach a participant whose media link to the actor may not
 * even exist.
 *
 * Filtered by callId when we have one, so a second call starting in the same
 * chat cannot reorder the roles of the one we are on.
 */
export async function attachSessionListeners(handlers: {
  chatId: string;
  currentCallId: () => string;
  onRole: (uid: string, role: string) => void;
  onHand: (uid: string, raised: boolean) => void;
  onEnded: (reason: string) => void;
}): Promise<Off> {
  const s = await getSocket();
  const mine = (d: any) => {
    if (d?.chatId !== handlers.chatId) return false;
    const id = handlers.currentCallId();
    // Before our own session id lands, accept by chat alone — the alternative
    // is dropping the role we are assigned in the same breath as joining.
    return !id || !d?.callId || d.callId === id;
  };
  const onRole  = (d: any) => { if (mine(d) && d?.userId && d?.role) handlers.onRole(d.userId, d.role); };
  const onHand  = (d: any) => { if (mine(d) && d?.userId) handlers.onHand(d.userId, !!d.raised); };
  const onEnded = (d: any) => { if (mine(d)) handlers.onEnded(String(d?.reason ?? 'ended')); };

  s.on('call_role_changed', onRole);
  s.on('call_hand_changed', onHand);
  s.on('call_session_ended', onEnded);
  return () => {
    for (const [e, h] of [['call_role_changed', onRole], ['call_hand_changed', onHand],
      ['call_session_ended', onEnded]] as const) {
      try { s.off(e, h as any); } catch {}
    }
  };
}

/** Ring every member of a group so their device shows the incoming call. */
export async function ringGroup(
  members: string[], from: string, chatId: string, groupName: string, isVideo: boolean,
): Promise<void> {
  try {
    const s = await getSocket();
    for (const to of members) {
      s.emit('call_incoming', {
        to, from, chatId, group: true, groupName,
        video: isVideo ? '1' : '0', type: isVideo ? 'video' : 'audio',
      });
    }
  } catch {}
}

/**
 * Tell the peer we started/stopped sharing our screen. The server has relayed
 * these two events all along; without them a screen share arrives on the other
 * side as an unexplained change of picture.
 */
export async function sendScreenShare(to: string, chatId: string, on: boolean): Promise<void> {
  try {
    (await getSocket()).emit(on ? 'screen_share_start' : 'screen_share_stop', { to, chatId });
  } catch {}
}

/**
 * In-call chat and reactions, sent to ONE peer at a time.
 *
 * `sealed` is a CallCipher envelope, not a string — this is the same messenger
 * whose every other message is end-to-end encrypted, and an in-call side channel
 * that quietly wasn't would be the one place your text is readable by the
 * server. The engine seals per peer, so a mesh sends N envelopes rather than one
 * plaintext broadcast.
 *
 * Both events are addressed with `to` and travel the authenticated relay that
 * stamps `from` server-side (the same one webrtc_* uses). They previously rode a
 * chat-room broadcast that trusted a client-supplied `from` — spoofable by any
 * chat member, whether or not they were in the call. No client ever sent or
 * received either event, so nothing depended on the old shape.
 */
export async function sendCallChat(to: string, chatId: string, sealed: any): Promise<void> {
  try { (await getSocket()).emit('call_chat', { to, chatId, text: sealed }); } catch {}
}

export async function sendCallEmoji(to: string, chatId: string, sealed: any): Promise<void> {
  try { (await getSocket()).emit('call_emoji', { to, chatId, emoji: sealed }); } catch {}
}

/**
 * Hand one peer the call's MEDIA key, sealed with that peer's call cipher.
 *
 * Needed because mesh and SFU want different key shapes. Mesh mints a key PER
 * PAIR, which is exactly right when every link is its own connection — but an
 * SFU forwards one encrypted stream to everyone, so every participant must hold
 * the SAME key or nobody can decode anybody. This is the distribution step that
 * closes that gap.
 *
 * It rides the existing per-peer sealed channel (server stamps `from`, same
 * relay webrtc_* uses), so the media key is protected by the Double Ratchet the
 * call already established. No new trust, no new key agreement — which is the
 * whole reason the E2EE guarantee survives the switch to an SFU.
 */
export async function sendMediaKey(to: string, chatId: string, sealed: any): Promise<void> {
  try { (await getSocket()).emit('call_media_key', { to, chatId, key: sealed }); } catch {}
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
  let offer = payload.offer;
  const emitBoth = () => {
    try {
      s.emit('call_incoming', { ...payload, offer });
      s.emit('webrtc_offer', { to: payload.to, from: payload.from, offer });
    } catch {}
  };
  emitBoth();

  let rings = 0;
  const timer = setInterval(() => {
    if (isDone() || rings >= 9) { clearInterval(timer); return; }
    rings++;
    // RE-SEAL before re-sending, if the caller says the session changed.
    //
    // This loop used to capture the sealed wire once and re-emit that exact
    // bytes 9 times over 27s. When the callee could not open it, it reset its
    // session and asked us to re-key — but every repeat was still the OLD
    // envelope, so all 9 failed identically and the call could never recover
    // in place. Seen on device as four consecutive "openCallOffer failed —
    // aes/gcm: invalid ghash tag" while the re-key itself worked perfectly.
    // The user's only recourse was to hang up and redial.
    //
    // Re-sealing only when the epoch moved keeps the one-wrap-per-call
    // property that callCrypto's header depends on: an unchanged session
    // re-sends the identical wire, exactly as before.
    if (payload.reseal) {
      try {
        const fresh = payload.reseal();
        if (fresh) offer = fresh;
      } catch {}
    }
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
