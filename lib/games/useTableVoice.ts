// lib/games/useTableVoice.ts — talking at the table.
//
// WHY THIS WAS REWRITTEN
// ----------------------
// It used to mint a LiveKit token from `POST /api/voice/token` on the games
// server and join an SFU room. That endpoint does not exist — it answers 404 —
// and the deployment's own `/config.js` reports:
//
//     window.GAMES_CONFIG = { "sfu": false, "sfuMinSeats": 4, "iceServers": [...] }
//
// so even where the endpoint exists the SFU is switched off. The old code
// treated that as "voice is unavailable, say so and stop", which is exactly what
// every player saw: voice never connected in ANY of the four games.
//
// What the deployed web client actually does (games-web/vgvoice.js) is run a
// PEER-TO-PEER AUDIO MESH, signalled over the game's own WebSocket, with the
// games server relaying `voice-*` frames to the named peer. That is what this
// now does. The protocol and the decisions it turns on live in
// lib/games/voiceMesh.ts, which is checked by voiceMesh.selftest.ts.
//
// WHAT THE MESH MEANS
// -------------------
// Audio is end-to-end between the players (DTLS-SRTP) and never lands on the
// games server, which only ever sees the signalling envelope. That is a better
// privacy story than the SFU it replaces — but it is O(n²) connections, so a
// six-handed table is five uploads. The reference client switches to an SFU
// above four seats; this deployment has none to switch to, and saying so is
// better than pretending.
//
// Membership is enforced by the SERVER: it relays a `voice-*` frame only to a
// peer at the same table, and this client refuses to mesh with an id that is not
// in the roster the table published. A stranger cannot dial in.
//
// The microphone is only ever requested when the player taps Join, nothing is
// recorded, and leaving voice does not leave the table.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { AudioSession, registerGlobals } from '@livekit/react-native';
import type { GameKind } from '../gamesSocket';
// Reused, not re-derived. These wrap InCallManager with the null-vs-false rule
// that Go Live and calling both learned the hard way: "speaker off" must RELEASE
// the route so a Bluetooth headset is followed, never pin the earpiece.
import { startBroadcastAudio, stopBroadcastAudio, setBroadcastSpeaker } from '../golive/audio';
import {
  rosterFrom, diffRoster, shouldInitiate, IceQueue, audioLevelFrom, SPEAKING_LEVEL,
  type Roster, type PeerState,
} from './voiceMesh';

// Lazy-require so a build without the native module (or a Node-run check that
// pulls this file in) degrades to "voice unavailable" instead of failing to
// load. Same pattern as lib/vaultBeamDirect.ts.
let RTC: any = null;
// eslint-disable-next-line @typescript-eslint/no-require-imports
try { RTC = require('@livekit/react-native-webrtc'); } catch { RTC = null; }

/** Falls back to public STUN, which is what the deployment currently serves. */
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const GAMES_HTTP = 'https://games.corefinite.com';

/**
 * Install LiveKit's WebRTC globals, but only if nobody already has.
 *
 * registerGlobals() puts RTCPeerConnection and MediaStream on globalThis, and
 * running it a SECOND time replaces those constructors underneath an SDK that
 * is already using them — which is a real bug this app has hit before. Calling
 * and Go Live each guard it with their own module-local flag, so a flag of our
 * own could not see that one of them had already registered.
 */
function ensureGlobals(): void {
  const g = globalThis as any;
  if (typeof g.RTCPeerConnection !== 'undefined' && typeof g.MediaStream !== 'undefined') return;
  registerGlobals();
}

export type VoicePhase =
  | 'off' | 'asking' | 'connecting' | 'live'
  /**
   * In voice, with nobody else connected — either the first to join, or the
   * last one standing after the others dropped. Not an error: a table of one
   * is a normal thing to be sitting in while you wait.
   */
  | 'waiting'
  | 'unavailable' | 'error';

export interface TableVoice {
  phase: VoicePhase;
  error: string | null;
  /** False when the table seated you as a spectator: listen-only. */
  canSpeak: boolean;
  muted: boolean;
  /** Identities currently talking, for the seat rings. */
  speaking: Set<string>;
  /** Everyone in the audio mesh, including us. */
  participants: string[];
  /** What each peer last told us about their own mic and speaker. */
  peerState: Record<string, PeerState>;
  /** True when the loudspeaker is forced on. Off means "follow the headset". */
  speaker: boolean;
  /** Epoch ms voice went live, for a duration. Null when off. */
  since: number | null;
  join: () => void;
  leave: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
}

/**
 * The game socket, which is also the signalling channel.
 *
 * `subscribe` must survive a socket rebuild — see useGameSocket. A mesh that
 * quietly stopped receiving offers after one reconnect would present as a
 * microphone fault, which is the hardest kind of bug to chase.
 */
export interface VoiceWire {
  you: string;
  send: (msg: any) => void;
  subscribe: (handler: (msg: any) => void) => () => void;
}

interface Peer {
  pc: any;
  ice: IceQueue;
  /** Held so the track can be re-enabled; RN plays remote audio automatically. */
  stream: any | null;
}

const NO_SPEAKING: Set<string> = new Set();

export function useTableVoice(game: GameKind, roomId: string, wire: VoiceWire): TableVoice {
  const [phase, setPhase] = useState<VoicePhase>('off');
  const [error, setError] = useState<string | null>(null);
  const [canSpeak, setCanSpeak] = useState(true);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(NO_SPEAKING);
  const [inVoiceIds, setInVoiceIds] = useState<string[]>([]);
  const [peerState, setPeerState] = useState<Record<string, PeerState>>({});

  // Mesh state that must NOT drive rendering. A peer connection changing does
  // not mean the panel changed, and re-rendering the table on every ICE
  // candidate would be felt during play.
  const peers = useRef<Map<string, Peer>>(new Map());
  const roster = useRef<Roster>({});
  const inVoice = useRef<Set<string>>(new Set());
  const localStream = useRef<any>(null);
  const joined = useRef(false);
  const alive = useRef(true);
  const iceServers = useRef<any[]>(DEFAULT_ICE);

  // Latest-ref: the socket's send/you change identity as the screen re-renders,
  // and the signalling handlers must not be rebuilt (and re-subscribed) for it.
  const wireRef = useRef(wire);
  wireRef.current = wire;

  const send = useCallback((msg: any) => { wireRef.current.send(msg); }, []);
  const meId = wire.you;

  /* ── ICE servers ─────────────────────────────────────────────────── */
  //
  // The server publishes them at /config.js, TURN included where one is
  // configured. Fetched once, best-effort: public STUN is a working fallback
  // for everything except symmetric NAT, and failing to fetch must not stop a
  // player from talking.
  useEffect(() => {
    let ok = true;
    fetch(`${GAMES_HTTP}/config.js`)
      .then(r => r.text())
      .then(txt => {
        const m = txt.match(/window\.GAMES_CONFIG\s*=\s*(\{[\s\S]*?\});?\s*$/);
        if (!m || !ok) return;
        const cfg = JSON.parse(m[1]);
        if (Array.isArray(cfg?.iceServers) && cfg.iceServers.length) iceServers.current = cfg.iceServers;
      })
      .catch(() => {});
    return () => { ok = false; };
  }, []);

  /* ── tearing down ────────────────────────────────────────────────── */

  const dropPeer = useCallback((id: string) => {
    const p = peers.current.get(id);
    if (!p) return;
    p.ice.reset();
    try { p.pc.close(); } catch {}
    peers.current.delete(id);
    setInVoiceIds(prev => prev.filter(x => x !== id));
  }, []);

  const releaseMic = useCallback(() => {
    const s = localStream.current;
    localStream.current = null;
    if (!s) return;
    try { s.getTracks().forEach((t: any) => t.stop()); } catch {}
  }, []);

  const teardown = useCallback(() => {
    joined.current = false;
    peers.current.forEach((_p, id) => dropPeer(id));
    peers.current.clear();
    inVoice.current.clear();
    releaseMic();
    // Release the audio session and the route, or the phone stays in
    // communication mode after the table is closed — which on Android ducks and
    // reroutes every other app's audio as though a call were still up.
    void AudioSession.stopAudioSession().catch(() => {});
    stopBroadcastAudio();
  }, [dropPeer, releaseMic]);

  // A live microphone must not outlive the table.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; teardown(); };
  }, [teardown]);

  const leave = useCallback(() => {
    // Tell the table before dropping the connections, or peers keep a dead
    // avatar on screen until their own ICE times out.
    if (joined.current) {
      Object.keys(roster.current).forEach(id => send({ t: 'voice-bye', to: id, data: {} }));
    }
    teardown();
    if (!alive.current) return;
    setPhase('off');
    setSpeaking(NO_SPEAKING);
    setInVoiceIds([]);
    setPeerState({});
    setSince(null);
    setMuted(false);
    setError(null);
  }, [send, teardown]);

  /* ── the mesh ────────────────────────────────────────────────────── */

  const broadcastState = useCallback((toId?: string, micOn?: boolean) => {
    const data = { mic: micOn ?? !muted, spk: true };
    if (toId) { send({ t: 'voice-state', to: toId, data }); return; }
    Object.keys(roster.current).forEach(id => send({ t: 'voice-state', to: id, data }));
  }, [muted, send]);

  const connect = useCallback((id: string, initiator: boolean) => {
    if (!RTC || !localStream.current || peers.current.has(id)) return;

    const pc = new RTC.RTCPeerConnection({ iceServers: iceServers.current });
    const peer: Peer = { pc, ice: new IceQueue(), stream: null };
    peers.current.set(id, peer);

    try {
      localStream.current.getTracks().forEach((t: any) => pc.addTrack(t, localStream.current));
    } catch {
      // addTrack can throw if the stream ended between join and here.
      dropPeer(id);
      return;
    }

    pc.onicecandidate = (e: any) => {
      if (e?.candidate) send({ t: 'voice-ice', to: id, data: e.candidate });
    };
    // React Native plays remote audio automatically once the track lands —
    // there is no <audio> sink to create, which is the one place this differs
    // from the reference web client.
    pc.ontrack = (e: any) => {
      peer.stream = e?.streams?.[0] ?? null;
      if (!alive.current) return;
      setInVoiceIds(prev => (prev.includes(id) ? prev : [...prev, id]));
      setPhase('live');
    };
    pc.onconnectionstatechange = () => {
      if (!alive.current) return;
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') {
        dropPeer(id);
        // Still in voice with nobody connected — waiting, not broken.
        if (joined.current && peers.current.size === 0) setPhase('waiting');
      }
    };

    if (initiator) {
      void (async () => {
        try {
          const offer = await pc.createOffer({});
          await pc.setLocalDescription(offer);
          send({ t: 'voice-offer', to: id, data: pc.localDescription });
        } catch {
          dropPeer(id);
        }
      })();
    }
  }, [dropPeer, send]);

  /** Dial a peer once we know both of us are in voice and it is our turn to. */
  const attemptConnect = useCallback((id: string) => {
    if (!joined.current || !inVoice.current.has(id) || peers.current.has(id)) return;
    if (shouldInitiate(wireRef.current.you, id)) connect(id, true);
    // else: they dial us. See shouldInitiate — both dialling is glare.
  }, [connect]);

  /* ── signalling ──────────────────────────────────────────────────── */
  //
  // One subscription for the life of the screen. Everything it touches is a ref,
  // so this never needs rebuilding and can never miss a frame mid-rebuild.

  useEffect(() => {
    const off = wireRef.current.subscribe((m: any) => {
      if (!m?.t || !alive.current) return;
      const me = wireRef.current.you;

      // Roster first: a peer must be AT THE TABLE before we will mesh with it.
      const next = rosterFrom(m, me);
      if (next) {
        const { added, gone } = diffRoster(roster.current, next);
        roster.current = next;
        gone.forEach(id => {
          inVoice.current.delete(id);
          dropPeer(id);
          setPeerState(prev => { const c = { ...prev }; delete c[id]; return c; });
        });
        // Greet anyone new so the mesh forms regardless of who arrived first.
        if (joined.current) added.forEach(id => send({ t: 'voice-hello', to: id, data: {} }));
      }
      // The table's own view of whether we may speak. Spectators are listen-only.
      if (m.t === 'state' && typeof m.spectator === 'boolean') setCanSpeak(!m.spectator);

      const from: string | undefined = typeof m.from === 'string' ? m.from : undefined;
      if (!from) return;

      if (m.t === 'voice-bye') {
        inVoice.current.delete(from);
        dropPeer(from);
        setPeerState(prev => { const c = { ...prev }; delete c[from]; return c; });
        return;
      }

      if (m.t === 'voice-hello') {
        if (!roster.current[from]) return;      // not at this table: ignore
        inVoice.current.add(from);
        if (!joined.current) return;
        // Answer an unacknowledged hello so they learn we are here too.
        if (!m.data?.ack) send({ t: 'voice-hello', to: from, data: { ack: true } });
        attemptConnect(from);
        broadcastState(from);
        return;
      }

      if (m.t === 'voice-state') {
        if (!m.data) return;
        setPeerState(prev => ({ ...prev, [from]: { mic: m.data.mic !== false, spk: m.data.spk !== false } }));
        return;
      }

      if (m.t !== 'voice-offer' && m.t !== 'voice-answer' && m.t !== 'voice-ice') return;
      if (!joined.current || !roster.current[from]) return;   // only mesh with the table

      void (async () => {
        try {
          if (m.t === 'voice-offer') {
            if (!peers.current.has(from)) connect(from, false);
            const p = peers.current.get(from);
            if (!p) return;
            await p.pc.setRemoteDescription(new RTC.RTCSessionDescription(m.data));
            for (const c of p.ice.flush()) {
              try { await p.pc.addIceCandidate(new RTC.RTCIceCandidate(c)); } catch {}
            }
            const answer = await p.pc.createAnswer();
            await p.pc.setLocalDescription(answer);
            send({ t: 'voice-answer', to: from, data: p.pc.localDescription });
            return;
          }

          const p = peers.current.get(from);
          if (!p) return;

          if (m.t === 'voice-answer') {
            await p.pc.setRemoteDescription(new RTC.RTCSessionDescription(m.data));
            for (const c of p.ice.flush()) {
              try { await p.pc.addIceCandidate(new RTC.RTCIceCandidate(c)); } catch {}
            }
            return;
          }

          // voice-ice. Held until there IS a remote description — see IceQueue.
          if (p.ice.accept(m.data)) {
            try { await p.pc.addIceCandidate(new RTC.RTCIceCandidate(m.data)); } catch {}
          }
        } catch {
          // A failed negotiation drops that ONE peer. Voice failing must never
          // stop the game, and one bad peer must not take the table's audio out.
          dropPeer(from);
        }
      })();
    });
    return off;
  }, [attemptConnect, broadcastState, connect, dropPeer, send]);

  /* ── joining ─────────────────────────────────────────────────────── */

  const join = useCallback(() => {
    if (joined.current) return;
    if (!RTC) { setPhase('unavailable'); setError('Voice is not available in this build.'); return; }
    if (!roomId) { setPhase('error'); setError('This table has no voice channel.'); return; }

    setError(null);
    void (async () => {
      try {
        // The microphone is requested ONLY here — when the player asks to talk.
        if (Platform.OS === 'android') {
          if (alive.current) setPhase('asking');
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: 'Talk at the table',
              message: 'VaultChat needs your microphone so the other players can hear you.',
              buttonPositive: 'Allow',
            },
          );
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            if (alive.current) { setPhase('error'); setError('Microphone permission denied.'); }
            return;
          }
        }
        if (!alive.current) return;
        setPhase('connecting');

        ensureGlobals();
        await AudioSession.startAudioSession();
        // startAudioSession alone leaves the ROUTE unmanaged, so a player
        // wearing earbuds would be heard through the phone's own mic and hear
        // nothing through the buds. `auto: true` follows the headset; the
        // speaker is NOT forced here, because forcing it is precisely what
        // would silence those earbuds (see lib/golive/audio.ts).
        startBroadcastAudio();

        const stream = await RTC.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        if (!alive.current) { try { stream.getTracks().forEach((t: any) => t.stop()); } catch {} return; }

        localStream.current = stream;
        joined.current = true;

        // A spectator joins to LISTEN. The SFU used to enforce that server-side;
        // a mesh has no such gate, so it is enforced here by starting the track
        // disabled — and toggleMute already refuses to lift it for someone who
        // may not speak, so there is no path back to a live microphone.
        const startMuted = !canSpeak;
        if (startMuted) {
          try { stream.getAudioTracks().forEach((t: any) => { t.enabled = false; }); } catch {}
        }
        setMuted(startMuted);
        setSpeaker(false);
        setSince(Date.now());

        // Announce, then dial whoever was already in voice. Greeting everyone
        // (not only those known to be in voice) is what makes join order
        // irrelevant — the reference client does the same.
        Object.keys(roster.current).forEach(id => send({ t: 'voice-hello', to: id, data: {} }));
        inVoice.current.forEach(id => attemptConnect(id));
        broadcastState(undefined, !startMuted);

        // Alone in voice is a valid state, not a failure.
        setPhase(peers.current.size > 0 ? 'live' : 'waiting');
      } catch (err: unknown) {
        if (!alive.current) return;
        teardown();
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [attemptConnect, broadcastState, canSpeak, roomId, send, teardown]);

  /* ── mute ────────────────────────────────────────────────────────── */

  /**
   * Muting DISABLES the track rather than tearing the mesh down.
   *
   * The reference client releases the microphone entirely (replaceTrack(null))
   * so a Bluetooth headset can leave the hands-free profile. That is the right
   * instinct, but on React Native re-acquiring costs a renegotiation with every
   * peer, and a six-handed table would blip five connections on every mute tap.
   * `enabled = false` stops the audio at the source — nothing is transmitted —
   * and the state is broadcast so everyone can SEE the mute.
   *
   * ponytail: track.enabled, not replaceTrack(null). Revisit if Bluetooth
   * profile switching turns out to matter more than mute latency at the table.
   */
  const toggleMute = useCallback(() => {
    const s = localStream.current;
    if (!s || !canSpeak) return;
    const next = !muted;
    setMuted(next);
    try { s.getAudioTracks().forEach((t: any) => { t.enabled = !next; }); } catch {}
    broadcastState(undefined, !next);
  }, [muted, canSpeak, broadcastState]);

  const toggleSpeaker = useCallback(() => {
    setSpeaker(prev => {
      const next = !prev;
      // `false` RELEASES the force so the route follows a connected headset —
      // it does not pin the earpiece. See lib/golive/audio.ts.
      setBroadcastSpeaker(next);
      return next;
    });
  }, []);

  /* ── who is talking ──────────────────────────────────────────────── */
  //
  // Polled from getStats rather than WebAudio: react-native-webrtc has no
  // AnalyserNode. Each peer has its own connection, so its inbound level is
  // unambiguous. A platform that reports no `audioLevel` shows no rings at all,
  // because a ring on the wrong player is worse than no ring.

  useEffect(() => {
    if (phase !== 'live' && phase !== 'waiting') return;
    let stop = false;

    const tick = async () => {
      const talking = new Set<string>();
      let reported = false;

      for (const [id, p] of peers.current) {
        try {
          const stats = await p.pc.getStats();
          const level = audioLevelFrom(stats.values ? stats.values() : (stats as any), 'inbound-rtp');
          if (level != null) { reported = true; if (level > SPEAKING_LEVEL) talking.add(id); }
        } catch {}
      }
      // Our own microphone, from any one connection.
      const first = peers.current.values().next().value as Peer | undefined;
      if (first && !muted) {
        try {
          const stats = await first.pc.getStats();
          const mine = audioLevelFrom(stats.values ? stats.values() : (stats as any), 'media-source');
          if (mine != null) { reported = true; if (mine > SPEAKING_LEVEL) talking.add(wireRef.current.you); }
        } catch {}
      }

      if (stop || !alive.current) return;
      setSpeaking(prev => {
        if (!reported) return prev.size ? NO_SPEAKING : prev;
        if (prev.size === talking.size && [...talking].every(x => prev.has(x))) return prev;
        return talking;
      });
    };

    const timer = setInterval(() => { void tick(); }, 450);
    return () => { stop = true; clearInterval(timer); };
  }, [phase, muted]);

  /* ── leaving the table ───────────────────────────────────────────── */
  //
  // A different table is a different voice channel. Staying connected would
  // keep publishing into a room the player has walked away from.
  const lastRoom = useRef(roomId);
  useEffect(() => {
    if (lastRoom.current === roomId) return;
    lastRoom.current = roomId;
    roster.current = {};
    leave();
  }, [roomId, leave]);

  // Driven by `phase`, not by the `joined` ref: a ref does not re-render, so a
  // list keyed off it would show yesterday's participants.
  const inVoiceNow = phase === 'live' || phase === 'waiting';
  const participants = useMemo(
    () => (inVoiceNow ? [meId, ...inVoiceIds].filter(Boolean) : []),
    [inVoiceNow, inVoiceIds, meId],
  );

  return {
    phase, error, canSpeak, muted, speaking, participants, peerState, speaker, since,
    join, leave, toggleMute, toggleSpeaker,
  };
}
