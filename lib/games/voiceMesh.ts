// lib/games/voiceMesh.ts — the decisions behind table voice, without the WebRTC.
//
// Table voice on the games server is a PEER-TO-PEER AUDIO MESH signalled over
// the game's own WebSocket. There is no SFU: `/config.js` on the deployed server
// reports `"sfu": false`, and `POST /api/voice/token` does not exist (404). The
// native client had been written against that token endpoint, which is why voice
// never connected in any of the four games.
//
// The wire, from games-web/vgvoice.js — the shipped client is the specification:
//
//   → {t:'voice-hello', to, data:{ack?:true}}   "I am in voice"
//   → {t:'voice-bye',   to, data:{}}            "I have left voice"
//   → {t:'voice-offer'|'voice-answer', to, data: <RTCSessionDescription>}
//   → {t:'voice-ice',   to, data: <RTCIceCandidate>}
//   → {t:'voice-state', to, data:{mic:boolean, spk:boolean}}
//   ← the same frames, with `from` set to the sender. The server relays; it
//     never inspects the payload.
//
// Everything in THIS file is pure: no RTCPeerConnection, no React, no sockets.
// It holds the three things that are easy to get subtly wrong and impossible to
// eyeball on a two-device test — who offers, who is at the table, and when a
// remote ICE candidate may be applied — so they can be checked directly. See
// voiceMesh.selftest.ts.

/** Who is at the table and worth meshing with: id → display name. */
export type Roster = Record<string, string>;

/** What a peer last told us about themselves. */
export interface PeerState { mic: boolean; spk: boolean }

/**
 * Who dials whom.
 *
 * Both ends learn about each other at the same time, so without a rule both
 * send an offer and the negotiation collides ("glare") — each side then answers
 * a call it is also making, and the connection lands in have-local-offer with
 * no media. The lower id dials; the higher waits. Same rule as vgvoice.js, and
 * it has to be the SAME rule on both ends or nobody dials at all.
 */
export function shouldInitiate(you: string, peer: string): boolean {
  return you < peer;
}

/**
 * Read the table roster out of whichever frame carried it.
 *
 * Three games publish their seats three different ways, and rummy publishes a
 * fourth (`peers`). Taking whichever is present keeps this working for all of
 * them without a per-game branch.
 *
 * Bots and yourself are excluded: a bot has no microphone, and offering to
 * yourself produces a peer connection that never completes.
 */
export function rosterFrom(msg: any, you: string): Roster | null {
  const list: any[] | null =
    Array.isArray(msg?.peers) ? msg.peers
    : Array.isArray(msg?.lobby?.members) ? msg.lobby.members
    : Array.isArray(msg?.game?.players) ? msg.game.players
    : null;
  if (!list) return null;

  const next: Roster = {};
  for (const p of list) {
    const id = p?.vaultId ?? p?.id;
    if (!id || id === you || p?.isBot) continue;
    next[id] = typeof p?.name === 'string' && p.name ? p.name : id;
  }
  return next;
}

/** Who joined the table and who left it, between two rosters. */
export function diffRoster(prev: Roster, next: Roster): { added: string[]; gone: string[] } {
  return {
    added: Object.keys(next).filter(id => !(id in prev)),
    gone: Object.keys(prev).filter(id => !(id in next)),
  };
}

/**
 * Remote ICE candidates, held until there is a remote description to attach
 * them to.
 *
 * react-native-webrtc THROWS on addIceCandidate before setRemoteDescription —
 * lib/vaultBeamDirect.ts carries the same buffer and the same comment, because
 * this repo has already paid for the bug once. The reference web client wraps
 * the call in a bare try/catch, which on a browser is merely wasteful and on
 * React Native silently discards the host candidate and leaves P2P failing
 * intermittently, on some networks only.
 *
 * Candidates always arrive before the answer for the offering side: the remote
 * end starts trickling the moment it sets ITS local description.
 */
export class IceQueue {
  private queued: unknown[] = [];
  private open = false;

  /** True once the remote description is set and candidates may be applied. */
  get ready(): boolean { return this.open; }

  /**
   * Offer a candidate. Returns true when it may be applied immediately;
   * false means it has been held and will come back from `flush()`.
   */
  accept(candidate: unknown): boolean {
    if (this.open) return true;
    this.queued.push(candidate);
    return false;
  }

  /** Remote description is set: hand back everything held, in arrival order. */
  flush(): unknown[] {
    this.open = true;
    return this.queued.splice(0);
  }

  /** Peer gone. Drop anything held so a closed connection cannot be fed. */
  reset(): void {
    this.queued = [];
    this.open = false;
  }
}

/**
 * Is this audio level someone talking?
 *
 * WebRTC reports `audioLevel` as 0..1. The threshold is deliberately well above
 * a silent-but-open microphone (which idles a little above zero on most phones)
 * and below normal speech, so the ring tracks speech rather than flickering on
 * room noise.
 */
export const SPEAKING_LEVEL = 0.02;

/**
 * Pull one audio level out of a getStats() report set.
 *
 * `kind` picks the direction: 'inbound-rtp' is what a peer is sending us,
 * 'media-source' is our own microphone. Returns null when the platform does not
 * report levels at all — in which case the caller must show no speaking rings
 * rather than guessing, since a wrong ring is worse than none.
 */
export function audioLevelFrom(reports: Iterable<any>, kind: 'inbound-rtp' | 'media-source'): number | null {
  let found: number | null = null;
  for (const r of reports) {
    if (!r || r.type !== kind) continue;
    const isAudio = r.kind === 'audio' || r.mediaType === 'audio' || kind === 'media-source';
    if (!isAudio) continue;
    if (typeof r.audioLevel === 'number') found = Math.max(found ?? 0, r.audioLevel);
  }
  return found;
}
