// app/incoming-call.tsx — Day 6 incoming-call screen.
//
// Pushed by the root layout when a `call_incoming` socket event arrives.
// Shows caller info + Accept / Decline. On Accept, navigates to
// /videocall or /voicecall with isIncoming=true so the call screen
// answers the carried offer instead of creating a new one.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef , useMemo} from 'react';
import { StatusBar, StyleSheet, Text, TouchableOpacity, Vibration, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getSocket } from '../lib/socket';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function IncomingCallScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { chatId, peerUid, peerName, type, offer } = useLocalSearchParams<{
    chatId: string;
    peerUid: string;
    peerName: string;
    type:    'audio' | 'video';
    offer:   string;          // JSON-stringified RTCSessionDescription
  }>();

  // Buzz pattern while ringing
  useEffect(() => {
    Vibration.vibrate([0, 800, 600, 800, 600, 800], true);
    return () => Vibration.cancel();
  }, []);

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
          Vibration.cancel();
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
    Vibration.cancel();
    const route = type === 'video' ? '/videocall' : '/voicecall';
    router.replace({
      pathname: route as any,
      params: { chatId, peerUid, peerName, isIncoming: 'true', initialOffer: offer },
    });
  };

  const decline = async () => {
    decidedRef.current = true;
    Vibration.cancel();
    try {
      const s = await getSocket();
      s.emit('webrtc_end', { to: peerUid, chatId });
    } catch {}
    router.back();
  };

  const initial = (peerName?.trim()[0] ?? '?').toUpperCase();

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      <View style={S.body}>
        <Text style={S.label}>{type === 'video' ? 'Incoming video call' : 'Incoming voice call'}</Text>
        <View style={S.avatar}><Text style={S.avatarTxt}>{initial}</Text></View>
        <Text style={S.name}>{peerName || 'VaultChat user'}</Text>
      </View>

      <View style={S.controls}>
        <TouchableOpacity style={[S.btn, S.btnDecline]} onPress={decline} activeOpacity={0.85}>
          <Text style={S.btnIcon}>📵</Text>
          <Text style={S.btnLabel}>Decline</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[S.btn, S.btnAccept]} onPress={accept} activeOpacity={0.85}>
          <Text style={S.btnIcon}>{type === 'video' ? '📹' : '📞'}</Text>
          <Text style={S.btnLabel}>Accept</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const SUBTLE = 'rgba(255,255,255,0.7)';

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:    { flex: 1, backgroundColor: c.bg },
  body:      { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  label:     { color: c.textDim, fontSize: 14, letterSpacing: 1.5, textTransform: 'uppercase' },
  avatar:    { width: 160, height: 160, borderRadius: 80, backgroundColor: '#6C63FF', alignItems: 'center', justifyContent: 'center', marginTop: 12, shadowColor: '#6C63FF', shadowOpacity: 0.6, shadowRadius: 30 },
  avatarTxt: { color: '#fff', fontSize: 64, fontWeight: '800' },
  name:      { color: c.text, fontSize: 26, fontWeight: '700' },

  controls:  { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 32, paddingBottom: 56 },
  btn:       { width: 110, alignItems: 'center', justifyContent: 'center', paddingVertical: 18, borderRadius: 24, gap: 6 },
  btnAccept: { backgroundColor: c.primary },
  btnDecline:{ backgroundColor: c.danger },
  btnIcon:   { fontSize: 28 },
  btnLabel:  { color: '#fff', fontSize: 13, fontWeight: '700' },
});
