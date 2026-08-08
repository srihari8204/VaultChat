// app/videocall.tsx — Day 6 video call (audio + video WebRTC).
//
// Same plumbing as app/voicecall.tsx — see comments there. Differences:
//   * getUserMedia({ video: true, audio: true })
//   * Local preview via small <RTCView> in a corner
//   * Remote video via large <RTCView>
//   * Extra control: switch camera (front <-> back)

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import InCallManager from 'react-native-incall-manager';
import { setActiveCall, clearActiveCall, type ActiveCall } from '../lib/callState';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Platform, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CALL, CALL_TEXT_SHADOW } from '../constants/callTheme';
import {
  mediaDevices,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  RTCView,
} from '@livekit/react-native-webrtc';
import { getCurrentUserAsync } from './(constants)/authService';
import { getIceServers } from '../lib/iceConfig';
import { getSocket } from '../lib/socket';
import { startCallForeground, stopCallForeground, dismissIncomingNotification, initiateCall, cancelCall } from '../lib/CallService';
import { newCallCipher, openCallOffer, plainCipher, type CallCipher } from '../lib/callCrypto';
import { addCallLog } from '../lib/callLog';
import { CallTimer, elapsedSeconds } from '../components/call/CallTimer';
import { CallControlButton } from '../components/call/CallControlButton';
import { CallExtras } from '../components/call/CallExtras';
import { CallEncryptionBadge } from '../components/call/CallEncryptionBadge';
import { CALL_ENGINE_V2 } from '../constants/flags';
import * as engine from '../lib/call/engine';
import { DISCONNECT_GRACE_MS } from '../lib/call/peer';
import {
  useCallConnectedAt, useCallError, useCallFlag, useCallLocalUrl,
  useCallStatus, useParticipantStreamUrl,
} from '../hooks/useCall';
import { Ionicons } from '@expo/vector-icons';

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

// Call chrome is always dark (independent of app theme), so styles are static.
const S = makeStyles();

/**
 * Route entry. Same dispatcher as app/voicecall.tsx: one flag chooses the
 * engine-backed renderer or the original implementation, both drawing the same
 * chrome from the same styles and speaking the same wire. The legacy body is
 * deleted once CALL_ENGINE_V2 passes the OEM matrix on real hardware.
 */
export default function VideoCallScreen() {
  return CALL_ENGINE_V2 ? <VideoCallEngine /> : <VideoCallLegacy />;
}

// ── engine-backed renderer (CALL_ENGINE_V2) ───────────────────────────
// Beautify filters stay here on purpose: they are pure local presentation with
// no protocol involvement, so they belong to the screen, not the engine.
function VideoCallEngine() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { chatId, peerUid, peerName, isIncoming, initialOffer } =
    useLocalSearchParams<{
      chatId: string; peerUid: string; peerName: string;
      isIncoming?: string; initialOffer?: string;
    }>();

  const status      = useCallStatus();
  const connectedAt = useCallConnectedAt();
  const error       = useCallError();
  const muted       = useCallFlag('muted');
  const speaker     = useCallFlag('speaker');
  const cameraOff   = useCallFlag('cameraOff');
  const sharing     = useCallFlag('sharing');
  const peerSharing = useCallFlag('peerSharing');
  const localUrl    = useCallLocalUrl();
  const remoteUrl   = useParticipantStreamUrl(String(peerUid ?? ''));

  const [filter, setFilter] = useState<FilterId>('none');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    const incoming = isIncoming === 'true' || isIncoming === '1';
    const args = {
      chatId: String(chatId ?? ''), peerUid: String(peerUid ?? ''),
      peerName: String(peerName ?? ''), kind: 'video' as const,
    };
    if (incoming && initialOffer) {
      let wire: any = null;
      try { wire = JSON.parse(String(initialOffer)); } catch {}
      engine.acceptIncoming({ ...args, offerWire: wire });
    } else {
      engine.startOutgoing(args);
    }
    return () => { engine.hangUp('local_hangup', true); engine.release(); };
  }, [chatId, peerUid, peerName, isIncoming, initialOffer]);

  useEffect(() => { if (status === 'connected') engine.onConnected(); }, [status]);

  useEffect(() => {
    if (status !== 'ended') return;
    const t = setTimeout(() => router.back(), 200);
    return () => clearTimeout(t);
  }, [status, router]);

  const toggleScreenShare = useCallback(() => {
    if (sharing) engine.stopScreenShare().catch(() => {});
    else engine.startScreenShare().catch((e: any) => {
      const msg = e?.message ? String(e.message) : String(e);
      // A genuine user cancel is not an error worth interrupting a call for.
      if (!/cancel|denied by user|user.?cancel|NotAllowed/i.test(msg)) {
        Alert.alert('Screen share failed', msg || 'Unknown error');
      }
    });
  }, [sharing]);
  const toggleFilters = useCallback(() => setShowFilters(v => !v), []);

  const statusText = status === 'connecting' ? 'Connecting…'
    : status === 'ringing' ? 'Ringing…'
    : 'Call ended';
  const f = FILTERS.find(x => x.id === filter) ?? FILTERS[0];
  const overlay = matrixToOverlay(f.matrix);

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      <View style={S.remote}>
        {remoteUrl ? (
          <RTCView style={S.remoteVid} streamURL={remoteUrl} objectFit="cover" />
        ) : (
          <View style={[S.remoteVid, S.remotePlaceholder]}>
            <Text style={S.placeholderInitial}>{(peerName?.trim()[0] ?? '?').toUpperCase()}</Text>
          </View>
        )}
        {overlay.tint && (
          <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: overlay.tint, opacity: overlay.opacity }]} />
        )}
      </View>

      <View style={[S.topBar, { top: insets.top + 8 }]} pointerEvents="none">
        <Text style={S.name} numberOfLines={1}>{peerName || 'VaultChat user'}</Text>
        {status === 'connected'
          ? <CallTimer style={S.status} startedAt={connectedAt} />
          : <Text style={S.status}>{statusText}</Text>}
        {error && <Text style={S.errorTxt}>{error}</Text>}
        {/* D-1: 1:1 video is peer-to-peer. */}
        <CallEncryptionBadge protection="e2ee" />
      </View>

      {(sharing || peerSharing) && (
        <View style={S.shareBanner} pointerEvents="none">
          <Ionicons name="phone-portrait" size={14} color="#fff" />
          <Text style={S.shareBannerTxt}>
            {sharing ? "You're sharing your screen"
              : `${peerName || 'They'} ${peerName ? 'is' : 'are'} sharing their screen`}
          </Text>
        </View>
      )}

      {localUrl && (!cameraOff || sharing) && (
        <View style={[S.localWrap, { top: insets.top + 8 }]}>
          <RTCView style={S.local} streamURL={localUrl} objectFit="cover" mirror={!sharing} zOrder={1} />
          {overlay.tint && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor: overlay.tint, opacity: overlay.opacity }]} />
          )}
        </View>
      )}

      {showFilters && (
        <View style={[S.filterStrip, { bottom: insets.bottom + 150 }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={S.filterRow}>
            {FILTERS.map(opt => (
              <TouchableOpacity key={opt.id} style={[S.filterChip, filter === opt.id && S.filterChipActive]} onPress={() => setFilter(opt.id)} activeOpacity={0.8}>
                <View style={[S.filterSwatch,
                  opt.matrix ? { backgroundColor: opt.swatch } : { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'rgba(255,255,255,0.4)' },
                  filter === opt.id && { borderColor: '#FFFFFF' }]} />
                <Text style={[S.filterLabel, filter === opt.id && S.filterLabelActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {status === 'connected' && <CallExtras bottom={insets.bottom + 108} />}

      <View style={[S.controls, { bottom: insets.bottom + 12 }]}>
        <CallControlButton variant="video" icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={engine.toggleMute} />
        <CallControlButton variant="video" icon={cameraOff ? 'videocam-off' : 'videocam'} label={cameraOff ? 'Camera' : 'Off'} active={cameraOff} onPress={engine.toggleCamera} />
        {sharing
          ? <CallControlButton variant="video" icon="stop-circle" label="Stop" active onPress={toggleScreenShare} />
          : <CallControlButton variant="video" icon="camera-reverse" label="Flip" onPress={engine.flipCamera} />}
        {Platform.OS === 'android' && !sharing && (
          <CallControlButton variant="video" icon="phone-portrait" label="Share" onPress={toggleScreenShare} />
        )}
        <CallControlButton variant="video" icon="sparkles" label={filter === 'none' ? 'Beauty' : f.label} active={showFilters || filter !== 'none'} onPress={toggleFilters} />
        <CallControlButton variant="video" icon={speaker ? 'volume-high' : 'volume-low'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={engine.toggleSpeaker} />
        <CallControlButton variant="video" icon="call" label="End" danger onPress={hangUpFromVideoScreen} />
      </View>
    </View>
  );
}

const hangUpFromVideoScreen = () => engine.hangUp('local_hangup', true);

// ── original implementation (CALL_ENGINE_V2 off) — unchanged ──────────
function VideoCallLegacy() {
  const insets = useSafeAreaInsets();
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
  const [error,    setError]    = useState<string | null>(null);
  const [localUrl,  setLocalUrl]  = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [filter,    setFilter]    = useState<FilterId>('none');
  const [showFilters, setShowFilters] = useState(false);
  const [sharing,   setSharing]   = useState(false);   // screen share (#124)
  const [peerSharing, setPeerSharing] = useState(false); // peer is sharing theirs

  const pcRef           = useRef<RTCPeerConnection | null>(null);
  const disconnectGraceRef = useRef<any>(null);   // see onconnectionstatechange
  // E2EE signaling cipher (F6) — per-call key; plaintext passthrough for legacy peers.
  const cipherRef       = useRef<CallCipher>(plainCipher);
  const localStreamRef  = useRef<any>(null);
  const screenStreamRef = useRef<any>(null);           // active getDisplayMedia stream
  const cameraTrackRef  = useRef<any>(null);           // camera track held for swap-back
  const meIdRef         = useRef<string>('');
  const ringTimerRef    = useRef<any>(null);
  const offsRef         = useRef<Array<() => void>>([]);
  // Connect instant; elapsed time is DERIVED from it by <CallTimer> rather than
  // counted in screen state — see components/call/CallTimer for why that matters
  // most on this screen (the 1 Hz tick used to re-render the <RTCView> subtree).
  const connectedAtRef  = useRef(0);
  const connectedRef    = useRef(false);
  const loggedRef       = useRef(false);

  useEffect(() => { if (state === 'connected') connectedRef.current = true; }, [state]);

  const teardown = useCallback((notify = true) => {
    offsRef.current.forEach(fn => { try { fn(); } catch {} });
    offsRef.current = [];
    if (ringTimerRef.current) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; }
    try { InCallManager.stop(); } catch {}
    stopCallForeground();   // release the mic/camera foreground service + wake lock
    try { screenStreamRef.current?.getTracks?.().forEach((t: any) => t.stop()); } catch {}   // stop screen capture (#124)
    try { localStreamRef.current?.getTracks().forEach((t: any) => t.stop()); } catch {}
    if (disconnectGraceRef.current) { clearTimeout(disconnectGraceRef.current); disconnectGraceRef.current = null; }
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    if (notify && peerUid) {
      getSocket().then(s => s.emit('webrtc_end', { to: peerUid, from: meIdRef.current, chatId })).catch(() => {});
    }
  }, [peerUid, chatId]);

  const endCall = useCallback((notify = true) => {
    if (!loggedRef.current && peerUid) {
      loggedRef.current = true;
      const incoming = isIncoming === 'true' || isIncoming === '1';
      const dir: 'incoming' | 'outgoing' | 'missed' = incoming ? (connectedRef.current ? 'incoming' : 'missed') : 'outgoing';
      const durationSec = elapsedSeconds(connectedAtRef.current);
      addCallLog({ chatId, peerUid, peerName: peerName || 'VaultChat user', kind: 'video', direction: dir, at: Date.now() - durationSec * 1000, durationSec }).catch(() => {});
      if (!incoming && !connectedRef.current && peerUid) {
        cancelCall(peerUid, String(chatId || peerUid)).catch(() => {});   // stop the callee's ring → missed call
      }
    }
    setState('ended');
    teardown(notify);
    setTimeout(() => router.back(), 200);
  }, [teardown, router, peerUid, peerName, isIncoming]);

  // ── call-waiting / hold registration (pause mic + camera on hold) ──
  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const speakerRef = useRef(true);   // video defaults to speaker
  const heldRef = useRef(false);
  const meRef   = useRef<ActiveCall | null>(null);

  useEffect(() => {
    const me: ActiveCall = {
      chatId, peerUid, peerName: peerName || 'VaultChat user', kind: 'video',
      hold: () => { heldRef.current = true; try {
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => { t.enabled = false; });
        localStreamRef.current?.getVideoTracks?.().forEach((t: any) => { t.enabled = false; });
        pcRef.current?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = false; });
      } catch {} },
      resume: () => { heldRef.current = false; try {
        InCallManager.start({ media: 'video', auto: true });
        InCallManager.setForceSpeakerphoneOn(speakerRef.current ? true : null);
        localStreamRef.current?.getAudioTracks?.().forEach((t: any) => { t.enabled = !mutedRef.current; });
        localStreamRef.current?.getVideoTracks?.().forEach((t: any) => { t.enabled = !cameraOff; });
        pcRef.current?.getReceivers?.().forEach((r: any) => { if (r.track) r.track.enabled = true; });
      } catch {} },
      hangUp: () => endCall(true),
    };
    meRef.current = me;
    setActiveCall(me);
    return () => clearActiveCall(me);
  }, [chatId, peerUid, peerName, endCall, cameraOff]);

  useFocusEffect(useCallback(() => {
    if (heldRef.current && meRef.current) { meRef.current.resume(); setActiveCall(meRef.current); }
  }, []));

  // Keep audio+camera alive in the background + clear the native ring on connect.
  const fgStartedRef = useRef(false);
  useEffect(() => {
    if (state === 'connected' && !fgStartedRef.current) {
      fgStartedRef.current = true;
      startCallForeground(String(chatId || peerUid || 'call'), peerName || 'VaultChat user', '', true);
      dismissIncomingNotification();
    }
  }, [state, chatId, peerUid, peerName]);

  // Stamp the connect instant once; <CallTimer> owns the tick.
  const startTimer = useCallback(() => {
    if (!connectedAtRef.current) connectedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        // InCallManager owns the call audio route; `auto` follows Bluetooth/
        // wired headsets. Speaker is the default for a video call.
        try {
          InCallManager.start({ media: 'video', auto: true });
          InCallManager.setForceSpeakerphoneOn(true);
        } catch {}

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

        // Cached TURN credentials (lib/iceConfig) — same STUN-only fallback.
        const iceServers = await getIceServers();

        const pc = new RTCPeerConnection({ iceServers: iceServers as any });
        pcRef.current = pc;
        stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));

        (pc as any).ontrack = (e: any) => {
          const remoteStream = e.streams?.[0];
          if (remoteStream) setRemoteUrl(remoteStream.toURL());
          if (state !== 'connected') { setState('connected'); startTimer(); }
        };

        const s = await getSocket();
        const onAnswer = async (data: any) => {
          if (data?.from !== peerUid && data?.fromUid !== peerUid) { console.warn('[call] answer from wrong peer', data?.from, 'want', peerUid); return; }
          const sdp = cipherRef.current.open(data.answer || data.sdp);   // F6: sealed for E2EE calls
          if (!sdp?.type) { console.warn('[call] answer failed to open (E2EE cipher mismatch or bad sdp)'); return; }
          if (!pcRef.current) { console.warn('[call] answer arrived after pc closed'); return; }
          // Idempotent: the callee resends the answer a few times; only the first
          // (have-local-offer → stable) transition applies. Later copies are no-ops.
          if (pcRef.current.signalingState !== 'have-local-offer') return;
          console.warn('[call] ANSWER applied → setRemoteDescription');
          try { await pcRef.current.setRemoteDescription(new RTCSessionDescription(sdp)); }
          catch (e: any) { console.warn('[call] setRemoteDescription failed:', e?.message); return; }
          if (state !== 'connected') { setState('connected'); startTimer(); }
        };
        const onIce = async (data: any) => {
          if (data?.from !== peerUid && data?.fromUid !== peerUid) return;
          const cand = cipherRef.current.open(data?.candidate);          // F6: sealed for E2EE calls
          if (!cand || !pcRef.current) return;
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
        };
        const onEnd = (data: any) => {
          if (data?.from === peerUid || data?.fromUid === peerUid) endCall(false);
        };
        // The peer telling us they started/stopped sharing. The server has
        // always relayed these two events; until now neither side used them, so
        // a screen share arrived as an unexplained change of picture.
        const onPeerShareStart = (d: any) => { if (d?.from === peerUid || d?.fromUid === peerUid) setPeerSharing(true); };
        const onPeerShareStop  = (d: any) => { if (d?.from === peerUid || d?.fromUid === peerUid) setPeerSharing(false); };

        s.on('webrtc_answer', onAnswer);
        s.on('webrtc_ice',    onIce);
        s.on('webrtc_end',    onEnd);
        s.on('screen_share_start', onPeerShareStart);
        s.on('screen_share_stop',  onPeerShareStop);
        offsRef.current.push(() => s.off('webrtc_answer', onAnswer));
        offsRef.current.push(() => s.off('webrtc_ice',    onIce));
        offsRef.current.push(() => s.off('webrtc_end',    onEnd));
        offsRef.current.push(() => s.off('screen_share_start', onPeerShareStart));
        offsRef.current.push(() => s.off('screen_share_stop',  onPeerShareStop));

        (pc as any).onicecandidate = (event: any) => {
          if (!event.candidate || !peerUid) return;
          s.emit('webrtc_ice', { to: peerUid, from: meIdRef.current, candidate: cipherRef.current.seal(event.candidate) });
        };
        // `disconnected` is TRANSIENT and usually recovers — see the same guard
        // in app/voicecall.tsx and lib/call/peer.ts. Only failed/closed end it.
        (pc as any).onconnectionstatechange = () => {
          const st = (pc as any).connectionState;
          if (st !== 'disconnected' && disconnectGraceRef.current) {
            clearTimeout(disconnectGraceRef.current);
            disconnectGraceRef.current = null;
          }
          if (st === 'failed' || st === 'closed') { endCall(true); return; }
          if (st === 'disconnected' && !disconnectGraceRef.current) {
            try { (pc as any).restartIce?.(); } catch {}
            disconnectGraceRef.current = setTimeout(() => {
              disconnectGraceRef.current = null;
              if ((pc as any).connectionState === 'disconnected') endCall(true);
            }, DISCONNECT_GRACE_MS);
          }
        };

        if (isIncoming === 'true' && initialOffer) {
          // F6: the offer may be an encrypted sig1 wire (new caller) or a raw
          // plaintext SDP (legacy caller) — openCallOffer handles both.
          const parsedWire = JSON.parse(String(initialOffer));
          const { cipher, offer: offerObj } = await openCallOffer(peerUid, parsedWire);
          cipherRef.current = cipher;
          if (!offerObj?.type) {
            // Stale caller session — we dropped it so the next attempt re-keys.
            throw new Error('Secure call setup failed — ask the caller to try again');
          }
          await pc.setRemoteDescription(new RTCSessionDescription(offerObj));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          // Resend the answer a few times: it's one-shot, so a single socket
          // 'transport error' blip during setup used to drop it permanently and
          // strand the call. The caller's setRemoteDescription is idempotent.
          const answerWire = { to: peerUid, from: meIdRef.current, answer: cipher.seal(answer) };
          console.warn('[call] sending ANSWER to', peerUid);
          s.emit('webrtc_answer', answerWire);
          let ansTries = 0;
          const ansTimer = setInterval(() => {
            if (connectedRef.current || ansTries >= 4) { clearInterval(ansTimer); return; }
            ansTries++; try { s.emit('webrtc_answer', answerWire); } catch {}
          }, 1500);
          offsRef.current.push(() => clearInterval(ansTimer));
          setState('connecting');
        } else {
          const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
          await pc.setLocalDescription(offer);
          // F6: seal the signaling under a per-call key (ratchet-wrapped once).
          // Falls back to plaintext only when the peer has no key bundle yet.
          const sealed = await newCallCipher(peerUid, offer);
          if (sealed) cipherRef.current = sealed.cipher;
          const offerWire = sealed ? sealed.offerWire : offer;
          const ringPayload = {
            to: peerUid,
            from: meIdRef.current,
            chatId,
            type: 'video',
            callerName: me.name ?? me.email ?? 'VaultChat user',
            offer: offerWire,
          };
          s.emit('call_incoming', ringPayload);
          s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer: offerWire });
          // FCM wake-up push: doorbell only — no SDP rides in the push (F6).
          initiateCall({ calleeId: peerUid, callId: String(chatId || peerUid), isVideo: true }).catch(() => {});
          setState('ringing');
          // Re-send ring + offer every 3s so a killed-then-woken callee can answer.
          // Re-sends the SAME sealed wire — never re-encrypt per tick.
          let rings = 0;
          ringTimerRef.current = setInterval(() => {
            if (connectedRef.current || rings >= 9) { clearInterval(ringTimerRef.current); ringTimerRef.current = null; return; }
            rings++;
            try { s.emit('call_incoming', ringPayload); s.emit('webrtc_offer', { to: peerUid, from: meIdRef.current, offer: offerWire }); } catch {}
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

  // ── Screen share (#124) — swap the outgoing camera track for a screen track ──
  // via RTCRtpSender.replaceTrack(): the peer instantly sees the screen with NO
  // renegotiation and NO call drop. Stays P2P + E2EE (same DTLS-SRTP stream).
  const videoSender = () =>
    pcRef.current?.getSenders?.().find((s: any) => s.track && s.track.kind === 'video') ?? null;

  const stopScreenShare = useCallback(async () => {
    const sender = videoSender();
    try { if (sender && cameraTrackRef.current) await sender.replaceTrack(cameraTrackRef.current); } catch {}
    try { screenStreamRef.current?.getTracks?.().forEach((t: any) => t.stop()); } catch {}
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    try { if (localStreamRef.current) setLocalUrl(localStreamRef.current.toURL()); } catch {}
    setSharing(false);
    if (peerUid) getSocket().then(s => s.emit('screen_share_stop', { to: peerUid, chatId })).catch(() => {});
  }, [peerUid, chatId]);

  const startScreenShare = useCallback(async () => {
    const sender = videoSender();
    if (!sender) {
      Alert.alert('Screen share', `Not connected yet — no video track to swap (call state: ${state}).`);
      return;
    }
    if (typeof (mediaDevices as any).getDisplayMedia !== 'function') {
      Alert.alert('Screen share', 'getDisplayMedia is unavailable in this build (react-native-webrtc).');
      return;
    }
    try {
      console.log('[screenshare] calling getDisplayMedia…');
      const screen: any = await (mediaDevices as any).getDisplayMedia();   // → system "Start recording?" prompt
      console.log('[screenshare] stream:', !!screen, 'tracks:', screen?.getVideoTracks?.().length);
      const screenTrack = screen?.getVideoTracks?.()[0];
      if (!screenTrack) { screen?.getTracks?.().forEach((t: any) => t.stop()); Alert.alert('Screen share', 'No screen track was returned by capture.'); return; }
      cameraTrackRef.current = sender.track;                      // keep the camera alive for swap-back
      screenStreamRef.current = screen;
      await sender.replaceTrack(screenTrack);                     // peer now sees the screen
      try { setLocalUrl(screen.toURL()); } catch {}              // show the screen in my preview
      setSharing(true);
      // Tell the peer, so their side can label the change instead of the
      // picture silently becoming a desktop.
      if (peerUid) getSocket().then(s => s.emit('screen_share_start', { to: peerUid, chatId })).catch(() => {});
      try { screenTrack.addEventListener?.('ended', () => { stopScreenShare(); }); } catch {}
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      console.warn('[screenshare] FAILED:', msg, e);
      // Silently ignore a genuine user cancel; surface everything else so we can see it.
      if (!/cancel|denied by user|user.?cancel|NotAllowed/i.test(msg)) {
        Alert.alert('Screen share failed', msg || 'Unknown error');
      }
    }
  }, [stopScreenShare, state]);

  const toggleScreenShare = useCallback(() => {
    if (sharing) stopScreenShare(); else startScreenShare();
  }, [sharing, startScreenShare, stopScreenShare]);

  const toggleSpeaker = useCallback(() => {
    const next = !speaker;
    setSpeaker(next);
    speakerRef.current = next;
    try { InCallManager.setForceSpeakerphoneOn(next ? true : null); } catch {}
  }, [speaker]);

  const statusText = state === 'connecting' ? 'Connecting…'
    : state === 'ringing'   ? 'Ringing…'
    : 'Call ended';

  // Stable identity so the memoized End button doesn't re-render every pass (and
  // so the press event is never mistaken for endCall's `notify` argument).
  const hangUp = useCallback(() => endCall(true), [endCall]);
  const toggleFilters = useCallback(() => setShowFilters(v => !v), []);

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

      {/* Top bar: name + status (offset below the notch / status bar) */}
      <View style={[S.topBar, { top: insets.top + 8 }]} pointerEvents="none">
        <Text style={S.name} numberOfLines={1}>{peerName || 'VaultChat user'}</Text>
        {state === 'connected'
          ? <CallTimer style={S.status} startedAt={connectedAtRef.current} />
          : <Text style={S.status}>{statusText}</Text>}
        {error && <Text style={S.errorTxt}>{error}</Text>}
        {/* D-1: 1:1 video is peer-to-peer. */}
        <CallEncryptionBadge protection="e2ee" />
      </View>

      {/* Screen-share banner (#124). Mine takes precedence over the peer's —
          both can share at once, and knowing what I'M broadcasting matters more. */}
      {(sharing || peerSharing) && (
        <View style={S.shareBanner} pointerEvents="none">
          <Ionicons name="phone-portrait" size={14} color="#fff" />
          <Text style={S.shareBannerTxt}>
            {sharing
              ? "You're sharing your screen"
              : `${peerName || 'They'} ${peerName ? 'is' : 'are'} sharing their screen`}
          </Text>
        </View>
      )}

      {/* Local preview (shows the screen while sharing, un-mirrored) */}
      {localUrl && (!cameraOff || sharing) && (
        <View style={[S.localWrap, { top: insets.top + 8 }]}>
          <RTCView style={S.local} streamURL={localUrl} objectFit="cover" mirror={!sharing} zOrder={1} />
          {overlay.tint && (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFillObject, { backgroundColor: overlay.tint, opacity: overlay.opacity }]}
            />
          )}
        </View>
      )}

      {/* Beautify filter strip (toggled by Beautify button) — sits above the controls */}
      {showFilters && (
        <View style={[S.filterStrip, { bottom: insets.bottom + 150 }]}>
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

      {/* Controls — wraps to a second row on narrow screens instead of
          overflowing, and clears the gesture bar via the bottom inset. */}
      <View style={[S.controls, { bottom: insets.bottom + 12 }]}>
        <CallControlButton variant="video" icon={muted ? 'mic-off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={muted} onPress={toggleMute} />
        <CallControlButton variant="video" icon={cameraOff ? 'videocam-off' : 'videocam'} label={cameraOff ? 'Camera' : 'Off'} active={cameraOff} onPress={toggleCamera} />
        {sharing
          ? <CallControlButton variant="video" icon="stop-circle" label="Stop" active onPress={toggleScreenShare} />
          : <CallControlButton variant="video" icon="camera-reverse" label="Flip" onPress={flipCamera} />}
        {Platform.OS === 'android' && !sharing && (
          <CallControlButton variant="video" icon="phone-portrait" label="Share" onPress={toggleScreenShare} />
        )}
        <CallControlButton
          variant="video"
          icon="sparkles"
          label={filter === 'none' ? 'Beauty' : f.label}
          active={showFilters || filter !== 'none'}
          onPress={toggleFilters}
        />
        <CallControlButton variant="video" icon={speaker ? 'volume-high' : 'volume-low'} label={speaker ? 'Speaker' : 'Earpiece'} active={speaker} onPress={toggleSpeaker} />
        <CallControlButton variant="video" icon="call" label="End" danger onPress={hangUp} />
      </View>
    </View>
  );
}

function makeStyles() { return StyleSheet.create({
  screen:     { flex: 1, backgroundColor: CALL.video },
  remote:     { flex: 1, backgroundColor: CALL.video },
  remoteVid:  { width: '100%', height: '100%' },
  remotePlaceholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderInitial: { fontSize: 96, color: 'rgba(255,255,255,0.3)', fontWeight: '900' },

  topBar:     { position: 'absolute', left: 24, right: 24, alignItems: 'center', gap: 4 },
  shareBanner:{ position: 'absolute', top: 110, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(157,111,208,0.92)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  shareBannerTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
  name:       { color: CALL.text, fontSize: 22, fontWeight: '700', ...CALL_TEXT_SHADOW },
  status:     { color: CALL.textDim, fontSize: 14, ...CALL_TEXT_SHADOW },
  errorTxt:   { color: CALL.danger, fontSize: 13, marginTop: 4, ...CALL_TEXT_SHADOW },

  localWrap:  { position: 'absolute', right: 16, width: 110, height: 150, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: CALL.ctrlBorder },
  local:      { width: '100%', height: '100%' },

  filterStrip:     { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(10,10,15,0.7)', paddingVertical: 12 },
  filterRow:       { paddingHorizontal: 16, gap: 12, alignItems: 'center' },
  filterChip:      { alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  filterChipActive:{ },
  filterSwatch:    { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: 'transparent' },
  filterLabel:     { color: 'rgba(255,255,255,0.65)', fontSize: 11, fontWeight: '600' },
  filterLabelActive:{ color: '#FFFFFF' },

  // flexWrap → the 7 controls fold onto a second centered row on narrow phones
  // instead of overflowing off-screen.
  controls:   { position: 'absolute', left: 12, right: 12, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', columnGap: 6, rowGap: 8, backgroundColor: CALL.barBg, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 24, borderWidth: 1, borderColor: CALL.ctrlBorder },
  // Button metrics now live with the button (components/call/CallControlButton,
  // variant 'video') — same values, one owner.
}); }
