// app/voicecall.tsx — Day 6 voice call (audio-only WebRTC).
//
// Real peer-to-peer with our coturn relay fallback. Signaling rides on
// the shared Socket.IO connection (events: webrtc_offer, webrtc_answer,
// webrtc_ice, webrtc_end, call_incoming — defined in server.js).
//
// Route params:
//   chatId      — the chat to call (must be a direct chat MVP)
//   peerUid     — the other user's uuid (we already have this from chats)
//   peerName    — display name (header)
//   isIncoming  — "true" when this screen was opened from an incoming-call event
//
// State:
//   getUserMedia({ audio: true }) → RTCPeerConnection → exchange offer/
//   answer/ICE via socket → ontrack flips state to connected → start timer.
//
// Audio routing: earpiece by default (private). Speaker toggle button.
// Cleanup: stops local tracks, closes pc, emits webrtc_end, leaves screen.

import { Audio } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { getCurrentUserAsync } from './(constants)/authService';
import { getTurnConfig, type IceServer } from '../lib/chatService';
import { getSocket } from '../lib/socket';

type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

export default function VoiceCallScreen() {
  const router = useRouter();
  const { chatId, peerUid, peerName, isIncoming, initialOffer } =
    useLocalSearchParams<{
      chatId: string;
      peerUid: string;
      peerName: string;
      isIncoming?: string;
      initialOffer?: string;        // JSON-stringified RTCSessionDescription
    }>();

  const [state,   setState]   = useState<CallState>('connecting');
  const [muted,   setMuted]   = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error,   setError]   = useState<string | null>(null);

  const pcRef           = useRef<RTCPeerConnection | null>(null);
  const localStreamRef  = useRef<any>(null);
  const meIdRef         = useRef<string>('');
  const timerRef        = useRef<any>(null);
  const offsRef         = useRef<Array<() => void>>([]);

  // ── teardown ──────────────────────────────────────────────
  const teardown = useCallback((notify = true) => {
    offsRef.current.forEach(fn => { try { fn(); } catch {} });
    offsRef.current = [];
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { localStreamRef.current?.getTracks().forEach((t: any) => t.stop()); } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    if (notify && peerUid) {
      getSocket()
        .then(s => s.emit('webrtc_end', { to: peerUid, chatId }))
        .catch(() => {});
    }
  }, [peerUid, chatId]);

  const endCall = useCallback((notify = true) => {
    setState('ended');
    teardown(notify);
    setTimeout(() => router.back(), 200);
  }, [teardown, router]);

  // ── timer ──────────────────────────────────────────────────
  const startTimer = useCallback(() => {
    if (timerRef.current) return;
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  }, []);

  // ── setup pipeline ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        // 1. Audio session — earpiece by default for voice calls
        await Audio.setAudioModeAsync({
          allowsRecordingIOS:         true,
          playsInSilentModeIOS:       true,
          playThroughEarpieceAndroid: true,
        });

        // 2. Identity
        const me = await getCurrentUserAsync();
        if (!me?.id) throw new Error('Not signed in');
        meIdRef.current = me.id;

        // 3. Get media (audio only)
        const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        if (cancelled) { stream.getTracks().forEach((t: any) => t.stop()); return; }
        localStreamRef.current = stream;

        // 4. Fetch ICE config (TURN credentials from our backend)
        const turn = await getTurnConfig().catch(() => ({ iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
        ] as IceServer[] }));

        // 5. Build peer connection
        const pc = new RTCPeerConnection({ iceServers: turn.iceServers as any });
        pcRef.current = pc;
        stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));

        (pc as any).ontrack = (e: any) => {
          // Remote audio plays automatically on native; no <RTCView> needed for audio.
          if (state !== 'connected') {
            setState('connected');
            startTimer();
          }
        };

        // 6. Socket + signaling wires
        const s = await getSocket();

        const onAnswer = async (data: any) => {
          if (data?.from !== peerUid && data?.fromUid !== peerUid) return;
          const sdp = data.answer || data.sdp;
          if (!sdp || !pcRef.current) return;
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
          if (state !== 'connected') { setState('connected'); startTimer(); }
        };
        const onIce = async (data: any) => {
          if (data?.from !== peerUid && data?.fromUid !== peerUid) return;
          if (!data?.candidate || !pcRef.current) return;
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
        };
        const onEnd = (data: any) => {
          if (data?.from === peerUid || data?.fromUid === peerUid) endCall(false);
        };
        s.on('webrtc_answer', onAnswer);
        s.on('webrtc_ice',    onIce);
        s.on('webrtc_end',    onEnd);
        offsRef.current.push(() => s.off('webrtc_answer', onAnswer));
        offsRef.current.push(() => s.off('webrtc_ice',    onIce));
        offsRef.current.push(() => s.off('webrtc_end',    onEnd));

        (pc as any).onicecandidate = (event: any) => {
          if (!event.candidate || !peerUid) return;
          s.emit('webrtc_ice', { to: peerUid, from: meIdRef.current, candidate: event.candidate });
        };

        (pc as any).onconnectionstatechange = () => {
          const st = (pc as any).connectionState;
          if (st === 'failed' || st === 'disconnected' || st === 'closed') {
            endCall(true);
          }
        };

        // 7. Either accept the incoming offer, or create + send our own
        if (isIncoming === 'true' && initialOffer) {
          const offerObj = JSON.parse(String(initialOffer));
          await pc.setRemoteDescription(new RTCSessionDescription(offerObj));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          s.emit('webrtc_answer', { to: peerUid, from: meIdRef.current, answer });
          setState('connecting');
        } else {
          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
          await pc.setLocalDescription(offer);
          // Notify peer it's an incoming call (separate event so the
          // recipient can show a UI before answering, and so that the
          // OFFER itself can ride alongside)
          s.emit('call_incoming', {
            to: peerUid,
            from: meIdRef.current,
            chatId,
            type: 'audio',
            callerName: me.name ?? me.email ?? 'VaultChat user',
            offer,
          });
          s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer });
          setState('ringing');
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? 'Call failed');
        endCall(true);
      }
    };

    run();
    return () => { cancelled = true; teardown(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerUid, chatId, isIncoming, initialOffer]);

  // ── controls ──────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks?.() ?? [];
    const next = !muted;
    tracks.forEach((t: any) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const toggleSpeaker = useCallback(async () => {
    const next = !speaker;
    setSpeaker(next);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS:         true,
        playsInSilentModeIOS:       true,
        playThroughEarpieceAndroid: !next,   // false → speaker; true → earpiece
      });
    } catch {}
  }, [speaker]);

  // ── render ────────────────────────────────────────────────
  const statusText = state === 'connecting' ? 'Connecting…'
    : state === 'ringing'   ? 'Ringing…'
    : state === 'connected' ? formatDuration(seconds)
    : 'Call ended';
  const initial = (peerName?.trim()[0] ?? '?').toUpperCase();

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      <View style={S.body}>
        <View style={S.avatarWrap}>
          <View style={S.avatar}><Text style={S.avatarTxt}>{initial}</Text></View>
        </View>
        <Text style={S.name}>{peerName || 'VaultChat user'}</Text>
        <Text style={S.status}>{statusText}</Text>
        {error && <Text style={S.errorTxt}>{error}</Text>}
      </View>

      <View style={S.controls}>
        <ControlBtn icon={muted ? '🎙️̸' : '🎙️'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
        <ControlBtn icon={speaker ? '🔊' : '🔈'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={toggleSpeaker} />
        <ControlBtn icon="📴" label="End" danger onPress={() => endCall(true)} />
      </View>
    </View>
  );
}

function ControlBtn({ icon, label, onPress, active, danger }:
  { icon: string; label: string; onPress: () => void; active?: boolean; danger?: boolean }) {
  return (
    <TouchableOpacity
      style={[S.btn, active && S.btnActive, danger && S.btnDanger]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Text style={S.btnIcon}>{icon}</Text>
      <Text style={S.btnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

const BG     = '#0A0F1A';
const TEXT   = '#FFFFFF';
const SUBTLE = 'rgba(255,255,255,0.6)';
const ACCENT = '#6C63FF';
const DANGER = '#EF4444';

const S = StyleSheet.create({
  screen:     { flex: 1, backgroundColor: BG },
  body:       { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, gap: 16 },
  avatarWrap: { marginBottom: 16 },
  avatar:     { width: 140, height: 140, borderRadius: 70, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', shadowColor: ACCENT, shadowOpacity: 0.6, shadowRadius: 30 },
  avatarTxt:  { color: '#fff', fontSize: 56, fontWeight: '800' },
  name:       { color: TEXT, fontSize: 26, fontWeight: '700', textAlign: 'center' },
  status:     { color: SUBTLE, fontSize: 16 },
  errorTxt:   { color: DANGER, fontSize: 13, marginTop: 8 },

  controls:   { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 24, paddingBottom: 48, paddingTop: 12 },
  btn:        { width: 78, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  btnActive:  { backgroundColor: ACCENT, borderColor: ACCENT },
  btnDanger:  { backgroundColor: DANGER, borderColor: DANGER },
  btnIcon:    { fontSize: 24 },
  btnLabel:   { color: TEXT, fontSize: 11, marginTop: 4 },
});
