// app/videocall.tsx — Day 6 video call (audio + video WebRTC).
//
// Same plumbing as app/voicecall.tsx — see comments there. Differences:
//   * getUserMedia({ video: true, audio: true })
//   * Local preview via small <RTCView> in a corner
//   * Remote video via large <RTCView>
//   * Extra control: switch camera (front <-> back)

import { Audio } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { Alert, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from 'react-native-webrtc';
import { getCurrentUserAsync } from './(constants)/authService';
import { getTurnConfig, type IceServer } from '../lib/chatService';
import { getSocket } from '../lib/socket';

type CallState = 'connecting' | 'ringing' | 'connected' | 'ended';

// ─── Beautify filters (path 1 — color-matrix data + overlay fallback) ─
//
// The canonical definition of each filter is a 4×5 ColorMatrix — the same
// representation used by both `react-native-color-matrix-image-filters`
// (raster Image children) and by future `@shopify/react-native-skia`
// frame-processor shaders (live RTCView). When we ship the Skia path
// (path 2 in [memory/backlog_real_beautify.md]) the only change is the
// renderer; the matrices below stay.
//
// RTCView is a SurfaceView/TextureView managed by WebRTC and is NOT a
// raster Image, so the color-matrix lib can't reach inside it today.
// We therefore RENDER the filter as an RGBA overlay derived from the
// matrix's diagonal scale + offset (a close-enough cosmetic approximation
// of the same filter). The matrix is also applied verbatim wherever we
// render a peer Image (e.g. ringing/ended fallback avatar).
//
// What this gives us TODAY:
//   ✅ Real pixel-level color transform on every Image-rendered surface
//   ✅ Filter swatch colors derived from the matrix (visual consistency)
//   ✅ Future-proof data — flip renderer to Skia, matrices unchanged
//   ⚠️  Live RTCView is still an approximation overlay until path 2 ships
//
// Matrix layout: [Rr Rg Rb Ra Roff,  Gr Gg Gb Ga Goff,  Br Bg Bb Ba Boff,  Ar Ag Ab Aa Aoff]
// Each output channel = sum(input * coef) + offset/255.
//
// `react-native-color-matrix-image-filters` is installed but not imported
// here — it would only apply to <Image> children, and the call screen
// renders <RTCView> + <Text> initials, no raster Image. Import it in
// path-2 wherever an Image preview gets wrapped.

type FilterId = 'none' | 'soft' | 'warm' | 'glow' | 'cool' | 'mono' | 'vivid';
interface FilterDef {
  id:     FilterId;
  label:  string;
  matrix: number[] | null;   // 20 floats (4×5); null = identity (no-op)
  swatch: string;            // chip preview color, derived from matrix
}

const IDENTITY: number[] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

const FILTERS: FilterDef[] = [
  { id: 'none', label: 'Off',  matrix: null, swatch: 'transparent' },
  // Soft: gentle warmth + brightness lift (+5%) — flattering portrait skin
  { id: 'soft', label: 'Soft', swatch: 'rgba(255,235,225,1)', matrix: [
    1.05, 0,    0,    0, 6,
    0,    1.02, 0,    0, 4,
    0,    0,    0.98, 0, 2,
    0,    0,    0,    1, 0,
  ] },
  // Warm: pull greens/blues toward red — sunset-like
  { id: 'warm', label: 'Warm', swatch: 'rgba(255,180,120,1)', matrix: [
    1.10, 0.05, 0,    0, 10,
    0,    1.00, 0,    0, 4,
    0,    0,    0.85, 0, 0,
    0,    0,    0,    1, 0,
  ] },
  // Glow: bright lift on all channels + slight desaturation toward warm white
  { id: 'glow', label: 'Glow', swatch: 'rgba(255,220,180,1)', matrix: [
    1.05, 0.04, 0.04, 0, 18,
    0.04, 1.05, 0.04, 0, 14,
    0.02, 0.02, 1.00, 0, 8,
    0,    0,    0,    1, 0,
  ] },
  // Cool: pull reds toward blue, slight contrast bump
  { id: 'cool', label: 'Cool', swatch: 'rgba(160,200,255,1)', matrix: [
    0.90, 0,    0.05, 0, 0,
    0,    1.00, 0.05, 0, 4,
    0.05, 0.05, 1.10, 0, 12,
    0,    0,    0,    1, 0,
  ] },
  // Mono: BT.601 luma weights — true grayscale
  { id: 'mono', label: 'Mono', swatch: 'rgba(60,60,60,1)', matrix: [
    0.299, 0.587, 0.114, 0, 0,
    0.299, 0.587, 0.114, 0, 0,
    0.299, 0.587, 0.114, 0, 0,
    0,     0,     0,     1, 0,
  ] },
  // Vivid: saturation 1.5× via simplified saturate matrix
  { id: 'vivid', label: 'Vivid', swatch: 'rgba(255,80,80,1)', matrix: [
    1.35, -0.20, -0.15, 0, 0,
   -0.15,  1.40, -0.25, 0, 0,
   -0.20, -0.20,  1.40, 0, 0,
    0,     0,     0,    1, 0,
  ] },
];

// Approximate a ColorMatrix as an RGBA overlay so the live RTCView still
// gets a visible cosmetic effect even before Skia ships. We read the
// diagonal scale + offset of each channel and squash to a tint + opacity.
function matrixToOverlay(m: number[] | null): { tint?: string; opacity?: number } {
  if (!m) return {};
  // Scale offsets to [0..255]
  const rOff = Math.max(0, Math.min(255, m[4]));
  const gOff = Math.max(0, Math.min(255, m[9]));
  const bOff = Math.max(0, Math.min(255, m[14]));
  // Use mean diagonal as a proxy for "how aggressive" the filter is
  const aggression = Math.max(0, (Math.abs(m[0] - 1) + Math.abs(m[6] - 1) + Math.abs(m[12] - 1)) / 3);
  const opacity    = Math.min(0.35, 0.08 + aggression * 1.2);
  // Tint is the offset color mixed with the diagonal lean
  const tint = `rgba(${Math.round(255 - rOff)},${Math.round(255 - gOff)},${Math.round(255 - bOff)},1)`;
  return { tint, opacity };
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VideoCallScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { chatId, peerUid, peerName, isIncoming, initialOffer } =
    useLocalSearchParams<{
      chatId: string;
      peerUid: string;
      peerName: string;
      isIncoming?: string;
      initialOffer?: string;
    }>();

  const [state,    setState]    = useState<CallState>('connecting');
  const [muted,    setMuted]    = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [speaker,  setSpeaker]  = useState(true);    // speaker on by default for video
  const [seconds,  setSeconds]  = useState(0);
  const [error,    setError]    = useState<string | null>(null);
  const [localUrl,  setLocalUrl]  = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [filter,    setFilter]    = useState<FilterId>('none');
  const [showFilters, setShowFilters] = useState(false);

  const pcRef           = useRef<RTCPeerConnection | null>(null);
  const localStreamRef  = useRef<any>(null);
  const meIdRef         = useRef<string>('');
  const timerRef        = useRef<any>(null);
  const offsRef         = useRef<Array<() => void>>([]);

  const teardown = useCallback((notify = true) => {
    offsRef.current.forEach(fn => { try { fn(); } catch {} });
    offsRef.current = [];
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { localStreamRef.current?.getTracks().forEach((t: any) => t.stop()); } catch {}
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    if (notify && peerUid) {
      getSocket().then(s => s.emit('webrtc_end', { to: peerUid, from: meIdRef.current, chatId })).catch(() => {});
    }
  }, [peerUid, chatId]);

  const endCall = useCallback((notify = true) => {
    setState('ended');
    teardown(notify);
    setTimeout(() => router.back(), 200);
  }, [teardown, router]);

  const startTimer = useCallback(() => {
    if (timerRef.current) return;
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS:         true,
          playsInSilentModeIOS:       true,
          playThroughEarpieceAndroid: false,
        });

        const me = await getCurrentUserAsync();
        if (!me?.id) throw new Error('Not signed in');
        meIdRef.current = me.id;

        const stream: any = await mediaDevices.getUserMedia({
          audio: true,
          video: { facingMode: 'user' },
        } as any);
        if (cancelled) { stream.getTracks().forEach((t: any) => t.stop()); return; }
        localStreamRef.current = stream;
        setLocalUrl(stream.toURL());

        const turn = await getTurnConfig().catch(() => ({ iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
        ] as IceServer[] }));

        const pc = new RTCPeerConnection({ iceServers: turn.iceServers as any });
        pcRef.current = pc;
        stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));

        (pc as any).ontrack = (e: any) => {
          const remoteStream = e.streams?.[0];
          if (remoteStream) setRemoteUrl(remoteStream.toURL());
          if (state !== 'connected') { setState('connected'); startTimer(); }
        };

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
          if (st === 'failed' || st === 'disconnected' || st === 'closed') endCall(true);
        };

        if (isIncoming === 'true' && initialOffer) {
          const offerObj = JSON.parse(String(initialOffer));
          await pc.setRemoteDescription(new RTCSessionDescription(offerObj));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          s.emit('webrtc_answer', { to: peerUid, from: meIdRef.current, answer });
          setState('connecting');
        } else {
          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
          await pc.setLocalDescription(offer);
          s.emit('call_incoming', {
            to: peerUid,
            from: meIdRef.current,
            chatId,
            type: 'video',
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

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks?.() ?? [];
    const next = !muted;
    tracks.forEach((t: any) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks?.() ?? [];
    const next = !cameraOff;
    tracks.forEach((t: any) => { t.enabled = !next; });
    setCameraOff(next);
  }, [cameraOff]);

  const flipCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks?.() ?? [];
    tracks.forEach((t: any) => { try { t._switchCamera?.(); } catch {} });
  }, []);

  const toggleSpeaker = useCallback(async () => {
    const next = !speaker;
    setSpeaker(next);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS:         true,
        playsInSilentModeIOS:       true,
        playThroughEarpieceAndroid: !next,
      });
    } catch {}
  }, [speaker]);

  const statusText = state === 'connecting' ? 'Connecting…'
    : state === 'ringing'   ? 'Ringing…'
    : state === 'connected' ? formatDuration(seconds)
    : 'Call ended';

  const f = FILTERS.find(x => x.id === filter) ?? FILTERS[0];
  // Derive a tint+opacity overlay from the filter's ColorMatrix. When
  // path-2 (Skia frame processor) ships, the matrix gets applied directly
  // to the video texture and `overlay` is no longer rendered.
  const overlay = matrixToOverlay(f.matrix);

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      {/* Remote video fills screen */}
      <View style={S.remote}>
        {remoteUrl ? (
          <RTCView style={S.remoteVid} streamURL={remoteUrl} objectFit="cover" />
        ) : (
          <View style={[S.remoteVid, S.remotePlaceholder]}>
            <Text style={S.placeholderInitial}>{(peerName?.trim()[0] ?? '?').toUpperCase()}</Text>
          </View>
        )}
        {/* Beautify overlay — derived from filter's ColorMatrix */}
        {overlay.tint && (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, { backgroundColor: overlay.tint, opacity: overlay.opacity }]}
          />
        )}
      </View>

      {/* Top bar: name + status */}
      <View style={S.topBar} pointerEvents="none">
        <Text style={S.name}>{peerName || 'VaultChat user'}</Text>
        <Text style={S.status}>{statusText}</Text>
        {error && <Text style={S.errorTxt}>{error}</Text>}
      </View>

      {/* Local preview */}
      {localUrl && !cameraOff && (
        <View style={S.localWrap}>
          <RTCView style={S.local} streamURL={localUrl} objectFit="cover" mirror zOrder={1} />
          {overlay.tint && (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFillObject, { backgroundColor: overlay.tint, opacity: overlay.opacity }]}
            />
          )}
        </View>
      )}

      {/* Beautify filter strip (toggled by Beautify button) */}
      {showFilters && (
        <View style={S.filterStrip}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.filterRow}>
            {FILTERS.map(opt => (
              <TouchableOpacity
                key={opt.id}
                style={[S.filterChip, filter === opt.id && S.filterChipActive]}
                onPress={() => setFilter(opt.id)}
                activeOpacity={0.8}
              >
                <View
                  style={[
                    S.filterSwatch,
                    opt.matrix
                      ? { backgroundColor: opt.swatch }
                      : { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.4)' },
                    filter === opt.id && { borderColor: '#FFFFFF' },
                  ]}
                />
                <Text style={[S.filterLabel, filter === opt.id && S.filterLabelActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Controls */}
      <View style={S.controls}>
        <ControlBtn icon={muted ? '🎙️̸' : '🎙️'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
        <ControlBtn icon={cameraOff ? '📷̸' : '📷'} label={cameraOff ? 'Camera' : 'Off'} active={cameraOff} onPress={toggleCamera} />
        <ControlBtn icon="🔄" label="Flip" onPress={flipCamera} />
        <ControlBtn
          icon="✨"
          label={filter === 'none' ? 'Beauty' : f.label}
          active={showFilters || filter !== 'none'}
          onPress={() => setShowFilters(v => !v)}
        />
        <ControlBtn icon={speaker ? '🔊' : '🔈'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={toggleSpeaker} />
        <ControlBtn icon="📴" label="End" danger onPress={() => endCall(true)} />
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

const SUBTLE = 'rgba(255,255,255,0.7)';

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:     { flex: 1, backgroundColor: c.bg },
  remote:     { flex: 1, backgroundColor: c.bg },
  remoteVid:  { width: '100%', height: '100%' },
  remotePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderInitial: { fontSize: 96, color: 'rgba(255,255,255,0.3)', fontWeight: '900' },
  // Subtle radial-ish glow — RN can't do true radial gradients without a lib,
  // but a soft full-screen white wash at low opacity reads as a halo on top
  // of darker midtones in the video.
  glow:       { opacity: 0.10 },

  topBar:     { position: 'absolute', top: 56, left: 24, right: 24, alignItems: 'center', gap: 4 },
  name:       { color: c.text, fontSize: 22, fontWeight: '700' },
  status:     { color: c.textDim, fontSize: 14 },
  errorTxt:   { color: c.danger, fontSize: 13, marginTop: 4 },

  localWrap:  { position: 'absolute', top: 60, right: 16, width: 110, height: 150, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  local:      { width: '100%', height: '100%' },

  filterStrip:     { position: 'absolute', left: 0, right: 0, bottom: 116, backgroundColor: 'rgba(10,10,15,0.7)', paddingVertical: 12 },
  filterRow:       { paddingHorizontal: 16, gap: 12, alignItems: 'center' },
  filterChip:      { alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  filterChipActive:{ },
  filterSwatch:    { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: 'transparent' },
  filterLabel:     { color: 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' },
  filterLabelActive:{ color: '#FFFFFF' },

  controls:   { position: 'absolute', left: 12, right: 12, bottom: 36, flexDirection: 'row', justifyContent: 'space-around', backgroundColor: 'rgba(20,20,30,0.6)', paddingVertical: 14, borderRadius: 24 },
  btn:        { width: 64, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)' },
  btnActive:  { backgroundColor: c.primary },
  btnDanger:  { backgroundColor: c.danger },
  btnIcon:    { fontSize: 22 },
  btnLabel:   { color: c.text, fontSize: 10, marginTop: 2 },
});
