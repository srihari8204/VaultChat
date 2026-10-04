// components/root/callRouting.ts — opening the ring screen and acting on call
// notifications. Moved out of app/_layout.tsx unchanged; the root wires these
// into its boot effect. routeToCall (the answered-call router) stays in the
// root, where lib/call/duplicateCall.selftest.ts checks its de-duplication.

import type { Router } from 'expo-router';
import { AppState } from 'react-native';
import { addPersistentListener, getSocket } from '../../lib/socket';
import { getActiveCall } from '../../lib/callState';
import { getRingingPeer, setRingingPeer, getRingScreenPeer, setRingScreenPeer } from '../../lib/ringTracker';
import { cancelIncomingCall } from '../../lib/callNotification';

export type IncomingCall = {
  chatId?: string; peerUid: string; peerName: string; type: string; offer?: string;
  group?: boolean; groupName?: string; waiting?: boolean;
};
export type AnsweredCall = {
  chatId?: string; peerUid: string; peerName: string; type: string; group?: boolean; groupName?: string;
};

// Open the in-app ringing screen for a call. `offer` may be empty (push /
// backgrounded) — incoming-call captures the caller's re-sent offer live.
export function openIncomingCall(router: Router, p: IncomingCall): void {
  // ONE RING SCREEN PER CALLER — the guard lives HERE, not at the call sites.
  //
  // This is a router.push, so every invocation stacks another
  // /incoming-call screen. The socket listener checked getRingingPeer()
  // before calling and was fine; the two notification paths
  // (consumeNativeLaunchIntent and the notifee answer/decline handler) did
  // not. Since the caller re-rings every 3s and each ring can produce a
  // notification, tapping them piled ring screens on top of each other —
  // reported as "so many overlays", with answering the in-app overlay
  // directly working normally because that path only ever routes once.
  //
  // Re-entering for a peer we are ALREADY ringing is a no-op: the screen is
  // up, it owns the ringtone, and it is listening for the caller's re-sealed
  // offer. Bringing it forward is what the OS is already doing.
  // Guard on the RING SCREEN, not on ringingPeer: the latter is already set
  // by the time a backgrounded device shows its notification, so using it
  // here refused to open the screen on the tap that was supposed to open it.
  if (getRingScreenPeer() === p.peerUid) {
    cancelIncomingCall();           // the in-app UI owns the ring; drop the OS one
    return;
  }
  cancelIncomingCall();             // clear any OS full-screen call once the in-app UI takes over
  setRingingPeer(p.peerUid);
  setRingScreenPeer(p.peerUid);
  router.push({
    pathname: '/incoming-call',
    params: {
      chatId: p.chatId || '', peerUid: p.peerUid, peerName: p.peerName,
      type: p.type === 'video' ? 'video' : 'audio',
      offer: p.offer || '',
      group: p.group ? '1' : '', groupName: p.groupName ?? '',
      waiting: p.waiting ? '1' : '',
    },
  });
}

/** The realtime ring (`call_incoming`), persistent across reconnects. Returns its cleanup. */
export function attachIncomingCallListener(routeToIncoming: (p: IncomingCall) => void): () => void {
  const onIncoming = (data: any) => {
    if (!data?.from || !data?.chatId) return;

    // WARM THE ICE/TURN FETCH THE MOMENT THE RING ARRIVES.
    //
    // joinCallRoom needs ice servers before it can connect, and asking for
    // them is a network round trip to a server in Germany. Starting it here
    // — while the phone is still ringing and the user has not decided yet —
    // means the answer does not pay for it. getIceServers caches, never
    // throws, and degrades to STUN, so this is free if the user declines.
    //
    // Deliberately NOT a full pre-warm: opening the call session early would
    // create the call_participants row before the user answered, and the
    // CALLER would see them as joined while the phone was still ringing.
    // Slow is better than lying about who is on the call.
    void import('../../lib/iceConfig').then(m => m.getIceServers()).catch(() => {});
    const active = getActiveCall();
    if (active && active.peerUid === data.from && !data.group) return;   // call-waiting same peer
    if (getRingingPeer() === data.from) return;                          // de-dupe repeated rings
    setRingingPeer(data.from);
    // EMPTY, not the placeholder string, when the signal carries no name.
    //
    // The call screens resolve a blank peerName via getChat(chatId) — but the
    // guard is `if (peerName || !chatId) return`, so handing them the literal
    // 'crazzychat user' looks like a REAL name, skips the lookup, and pins the
    // placeholder on screen for the whole call. That is the reported
    // "usernames not getting displayed, instead getting crazzychat user": the
    // fallback was being injected upstream as data rather than rendered
    // downstream as a last resort.
    const name = data.group ? (data.groupName || 'Group call') : (data.callerName ?? data.fromName ?? '');
    const type = (data.type === 'video' || data.video === '1') ? 'video' : 'audio';
    // App in the FOREGROUND (or a group call) → show the in-app screen.
    // App BACKGROUNDED with a live socket → raise the OS full-screen call UI
    // (lock screen). Answering it routes into the app via the notifee events.
    if (AppState.currentState === 'active' || data.group) {
      routeToIncoming({ chatId: data.chatId, peerUid: data.from, peerName: name, type, offer: data.offer ? JSON.stringify(data.offer) : '', group: !!data.group, groupName: data.groupName, waiting: !!active });
    }
    // NOT backgrounded → do NOT raise a notifee ring here.
    //
    // The native VaultCallMessagingService owns every OS ring (it is the only
    // one that can ring a killed app, and it carries the caller's photo). Two
    // owners is what produced the second, avatar-less notification on channel
    // "calls". The server now pushes on every call rather than guessing from
    // hasLiveSocket, and the native side stays silent while we are foreground,
    // so exactly one of us rings in every state.
  };
  return addPersistentListener('call_incoming', onIncoming);
}

/** Answer or decline from a call notification (notifee, expo, or a bg action). */
export function makeCallActionHandler(routeToCall: (p: AnsweredCall) => void) {
  return (action: string, data: any): void => {
    if (data?.type !== 'call' || !data?.fromUid) return;
    cancelIncomingCall();
    if (action === 'decline') {
      setRingingPeer(null);
      getSocket().then(s => s.emit('webrtc_end', { to: data.fromUid, chatId: data.chatId })).catch(() => {});
      return;
    }
    routeToCall({ chatId: data.chatId, peerUid: data.fromUid, peerName: data.callerName || '', type: data.callType });
  };
}
