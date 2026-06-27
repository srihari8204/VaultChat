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

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import InCallManager from 'react-native-incall-manager';
import { setActiveCall, clearActiveCall, type ActiveCall } from '../lib/callState';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { Alert, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { getCurrentUserAsync } from './(constants)/authService';
import { getTurnConfig, type IceServer } from '../lib/chatService';
import { getSocket } from '../lib/socket';
import { addCallLog } from '../lib/callLog';
import { Ionicons } from '@expo/vector-icons';

type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VoiceCallScreen() {
  const { colors } = useTheme();
  const S = useS();
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
  const ringTimerRef    = useRef<any>(null);
  const offsRef         = useRef<Array<() => void>>([]);
  const secondsRef      = useRef(0);
  const connectedRef    = useRef(false);
  const loggedRef       = useRef(false);

  // Keep refs in sync so endCall (a stable callback) can log accurate history.
  useEffect(() => { secondsRef.current = seconds; }, [seconds]);
  useEffect(() => { if (state === 'connected') connectedRef.current = true; }, [state]);

  // ── teardown ──────────────────────────────────────────────
  const teardown = useCallback((notify = true) => {
    offsRef.current.forEach(fn => { try { fn(); } catch {} });
    offsRef.current = [];
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (ringTimerRef.current) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; }
    try { InCallManager.stop(); } catch {}
    try { localStreamRef.current?.getTracks().forEach((t: any) => t.stop()); } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    if (notify && peerUid) {
      getSocket()
        .then(s => s.emit('webrtc_end', { to: peerUid, from: meIdRef.current, chatId }))
        .catch(() => {});
    }
  }, [peerUid, chatId]);

  const endCall = useCallback((notify = true) => {
    // Log this call to the local history exactly once.
    if (!loggedRef.current && peerUid) {
      loggedRef.current = true;
      const incoming = isIncoming === 'true' || isIncoming === '1';
      const dir: 'incoming' | 'outgoing' | 'missed' = incoming ? (connectedRef.current ? 'incoming' : 'missed') : 'outgoing';
      addCallLog({ chatId, peerUid, peerName: peerName || 'VaultChat user', kind: 'audio', direction: dir, at: Date.now() - secondsRef.current * 1000, durationSec: secondsRef.current }).catch(() => {});
    }
    setState('ended');
    teardown(notify);
    setTimeout(() => router.back(), 200);
  }, [teardown, router, peerUid, peerName, isIncoming]);

  // ── call-waiting / hold registration ───────────────────────
  // Lets a call arriving while we're busy become "call waiting": the incoming
  // screen can hold THIS call (pause our mic) and accept the new one, then we
  // resume when it ends and we regain focus.
  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const speakerRef = useRef(false);
  const heldRef = useRef(false);
  const meRef   = useRef<ActiveCall | null>(null);

  useEffect(() => {
    const me: ActiveCall = {
      chatId, peerUid, peerName: peerName || 'VaultChat user', kind: 'audio',
      hold:   () => { heldRef.current = true;  try {
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => { t.enabled = false; });   // mute my mic
        pcRef.current?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = false; }); // silence the held peer
      } catch {} },
      resume: () => { heldRef.current = false; try {
        InCallManager.start({ media: 'audio', auto: true });               // re-acquire the audio route
        InCallManager.setForceSpeakerphoneOn(speakerRef.current ? true : null);
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => { t.enabled = !mutedRef.current; });
        pcRef.current?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = true; });
      } catch {} },
      hangUp: () => endCall(true),
    };
    meRef.current = me;
    setActiveCall(me);
    return () => clearActiveCall(me);
  }, [chatId, peerUid, peerName, endCall]);

  // Regained focus after a call-waiting call ended → resume + re-assert active.
  useFocusEffect(useCallback(() => {
    if (heldRef.current && meRef.current) { meRef.current.resume(); setActiveCall(meRef.current); }
  }, []));

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
        // 1. Audio session — InCallManager owns the call audio route. `auto`
        //    makes it follow wired/Bluetooth headsets automatically; earpiece
        //    is the default for a voice call (speaker off).
        try {
          InCallManager.start({ media: 'audio', auto: true });
          InCallManager.setForceSpeakerphoneOn(false);
        } catch {}

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
          const ringPayload = {
            to: peerUid,
            from: meIdRef.current,
            chatId,
            type: 'audio',
            callerName: me.name ?? me.email ?? 'VaultChat user',
            offer,
          };
          s.emit('call_incoming', ringPayload);
          s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer });
          setState('ringing');
          // Re-send the ring + offer every 3s while ringing, so a callee whose
          // app was killed (and got the push) still receives the offer once it
          // wakes + reconnects. Stops on connect/teardown or after ~30s.
          let rings = 0;
          ringTimerRef.current = setInterval(() => {
            if (connectedRef.current || rings >= 9) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; return; }
            rings++;
            try { s.emit('call_incoming', ringPayload); s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer }); } catch {}
          }, 3000);
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

  const toggleSpeaker = useCallback(() => {
    const next = !speaker;
    setSpeaker(next);
    speakerRef.current = next;
    // null route when speaker is OFF lets InCallManager keep using a connected
    // Bluetooth/wired headset instead of forcing the earpiece.
    try { InCallManager.setForceSpeakerphoneOn(next ? true : null); } catch {}
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
        <ControlBtn icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
        <ControlBtn icon={speaker ? 'volume-high' : 'volume-low'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={toggleSpeaker} />
        <ControlBtn icon="call" label="End" danger onPress={() => endCall(true)} />
      </View>
    </View>
  );
}

function ControlBtn({ icon, label, onPress, active, danger }:
  { icon: string; label: string; onPress: () => void; active?: boolean; danger?: boolean }) {
  const S = useS();
  return (
    <TouchableOpacity
      style={[S.btn, active && S.btnActive, danger && S.btnDanger]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Ionicons name={icon as any} size={24} color="#fff" style={S.btnIcon} />
      <Text style={S.btnLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

const SUBTLE = 'rgba(255,255,255,0.6)';

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:     { flex: 1, backgroundColor: c.bg },
  body:       { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, gap: 16 },
  avatarWrap: { marginBottom: 16 },
  avatar:     { width: 140, height: 140, borderRadius: 70, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', shadowColor: c.primary, shadowOpacity: 0.6, shadowRadius: 30 },
  avatarTxt:  { color: '#fff', fontSize: 56, fontWeight: '800' },
  name:       { color: c.text, fontSize: 26, fontWeight: '700', textAlign: 'center' },
  status:     { color: c.textDim, fontSize: 16 },
  errorTxt:   { color: c.danger, fontSize: 13, marginTop: 8 },

  controls:   { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: 24, paddingBottom: 48, paddingTop: 12 },
  btn:        { width: 78, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  btnActive:  { backgroundColor: c.primary, borderColor: c.primary },
  btnDanger:  { backgroundColor: c.danger, borderColor: c.danger },
  btnIcon:    { fontSize: 24 },
  btnLabel:   { color: c.text, fontSize: 11, marginTop: 4 },
});
