// app/incoming-call.tsx — Day 6 incoming-call screen.
//
// Pushed by the root layout when a `call_incoming` socket event arrives.
// Shows caller info + Accept / Decline. On Accept, navigates to
// /videocall or /voicecall with isIncoming=true so the call screen
// answers the carried offer instead of creating a new one.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { CALL } from '../constants/callTheme';
import { getSocket } from '../lib/socket';
import { startRingtone, stopRingtone } from '../lib/sounds';
import { addCallLog } from '../lib/callLog';
import { holdActiveCall } from '../lib/callState';
import { setRingingPeer } from '../lib/ringTracker';
import { cancelIncomingCall } from '../lib/callNotification';

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

  // Ring (looping ringtone + vibration, per the user's sound prefs)
  useEffect(() => {
    startRingtone();
    cancelIncomingCall();   // dismiss the OS full-screen call notification — in-app UI now owns the ring
    // Clear the ring-tracker when this screen goes away (so a fresh call from
    // the same person isn't de-duped away).
    return () => { stopRingtone(); setRingingPeer(null); cancelIncomingCall(); };
  }, []);

  // If opened from a push (offer empty), capture the WebRTC offer the caller
  // re-sends every few seconds, so Accept can still answer the original call.
  const liveOfferRef = useRef(offer || '');
  useEffect(() => {
    if (offer) return;
    let off: (() => void) | null = null;
    (async () => {
      const s = await getSocket();
      const onOffer = (d: any) => {
        const from = d?.from ?? d?.fromUid;
        if (from === peerUid && d?.offer) liveOfferRef.current = JSON.stringify(d.offer);
      };
      s.on('webrtc_offer', onOffer);
      off = () => s.off('webrtc_offer', onOffer);
    })();
    return () => { if (off) off(); };
  }, [offer, peerUid]);

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
    router.replace({
      pathname: route as any,
      params: { chatId, peerUid, peerName: displayName, isIncoming: 'true', initialOffer: offer || liveOfferRef.current },
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
        <TouchableOpacity style={[S.btn, S.btnAccept]} onPress={accept} activeOpacity={0.85}>
          <Ionicons name={type === 'video' ? 'videocam' : 'call'} size={28} color="#fff" />
          <Text style={S.btnLabel}>{isWaiting ? 'Hold & accept' : 'Accept'}</Text>
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
