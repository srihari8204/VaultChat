// app/incoming-call.tsx — Day 6 incoming-call screen.
//
// Pushed by the root layout when a `call_incoming` socket event arrives.
// Shows caller info + Accept / Decline. On Accept, navigates to
// /videocall or /voicecall with isIncoming=true so the call screen
// answers the carried offer instead of creating a new one.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
  // an incoming call routinely announced itself as "VaultChat user" — the one
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
  const displayName = (peerName || lookedUpName || 'VaultChat user');
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
  // Accept-before-offer: how long to wait for the caller's sealed offer before
  // telling the user it did not come through. The caller re-emits every 3s for
  // up to 9 rings, so this covers several attempts without stranding anyone.
  const ACCEPT_OFFER_WAIT_MS = 12_000;
  const [waitingForOffer, setWaitingForOffer] = useState(false);
  const acceptWaitRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (acceptWaitRef.current) clearInterval(acceptWaitRef.current); }, []);
  useEffect(() => {
    let off: (() => void) | null = null;
    (async () => {
      const s = await getSocket();
      const onOffer = (d: any) => {
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
      s.on('webrtc_offer', onOffer);
      off = () => s.off('webrtc_offer', onOffer);
    })();
    return () => { if (off) off(); };
  }, [peerUid]);

  // Listen for caller-side hangup before answer
  const decidedRef = useRef(false);
  useEffect(() => {
    let off: (() => void) | null = null;
    (async () => {
      const s = await getSocket();
      const onEnd = (data: any) => {
        if (decidedRef.current) return;
        if (data?.from === peerUid || data?.fromUid === peerUid) {
          decidedRef.current = true;
          stopRingtone();
          addCallLog({ chatId, peerUid, peerName: displayName, kind: type === 'video' ? 'video' : 'audio', direction: 'missed', at: Date.now(), durationSec: 0 }).catch(() => {});
          router.back();
        }
      };
      s.on('webrtc_end', onEnd);
      off = () => s.off('webrtc_end', onEnd);
    })();
    return () => { if (off) off(); };
  }, [peerUid, router]);

  const accept = () => {
    decidedRef.current = true;
    stopRingtone();
    if (isWaiting) holdActiveCall();   // put the call we're on now on hold
    if (isGroup) {
      router.replace({ pathname: '/group-call-active' as any, params: { chatId, video: type === 'video' ? '1' : '0', name: groupName || peerName } });
      return;
    }
    const route = type === 'video' ? '/videocall' : '/voicecall';
    // The LIVE offer wins over the route param. They are the same envelope until
    // the caller re-seals, and after a re-seal the param is the one the callee
    // has already proven it cannot open — see the listener above.
    const answering = liveOfferRef.current || offer;

    // DO NOT NAVIGATE WITHOUT AN OFFER.
    //
    // Answering can beat the offer: the ring arrives over its own event, and a
    // notification answer carries no offer at all. Handing the call screen an
    // empty one used to make it dial the caller BACK (see the guard there), so
    // one tap produced a second call and the two collided.
    //
    // Waiting is safe and short — the caller re-emits the sealed offer every 3s
    // for the life of the ring — and it is what the user already expects from
    // the moment between tapping Accept and hearing audio. If it never comes,
    // we say so instead of dialling.
    if (!answering) {
      callStage(offerTag(null), 'accept_waiting', 'offer not arrived yet');
      setWaitingForOffer(true);
      const started = Date.now();
      const t = setInterval(() => {
        const live = liveOfferRef.current;
        if (live) {
          clearInterval(t);
          callStage(offerTag(live), 'accepted', type === 'video' ? 'video' : 'audio');
          router.replace({
            pathname: route as any,
            params: { chatId, peerUid, peerName: routableName, isIncoming: 'true', initialOffer: live },
          });
        } else if (Date.now() - started > ACCEPT_OFFER_WAIT_MS) {
          clearInterval(t);
          setWaitingForOffer(false);
          decidedRef.current = false;   // let them try again — nothing was torn down
          Alert.alert('Could not connect', 'The call did not come through. Ask them to call again.');
          router.back();
        }
      }, 250);
      acceptWaitRef.current = t;
      return;
    }

    callStage(offerTag(answering), 'accepted', type === 'video' ? 'video' : 'audio');
    router.replace({
      pathname: route as any,
      params: { chatId, peerUid, peerName: routableName, isIncoming: 'true', initialOffer: answering },
    });
  };

  const decline = async () => {
    decidedRef.current = true;
    stopRingtone();
    addCallLog({ chatId, peerUid, peerName: displayName, kind: type === 'video' ? 'video' : 'audio', direction: 'missed', at: Date.now(), durationSec: 0 }).catch(() => {});
    try {
      const s = await getSocket();
      s.emit('webrtc_end', { to: peerUid, chatId });
    } catch {}
    router.back();
  };

  const initial = (displayName.trim()[0] ?? '?').toUpperCase();

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      <View style={S.body}>
        <Text style={S.label}>{isWaiting ? 'On another call' : type === 'video' ? 'Incoming video call' : 'Incoming voice call'}</Text>
        <View style={S.avatar}><Text style={S.avatarTxt}>{initial}</Text></View>
        <Text style={S.name}>{displayName}</Text>
        {isWaiting && <Text style={S.label}>{type === 'video' ? 'Video call' : 'Voice call'} waiting…</Text>}
      </View>

      <View style={[S.controls, { paddingBottom: insets.bottom + 32 }]}>
        <TouchableOpacity style={[S.btn, S.btnDecline]} onPress={decline} activeOpacity={0.85}>
          <Ionicons name="call" size={28} color="#fff" style={{ transform: [{ rotate: '135deg' }] }} />
          <Text style={S.btnLabel}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[S.btn, S.btnAccept, waitingForOffer && { opacity: 0.6 }]}
          onPress={accept}
          disabled={waitingForOffer}
          activeOpacity={0.85}
        >
          <Ionicons name={type === 'video' ? 'videocam' : 'call'} size={28} color="#fff" />
          {/* Says what is actually happening while we wait for the caller's
              offer, rather than looking like a dead button. */}
          <Text style={S.btnLabel}>{waitingForOffer ? 'Connecting…' : isWaiting ? 'Hold & accept' : 'Accept'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function makeStyles() { return StyleSheet.create({
  screen:    { flex: 1, backgroundColor: CALL.bg },
  body:      { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  label:     { color: CALL.textDim, fontSize: 14, letterSpacing: 1.5, textTransform: 'uppercase' },
  avatar:    { width: 160, height: 160, borderRadius: 80, backgroundColor: CALL.active, alignItems: 'center', justifyContent: 'center', marginTop: 12, shadowColor: CALL.active, shadowOpacity: 0.6, shadowRadius: 30 },
  avatarTxt: { color: '#fff', fontSize: 64, fontWeight: '800' },
  name:      { color: CALL.text, fontSize: 26, fontWeight: '700' },

  controls:  { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 32 },
  btn:       { width: 110, alignItems: 'center', justifyContent: 'center', paddingVertical: 18, borderRadius: 24, gap: 6 },
  btnAccept: { backgroundColor: CALL.active },
  btnDecline:{ backgroundColor: CALL.danger },
  btnIcon:   { fontSize: 28 },
  btnLabel:  { color: '#fff', fontSize: 13, fontWeight: '700' },
}); }
