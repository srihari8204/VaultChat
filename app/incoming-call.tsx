// app/incoming-call.tsx — Day 6 incoming-call screen.
//
// Pushed by the root layout when a `call_incoming` socket event arrives.
// Shows caller info + Accept / Decline. On Accept, navigates to
// /videocall or /voicecall with isIncoming=true so the call screen
// answers the carried offer instead of creating a new one.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { CALL } from '../constants/callTheme';
import { getSocket } from '../lib/socket';
import { startRingtone, stopRingtone } from '../lib/sounds';
import { addCallLog } from '../lib/callLog';
import { holdActiveCall } from '../lib/callState';
import { setRingingPeer, setRingScreenPeer } from '../lib/ringTracker';
import { cancelIncomingCall } from '../lib/callNotification';
import { callStage, offerTag } from '../lib/call/diag';
import { initialOf } from '../lib/format';

// Call chrome is always dark (independent of app theme).
const S = makeStyles();

export default function IncomingCallScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { chatId, peerUid, peerName, type, offer, group, groupName, waiting } = useLocalSearchParams<{
    chatId: string;
    peerUid: string;
    peerName: string;
    type:    'audio' | 'video';
    offer:   string;          // JSON-stringified RTCSessionDescription
    group?:  string;          // '1' for a mesh group call
    groupName?: string;
    waiting?: string;         // '1' when a call arrives while already on a call
  }>();
  const isGroup = group === '1';
  const isWaiting = waiting === '1';

  // Who is calling.
  //
  // peerName rides on the call signal, and it arrives EMPTY often enough that
  // an incoming call routinely announced itself as "crazzychat user" — the one
  // thing the screen exists to tell you. The signal is not the only source of
  // truth though: to be called at all we must already share a chat, so the name
  // is sitting in our own chat store. Look it up rather than depending on what
  // the caller happened to send.
  //
  // The param still wins when present — it is the freshest — and the lookup is
  // best-effort, so a failure just leaves the existing fallback in place.
  const [lookedUpName, setLookedUpName] = useState<string | null>(null);
  useEffect(() => {
    if (peerName || isGroup || !chatId) return;
    let cancelled = false;
    (async () => {
      try {
        const { getChat } = await import('../lib/chatService');
        const c = await getChat(String(chatId));
        const n = (c?.peerName ?? '').trim();
        if (!cancelled && n) setLookedUpName(n);
      } catch { /* keep the fallback */ }
    })();
    return () => { cancelled = true; };
  }, [chatId, peerName, isGroup]);

  /** Best name we have, in order of freshness. */
  const displayName = (peerName || lookedUpName || 'crazzychat user');
  // What we hand to the NEXT screen. Never displayName: that may already be the
  // placeholder, and the call screen's own getChat lookup is guarded on the name
  // being blank — so passing the placeholder forward would disable the one
  // mechanism that could still resolve it. Blank travels; the placeholder does
  // not leave this screen.
  const routableName = (peerName || lookedUpName || '');

  // Ring (looping ringtone + vibration, per the user's sound prefs)
  useEffect(() => {
    startRingtone();
    cancelIncomingCall();   // dismiss the OS full-screen call notification — in-app UI now owns the ring
    // Clear the ring-tracker when this screen goes away (so a fresh call from
    // the same person isn't de-duped away).
    // Clear BOTH trackers: ringingPeer (de-dupes repeat call_incoming packets)
    // and ringScreenPeer (says whether this screen is on the stack). Leaving the
    // latter set would make the next call from the same person a no-op.
    return () => { stopRingtone(); setRingingPeer(null); setRingScreenPeer(null); cancelIncomingCall(); };
  }, []);

  // ALWAYS track the caller's latest offer — this screen answers the FRESHEST
  // envelope, never the first one it happened to be opened with.
  //
  // This effect used to bail out with `if (offer) return`, on the reasoning that
  // a route param already carried the offer so there was nothing left to listen
  // for. That was the bug that made encrypted calls unrecoverable.
  //
  // The offer is SEALED with the caller's ratchet session. When that session is
  // stale the callee cannot open it, resets, and asks the caller to re-key — and
  // the caller's ring loop then re-seals and re-sends a NEW, openable envelope
  // every 3 s for the rest of the ring (lib/call/signal.ts ringAndOffer, whose
  // `reseal` hook exists for exactly this). But this screen had already pinned
  // the stale envelope, and app/_layout.tsx de-dupes repeat `call_incoming`
  // events by peer, so the fresh one reached nothing. Accept therefore answered
  // the same dead envelope the callee had just proven it could not open, on
  // every attempt, forever. Observed as four consecutive "openCallOffer failed —
  // aes/gcm: invalid ghash tag" while the re-key itself worked perfectly.
  //
  // The ring loop emits `webrtc_offer` alongside every `call_incoming`, so
  // listening here — with no early return — is all it takes to see the re-sealed
  // envelope. The push path (offer param empty) is unchanged: it was always the
  // path that worked, because it was the only one that reached this listener.
  const liveOfferRef = useRef(offer || '');
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    (async () => {
      const s = await getSocket();
      const onOffer = (d: { from?: string; fromUid?: string; offer?: unknown } | null) => {
        const from = d?.from ?? d?.fromUid;
        if (from !== peerUid || !d?.offer) return;
        const next = JSON.stringify(d.offer);
        // The ring loop re-sends the IDENTICAL wire until the session changes,
        // so only an actual re-seal is worth a line in the log.
        if (next === liveOfferRef.current) return;
        const had = liveOfferRef.current;
        liveOfferRef.current = next;
        if (had) callStage(offerTag(next), 'offer_resealed', `superseding ${offerTag(had)}`);
      };
      // `dead` check before attaching (2026-09-17): the cleanup below runs
      // synchronously, so unmounting while getSocket() was still in flight left
      // `off` null and attached the listener afterwards, with nothing able to
      // remove it. See the webrtc_end effect below for why that mattered.
      if (dead) return;
      s.on('webrtc_offer', onOffer);
      off = () => s.off('webrtc_offer', onOffer);
    })();
    return () => { dead = true; if (off) off(); };
  }, [peerUid]);

  // Leave the ring screen even when it was the app's first screen (a
  // notification launch has no history, and router.back() is then a no-op).
  // Used by the caller-hangup listener below as well as by decline.
  const leaveRef = useRef(() => {});
  leaveRef.current = () => { if (router.canGoBack()) router.back(); else router.replace('/'); };

  // Listen for caller-side hangup before answer
  const decidedRef = useRef(false);
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    (async () => {
      const s = await getSocket();
      const onEnd = (data: { from?: string; fromUid?: string } | null) => {
        if (decidedRef.current) return;
        if (data?.from === peerUid || data?.fromUid === peerUid) {
          decidedRef.current = true;
          stopRingtone();
          addCallLog({ chatId, peerUid, peerName: displayName, kind: type === 'video' ? 'video' : 'audio', direction: 'missed', at: Date.now(), durationSec: 0 }).catch(() => {});
          leaveRef.current();
        }
      };
      // Same `dead` guard as the offer effect. This one is the reason it
      // matters: the leaked handler calls router.back(), so a hangup arriving
      // after this screen had gone POPPED WHATEVER SCREEN THE USER WAS ON.
      if (dead) return;
      s.on('webrtc_end', onEnd);
      off = () => s.off('webrtc_end', onEnd);
    })();
    return () => { dead = true; if (off) off(); };
    // chatId, displayName and type are this screen's route params: fixed for
    // its life, so listing them never re-subscribes in practice.
  }, [peerUid, router, chatId, displayName, type]);

  const leave = () => leaveRef.current();

  // One decision per ring: a double tap must not replace twice, or decline
  // after accepting.
  const accept = () => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    stopRingtone();
    if (isWaiting) holdActiveCall();   // put the call we're on now on hold
    if (isGroup) {
      router.replace({ pathname: '/group-call-active', params: { chatId, video: type === 'video' ? '1' : '0', name: groupName || peerName } });
      return;
    }
    const route = type === 'video' ? '/videocall' as const : '/voicecall' as const;
    // The LIVE offer wins over the route param. They are the same envelope until
    // the caller re-seals, and after a re-seal the param is the one the callee
    // has already proven it cannot open — see the listener above.
    const answering = liveOfferRef.current || offer;

    // ANSWER IMMEDIATELY, offer or no offer.
    //
    // This used to block until the caller's sealed envelope arrived, showing a
    // "Connecting…" state and, when the answer came from a notification (which
    // carries no envelope), a second screen on top of the ring — reported on
    // device as "another overlay after accepting". The envelope carried the SDP
    // and later the media key, so waiting was genuinely required.
    //
    // It carries neither now. One live call per chat is a database constraint,
    // so the call screen joins the caller's room from the chat id alone, and an
    // answer that beats the ring is simply an answer.
    callStage(offerTag(answering), 'accepted', type === 'video' ? 'video' : 'audio');
    router.replace({
      pathname: route,
      params: { chatId, peerUid, peerName: routableName, isIncoming: 'true', initialOffer: answering },
    });
  };

  const decline = async () => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    stopRingtone();
    addCallLog({ chatId, peerUid, peerName: displayName, kind: type === 'video' ? 'video' : 'audio', direction: 'declined', at: Date.now(), durationSec: 0 }).catch(() => {});
    // TELL THE CALLER FIRST, and say so if we could not.
    //
    // Sent before leaving, as it always was: leaving releases the ring claim,
    // and the caller re-sends its ring every few seconds until it hears this.
    // A swallowed failure used to leave the caller's phone ringing until its
    // own timeout with nothing on either screen, so a failed first try is
    // retried in the background (the ring screen is gone by then) and the user
    // is told if it never got through.
    //
    // A GROUP ring is different: the group engine only accepts webrtc_end from
    // live participants (lib/call/engine.ts `accept`), so a decliner's end is
    // ignored there by design and the call carries on for everyone else.
    // Sent anyway for older builds; a failure is not worth an alert.
    //
    // BOUNDED: the first try waits at most DECLINE_WAIT_MS. getSocket() on a
    // hung connect only gives up when lib/socket.ts abandons it, and the ring
    // screen must not sit there that long after a tap on Decline. A first try
    // still in flight keeps going and counts if it lands.
    const first = sendDecline(peerUid, chatId, 1);
    const inTime = await Promise.race([first, new Promise<false>(r => setTimeout(() => r(false), DECLINE_WAIT_MS))]);
    leave();
    if (inTime) return;
    const told = (await first) || await sendDecline(peerUid, chatId, 2, 1500);
    if (!told && !isGroup) {
      Alert.alert('Could not reach the caller', `${displayName} may keep hearing it ring until their call times out.`);
    }
  };

  // Hardware back on a ringing call is a decline. Without this, back popped
  // the screen with only the ringtone stopped: no webrtc_end, no call log, and
  // the caller kept ringing.
  const declineRef = useRef(decline);
  declineRef.current = decline;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!decidedRef.current) void declineRef.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const initial = initialOf(displayName);

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      <View style={[S.body, { paddingTop: insets.top }]}>
        <Text style={S.label}>{isWaiting ? 'On another call' : type === 'video' ? 'Incoming video call' : 'Incoming voice call'}</Text>
        {/* Decorative: the name below says who is calling. */}
        <View style={S.avatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={S.avatarTxt}>{initial}</Text>
        </View>
        <Text numberOfLines={1} style={S.name}>{displayName}</Text>
        {isWaiting && <Text style={S.label}>{type === 'video' ? 'Video call' : 'Voice call'} waiting…</Text>}
      </View>

      <View style={[S.controls, { paddingBottom: insets.bottom + 32 }]}>
        <TouchableOpacity style={[S.btn, S.btnDecline]} onPress={decline} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Decline call">
          <Ionicons name="call" size={28} color={CALL.text} style={{ transform: [{ rotate: '135deg' }] }} />
          <Text style={S.btnLabel}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[S.btn, S.btnAccept]}
          onPress={accept}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={isWaiting ? 'Hold current call and accept' : 'Accept call'}
        >
          <Ionicons name={type === 'video' ? 'videocam' : 'call'} size={28} color={CALL.text} />
          <Text style={S.btnLabel}>{isWaiting ? 'Hold & accept' : 'Accept'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** How long Decline waits for the first send before leaving the ring screen anyway. */
const DECLINE_WAIT_MS = 2500;

// ponytail: "sent" means emitted on a connected socket, not received. The
// realtime transport is ccwire, and its event dispatch gives legacy events like
// webrtc_end no semantic acknowledgement (vaultchat-backend-go
// internal/realtime/ccwire_app_events.go `appEvent`: a transport Ack "must never
// be interpreted as durable delivery"). Switch to an acknowledged send once
// ccwire carries a semantic ack for relayed call events.
/** Send the decline, waiting `delayMs` before each attempt. True once sent. */
async function sendDecline(peerUid: string, chatId: string, attempts: number, delayMs = 0): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    try {
      const s = await getSocket();
      s.emit('webrtc_end', { to: peerUid, chatId });
      return true;
    } catch { /* realtime link down — try again */ }
  }
  return false;
}

function makeStyles() { return StyleSheet.create({
  screen:    { flex: 1, backgroundColor: CALL.bg },
  body:      { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  label:     { color: CALL.textDim, fontSize: 14, letterSpacing: 1.5, textTransform: 'uppercase' },
  avatar:    { width: 160, height: 160, borderRadius: 80, backgroundColor: CALL.active, alignItems: 'center', justifyContent: 'center', marginTop: 12, shadowColor: CALL.active, shadowOpacity: 0.6, shadowRadius: 30 },
  avatarTxt: { color: CALL.text, fontSize: 64, fontWeight: '800' },
  name:      { color: CALL.text, fontSize: 26, fontWeight: '700' },

  controls:  { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 32 },
  btn:       { width: 110, alignItems: 'center', justifyContent: 'center', paddingVertical: 18, borderRadius: 24, gap: 6 },
  btnAccept: { backgroundColor: CALL.active },
  btnDecline:{ backgroundColor: CALL.danger },
  btnIcon:   { fontSize: 28 },
  btnLabel:  { color: CALL.text, fontSize: 13, fontWeight: '700' },
}); }
