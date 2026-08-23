// lib/games/useTableVoice.ts — talking at the table.
//
// The games server mints a room-scoped LiveKit token at POST /api/voice/token
// with `{room: "<game>-<roomId>"}`, using the games session cookie the table
// socket already established. Two things about that endpoint shape the code
// here:
//
//   1. The SERVER decides whether you may speak. Spectators come back with
//      canPublish=false and the SFU drops their audio, so this never asks for
//      the microphone on their behalf — a client asking nicely was the whole
//      weakness the endpoint was written to close.
//   2. `{ok:true, enabled:false}` is a valid answer, not an error. It means the
//      deployment is mesh-only. VaultChat deleted its mesh long ago (every call
//      rides the SFU), so there is nothing to fall back TO: voice is simply
//      unavailable and the UI must say so rather than spin.
//
// VaultChat already ships LiveKit for its own calls, so this adds no
// dependency — but it must not fight those calls, which is why the mic is
// released rather than muted and why the room is torn down on unmount.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { AudioSession, registerGlobals } from '@livekit/react-native';
import { Room, RoomEvent, type Participant } from 'livekit-client';
import type { GameKind } from '../gamesSocket';

const GAMES_HTTP = 'https://games.corefinite.com';

/**
 * Install LiveKit's WebRTC globals, but only if nobody already has.
 *
 * registerGlobals() puts RTCPeerConnection and MediaStream on globalThis, and
 * running it a SECOND time replaces those constructors underneath an SDK that
 * is already using them — which is a real bug this app has hit before. Calling
 * and Go Live each guard it with their own module-local flag, so a flag of our
 * own could not see that one of them had already registered.
 *
 * Probing for the constructors is registration-source agnostic: whoever
 * installed them, we do not install them again.
 */
function ensureGlobals(): void {
  const g = globalThis as any;
  if (typeof g.RTCPeerConnection !== 'undefined' && typeof g.MediaStream !== 'undefined') return;
  registerGlobals();
}

export type VoicePhase = 'off' | 'asking' | 'connecting' | 'live' | 'unavailable' | 'error';

export interface TableVoice {
  phase: VoicePhase;
  error: string | null;
  /** False when the server seated you as a spectator: listen-only. */
  canSpeak: boolean;
  muted: boolean;
  /** Identities currently talking, for the seat rings. */
  speaking: Set<string>;
  /** Everyone in the audio room, including us. */
  participants: string[];
  join: () => void;
  leave: () => void;
  toggleMute: () => void;
}

export function useTableVoice(game: GameKind, roomId: string): TableVoice {
  const [phase, setPhase] = useState<VoicePhase>('off');
  const [error, setError] = useState<string | null>(null);
  const [canSpeak, setCanSpeak] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [participants, setParticipants] = useState<string[]>([]);

  const roomRef = useRef<Room | null>(null);
  const alive = useRef(true);

  const teardown = useCallback(async () => {
    const r = roomRef.current;
    roomRef.current = null;
    if (r) { try { await r.disconnect(); } catch {} }
    // Release the audio session too, or the phone stays in communication mode
    // after the table is closed.
    try { await AudioSession.stopAudioSession(); } catch {}
  }, []);

  // A live microphone must not outlive the table. Leaving the screen with the
  // room still connected would keep publishing from a board nobody is looking
  // at, which is the one voice bug users never forgive.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; void teardown(); };
  }, [teardown]);

  const leave = useCallback(() => {
    void teardown();
    if (!alive.current) return;
    setPhase('off');
    setSpeaking(new Set());
    setParticipants([]);
    setError(null);
  }, [teardown]);

  const join = useCallback(() => {
    if (!roomId) { setPhase('error'); setError('This table has no voice room.'); return; }
    setPhase('connecting');
    setError(null);

    void (async () => {
      try {
        // The room name is "<game>-<roomId>"; the server splits on the FIRST
        // hyphen, because room ids may contain hyphens themselves.
        const res = await fetch(`${GAMES_HTTP}/api/voice/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ room: `${game}-${roomId}` }),
        });
        const j: any = await res.json().catch(() => null);

        if (!res.ok || !j?.ok) {
          throw new Error(res.status === 403 ? 'You are not seated at this table.' : 'Voice is not available right now.');
        }
        if (!j.enabled) {
          // Mesh-only deployment. There is no mesh in this app to fall back to.
          if (alive.current) { setPhase('unavailable'); setError('Voice is not switched on for these tables yet.'); }
          return;
        }

        const mayPublish = !!j.canPublish;
        if (alive.current) setCanSpeak(mayPublish);

        // Spectators are never asked for the microphone — they cannot be heard
        // even if they granted it.
        if (mayPublish && Platform.OS === 'android') {
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
        // Android routes to the earpiece at call volume without this, which at
        // a game table sounds like the audio is broken.
        await AudioSession.startAudioSession();

        const room = new Room({ adaptiveStream: false, dynacast: false });
        roomRef.current = room;

        const refresh = () => {
          if (!alive.current) return;
          const names = [room.localParticipant, ...room.remoteParticipants.values()]
            .map((p: Participant) => p.identity)
            .filter(Boolean);
          setParticipants(names);
        };

        room
          .on(RoomEvent.ParticipantConnected, refresh)
          .on(RoomEvent.ParticipantDisconnected, refresh)
          .on(RoomEvent.ActiveSpeakersChanged, (spk: Participant[]) => {
            if (!alive.current) return;
            setSpeaking(new Set(spk.map(p => p.identity)));
          })
          .on(RoomEvent.Disconnected, () => {
            if (!alive.current || roomRef.current !== room) return;
            roomRef.current = null;
            setPhase('off');
            setSpeaking(new Set());
            setParticipants([]);
          });

        await room.connect(j.url, j.token);
        if (!alive.current) { await room.disconnect().catch(() => {}); return; }

        if (mayPublish) await room.localParticipant.setMicrophoneEnabled(true);
        refresh();
        setMuted(false);
        setPhase('live');
      } catch (err: unknown) {
        if (!alive.current) return;
        await teardown();
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [game, roomId, teardown]);

  /**
   * Muting RELEASES the microphone rather than silencing it.
   *
   * A Bluetooth headset with an open mic is pinned to the hands-free profile —
   * mono and narrowband — so the table and the game audio stay muffled for as
   * long as the mic is held, even while that player says nothing. Letting the
   * device go returns the headset to A2DP. It also switches off the phone's
   * recording indicator, which is what a muted player expects to see.
   */
  const toggleMute = useCallback(() => {
    const room = roomRef.current;
    if (!room || !canSpeak) return;
    const next = !muted;
    setMuted(next);
    void room.localParticipant.setMicrophoneEnabled(!next).catch(() => {});
  }, [muted, canSpeak]);

  return { phase, error, canSpeak, muted, speaking, participants, join, leave, toggleMute };
}
