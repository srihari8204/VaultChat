// lib/games/useTableVoice.ts — talking at the table.
//
// WHY THIS IS A LIVEKIT ROOM AND NOT A PEER MESH
// ----------------------------------------------
// This file has now been written three times, and the history is the argument.
//
//  1. It minted a token from `POST /api/voice/token` ON THE GAMES SERVER and
//     joined an SFU. That endpoint answers 404, and the deployment's own
//     /config.js reports `{"sfu": false, "sfuMinSeats": 4}` — there is no SFU
//     there to join. Voice was dead in all four games.
//  2. So it was rewritten as the peer-to-peer mesh the shipped web client
//     actually runs (games-web/vgvoice.js), signalled over the game's own
//     WebSocket. That is a faithful port and it is the right shape for two or
//     three people — but it is O(n^2) connections, and a six-handed rummy table
//     is FIVE simultaneous uploads of your microphone from a phone that is also
//     animating thirteen cards. The reference client's own answer to that is to
//     switch to an SFU above four seats; that deployment has none to switch to.
//  3. VaultChat has one. The same LiveKit cluster already carries calls and Go
//     Live, and `livekit.Mint` already signs join tokens. So a table's audio now
//     costs each phone one upload and one download, whatever the table's size,
//     and it reuses plumbing that is already in production rather than a second
//     WebRTC stack maintained beside it.
//
// The room is minted by OUR backend (`POST /games/voice-token`, games_voice.go),
// never by the games server, which knows nothing about any of this.
//
// WHAT WE GAVE UP, SAID PLAINLY
// -----------------------------
// The mesh had two properties this does not, and pretending otherwise would be
// the kind of comment that gets someone in trouble later:
//
//   - Audio was end-to-end between players (DTLS-SRTP) and never landed on a
//     server. It now passes through VaultChat's SFU, exactly as a group call
//     does. There is no frame encryption on a table room (`e2eeKey: null`) —
//     players at a public rummy table have no ratchet sessions with each other,
//     so there is no key to agree on.
//   - Membership was enforced by the one party that knows the seating: the games
//     server relayed a `voice-*` frame only between peers at the same table. Our
//     backend cannot ask it who is seated, so the token route's real rule is
//     "a signed-in VaultChat user who knows this table's room id". See the long
//     note in games_voice.go.
//
// What we gained, besides the bandwidth: the SFU enforces listen-only for a
// spectator (the `audience` role) instead of asking the client to please keep
// its own microphone track disabled, and reconnection is livekit-client's
// problem rather than a mesh that had to re-dial five peers by hand.
//
// The microphone is only ever opened when the player taps Join, nothing is
// recorded, and leaving voice does not leave the table.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { RoomEvent } from 'livekit-client';
import type { GameKind } from '../gamesSocket';
import { api } from '../api';
// Reused, not re-derived. These wrap InCallManager with the null-vs-false rule
// that Go Live and calling both learned the hard way: "speaker off" must RELEASE
// the route so a Bluetooth headset is followed, never pin the earpiece.
import { startBroadcastAudio, stopBroadcastAudio, setBroadcastSpeaker } from '../golive/audio';
import { joinSfuRoom, type SfuSession } from '../golive/room';

export type VoicePhase =
  | 'off' | 'asking' | 'connecting' | 'live'
  /**
   * In voice, with nobody else connected — either the first to join, or the
   * last one standing after the others dropped. Not an error: a table of one
   * is a normal thing to be sitting in while you wait.
   */
  | 'waiting'
  | 'unavailable' | 'error';

/** What a peer's published state says about their own microphone. */
export interface PeerState { mic: boolean; spk: boolean }

export interface TableVoice {
  phase: VoicePhase;
  error: string | null;
  /** False when the table seated you as a spectator: listen-only. */
  canSpeak: boolean;
  muted: boolean;
  /** Identities currently talking, for the seat rings. */
  speaking: Set<string>;
  /** Everyone in the audio room, including us. */
  participants: string[];
  /** What each peer's published state says about their microphone. */
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
 * The game socket.
 *
 * Still needed, though signalling has moved to LiveKit: it is where we learn
 * that the table seated us as a SPECTATOR, which decides whether we ask for a
 * token that may publish. `send` is no longer used for voice — the games server
 * has nothing left to relay — and is kept because both boards already pass it
 * and a narrower type would be a change at two call sites for no gain.
 */
export interface VoiceWire {
  you: string;
  send: (msg: any) => void;
  subscribe: (handler: (msg: any) => void) => () => void;
}

const NO_SPEAKING: Set<string> = new Set();

interface VoiceToken {
  token: string;
  url: string;
  room: string;
  identity: string;
  role: string;
}

export function useTableVoice(game: GameKind, roomId: string, wire: VoiceWire): TableVoice {
  const [phase, setPhase] = useState<VoicePhase>('off');
  const [error, setError] = useState<string | null>(null);
  const [canSpeak, setCanSpeak] = useState(true);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [since, setSince] = useState<number | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [speaking, setSpeaking] = useState<Set<string>>(NO_SPEAKING);
  const [peerState, setPeerState] = useState<Record<string, PeerState>>({});

  const session = useRef<SfuSession | null>(null);
  const joined = useRef(false);
  /** Guards a second Join while the first is still connecting. */
  const connecting = useRef(false);
  const alive = useRef(true);

  // Both boards build the wire inline, so it is a new object every render and
  // is read through a ref. A dependency on it would re-subscribe every frame.
  const wireRef = useRef(wire);
  wireRef.current = wire;

  /**
   * Player or spectator?
   *
   * `state.spectator` is the games protocol's own flag (docs/GAMES_PROTOCOL.md).
   * It decides which ROLE we ask the backend for, and therefore whether the SFU
   * will accept a microphone track from us at all — so it has to be settled
   * before we mint, which is why it is tracked continuously rather than read
   * once at Join.
   */
  useEffect(() => {
    const off = wireRef.current.subscribe((m: any) => {
      if (!alive.current) return;
      if (m && m.t === 'state' && typeof m.spectator === 'boolean') setCanSpeak(!m.spectator);
    });
    return off;
  }, []);

  /**
   * Copy the room into React state.
   *
   * ONE FUNCTION FOR EVERY EVENT, deliberately. Someone joined, someone left, a
   * track muted, we reconnected — each changes some subset of the same three
   * things, and a bespoke handler per event is how a UI ends up disagreeing
   * with the room it is rendering. The SDK is the source of truth and this
   * copies it wholesale; the events only say WHEN to look.
   */
  const sync = useCallback(() => {
    const s = session.current;
    if (!s || !alive.current) return;
    const room = s.room;
    const remotes = [...room.remoteParticipants.values()];
    const me = room.localParticipant;

    setParticipants([me.identity, ...remotes.map(p => p.identity)].filter(Boolean));
    setPeerState(() => {
      const next: Record<string, PeerState> = {};
      for (const p of remotes) {
        // `spk` has no equivalent on the SFU. The mesh carried a peer's own "I
        // have deafened myself" flag; LiveKit has no such notion. Reported as
        // true rather than guessed — nothing renders it, and inventing a "they
        // cannot hear you" warning out of no evidence is worse than silence.
        next[p.identity] = { mic: p.isMicrophoneEnabled, spk: true };
      }
      return next;
    });
    setMuted(!me.isMicrophoneEnabled);
    setPhase(remotes.length > 0 ? 'live' : 'waiting');
  }, []);

  /** Leave the room and hand the audio route back. */
  const teardown = useCallback(async () => {
    const s = session.current;
    session.current = null;
    // GUARDED ON `joined`. teardown also runs on unmount, and unconditionally
    // stopping the audio session there handed back a route we had never taken —
    // which, with a VaultChat call or a Go Live broadcast running, cut THAT.
    const wasJoined = joined.current;
    joined.current = false;
    connecting.current = false;
    if (s) { try { await s.leave(); } catch { /* already gone */ } }
    if (wasJoined) { try { stopBroadcastAudio(); } catch {} }
    if (alive.current) {
      setPhase('off');
      setSince(null);
      setParticipants([]);
      setSpeaking(NO_SPEAKING);
      setPeerState({});
      setSpeaker(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; void teardown(); };
  }, [teardown]);

  // Changing table leaves the old table's room. The room name is derived from
  // the table id, so staying in the previous one would be talking to the people
  // we just got up from.
  useEffect(() => { void teardown(); }, [roomId, game, teardown]);

  const join = useCallback(() => {
    if (joined.current || connecting.current || !roomId) return;
    connecting.current = true;
    setError(null);
    setPhase('asking');

    void (async () => {
      try {
        // ANDROID WANTS THE PERMISSION ASKED EXPLICITLY. getUserMedia requests
        // it internally too, but asking here is what lets us tell "they said
        // no" apart from "the connection failed" — two very different things to
        // put on screen, and only one of them worth a Retry button.
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: 'Talk at the table',
              message: 'VaultChat needs your microphone so the other players can hear you.',
              buttonPositive: 'Allow',
            },
          );
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            if (!alive.current) return;
            connecting.current = false;
            setPhase('error');
            setError('Microphone permission is needed to talk at the table.');
            return;
          }
        }
        if (!alive.current) { connecting.current = false; return; }
        setPhase('connecting');

        const cred = await api<VoiceToken>('/games/voice-token', {
          method: 'POST',
          body: JSON.stringify({ game, room: roomId, spectator: !canSpeak }),
        });
        if (!cred?.token || !cred?.url) throw new Error('No voice token');
        if (!alive.current) { connecting.current = false; return; }

        // The route is claimed BEFORE the room connects, so the first packet
        // does not arrive into a session still pointed at the earpiece.
        startBroadcastAudio();

        const s = await joinSfuRoom({
          url: cred.url,
          token: cred.token,
          identity: cred.identity,
          // A spectator's token cannot publish anyway — the SFU refuses it.
          // Asking not to is how we avoid opening the microphone at all.
          publish: canSpeak,
          video: false,
          // No frame encryption: there is no key these players share. See header.
          e2eeKey: null,
          onParticipant: () => sync(),
          onTrack: () => sync(),
          onReconnected: () => sync(),
          onLocalMedia: () => sync(),
          onDisconnected: () => { void teardown(); },
        });
        if (!alive.current) {
          try { await s.leave(); } catch {}
          connecting.current = false;
          return;
        }

        session.current = s;
        joined.current = true;
        connecting.current = false;

        /**
         * WHO IS TALKING — from the server, not from a polled audio level.
         *
         * The mesh had to sample `getStats()` on every peer connection every
         * 450ms to light the seat rings: six seats meant six native-bridge
         * round trips, twice a second, on the screen that is also dragging
         * thirteen cards. LiveKit computes this centrally and pushes it, so the
         * rings now cost one event.
         */
        s.room.on(RoomEvent.ActiveSpeakersChanged, (ps: any[]) => {
          if (!alive.current) return;
          const ids = (ps ?? []).map(p => p?.identity).filter(Boolean);
          setSpeaking(ids.length ? new Set(ids) : NO_SPEAKING);
        });
        s.room.on(RoomEvent.TrackMuted, sync);
        s.room.on(RoomEvent.TrackUnmuted, sync);

        setSince(Date.now());
        sync();
      } catch (e: any) {
        connecting.current = false;
        try { stopBroadcastAudio(); } catch {}
        if (!alive.current) return;
        const msg = String(e?.message ?? e ?? '');
        // 503 is "this deployment has no LiveKit", which is a different screen
        // from "it did not work": one invites a retry and the other does not.
        if (/503|not configured/i.test(msg)) {
          setPhase('unavailable');
          setError('Table voice is not available on this server.');
        } else {
          setPhase('error');
          setError('Could not connect to table voice.');
        }
      }
    })();
  }, [game, roomId, canSpeak, sync, teardown]);

  const leave = useCallback(() => { void teardown(); }, [teardown]);

  const toggleMute = useCallback(() => {
    const s = session.current;
    if (!s || !canSpeak) return;
    const next = !muted;
    setMuted(next);                       // optimistic; `sync` corrects it
    void s.room.localParticipant.setMicrophoneEnabled(!next).then(sync).catch(() => sync());
  }, [muted, canSpeak, sync]);

  const toggleSpeaker = useCallback(() => {
    setSpeaker(prev => {
      const next = !prev;
      // null, never false — see the import note. `false` pins the earpiece and
      // a Bluetooth headset stops being followed.
      try { setBroadcastSpeaker(next); } catch {}
      return next;
    });
  }, []);

  return useMemo(() => ({
    phase, error, canSpeak, muted, speaking, participants, peerState, speaker, since,
    join, leave, toggleMute, toggleSpeaker,
  }), [
    phase, error, canSpeak, muted, speaking, participants, peerState, speaker, since,
    join, leave, toggleMute, toggleSpeaker,
  ]);
}
