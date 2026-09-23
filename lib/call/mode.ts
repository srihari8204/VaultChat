// lib/call/mode.ts — which media topology a call uses, and what it may cost.
//
// Phase 1/2 of openspec/changes/calls-sfu-platform. This is the decision layer
// only: no LiveKit, no WebRTC, no I/O. Everything downstream — how many people
// may join, whether a participant is allowed to publish, how many tiles get
// rendered — is derived from here, so the rules live in one pure module that
// can be reasoned about and tested without a device or a server.
//
// THREE TOPOLOGIES
//
//   mesh       every participant connects to every other. Lowest latency and
//              zero server media cost, but each device runs N-1 outbound
//              ENCODES, which is the binding constraint — not bandwidth.
//   sfu        one upstream per participant, server forwards. What makes 64
//              possible at all.
//   broadcast  an SFU room where only a handful may publish and everyone else
//              subscribes. Scale comes from that asymmetry, not from capacity.
//
// WHY MESH STAYS FOR SMALL CALLS
// A 1:1 or 3-person call over mesh is peer-to-peer: lower latency, no server
// media cost, and — decisively — it keeps 1:1 END-TO-END ENCRYPTED (decision
// D-1). Routing everything through the SFU for uniformity would silently
// downgrade the guarantee on the calls people trust most.

export type CallTopology = 'mesh' | 'sfu' | 'broadcast';
export type CallRole = 'host' | 'cohost' | 'speaker' | 'audience';

/** Mesh ceiling, mirroring the server's MESH_MAX_PARTICIPANTS default. At 5,
 *  each phone already runs 4 peer connections and 4 outbound encodes. */
export const MESH_MAX = 5;

/** SFU group-call ceiling — the product target. */
export const SFU_MAX = 64;

/**
 * WebRTC-backed audience ceiling for a broadcast.
 *
 * NOT the audience limit — the limit of the INTERACTIVE tier. Every WebRTC
 * subscriber is a peer connection with its own ICE and DTLS state, so an SFU
 * node serves low thousands, and cascading to millions is economically absurd
 * before it is technically hard. Past this, viewers are served over HLS/CDN
 * (see BroadcastTier below), which is how every platform at this scale works.
 */
export const BROADCAST_MAX = 10_000;

// ── Broadcast delivery tiers ───────────────────────────────────────────
//
// Reaching millions is a LATENCY-FOR-SCALE trade, and it cannot be avoided by
// engineering: WebRTC buys sub-second interactivity at a per-connection cost,
// CDN segments buy unlimited fan-out at the price of seconds of delay.
//
//   publisher    sends media. WebRTC. Host, co-hosts, promoted speakers.
//   interactive  WebRTC subscriber. ~200-400 ms. Can be promoted to speak
//                instantly, because the connection already exists.
//   viewer       HLS/LL-HLS segments over a CDN. 2-5 s (LL-HLS) or 10-30 s
//                (plain HLS). UNLIMITED — the CDN absorbs it. Promotion means
//                switching this person onto WebRTC first.
//
// Cost is the part that decides the product, not the tech: video at ~1.5 Mbps
// is ~675 MB per viewer-hour, so 2M concurrent viewers is ~1.35 PB/hour of
// CDN egress. AUDIO-ONLY at 32 kbps is ~14 MB per viewer-hour — roughly 50x
// cheaper for the same audience. An audio-first broadcast is affordable at
// millions; a video one is a serious infrastructure bill.

export type BroadcastTier = 'publisher' | 'interactive' | 'viewer';
export type DeliveryTransport = 'webrtc' | 'hls';

/** Unlimited by design — the CDN, not the app, is the constraint. */
export const VIEWER_MAX = Number.POSITIVE_INFINITY;

/**
 * Which tier a joiner belongs to. Publishers and promoted speakers are always
 * WebRTC; everyone else fills the interactive tier until it is full, then
 * spills to CDN viewing.
 */
export function broadcastTierFor(
  role: CallRole,
  interactiveCount: number,
  interactiveMax = BROADCAST_MAX,
): BroadcastTier {
  if (role !== 'audience') return 'publisher';
  return interactiveCount < interactiveMax ? 'interactive' : 'viewer';
}

export function transportFor(tier: BroadcastTier): DeliveryTransport {
  return tier === 'viewer' ? 'hls' : 'webrtc';
}

/** Rough end-to-end latency, so the UI can be honest about what someone sees
 *  ("you are watching ~3s behind") rather than implying everyone is live. */
export function expectedLatencyMs(tier: BroadcastTier): number {
  switch (tier) {
    case 'publisher':
    case 'interactive': return 300;
    case 'viewer': return 3_000;   // LL-HLS; plain HLS is ~10-30s
  }
}

/**
 * A viewer must move to WebRTC before they can speak — you cannot publish from
 * an HLS session. Returns whether promotion needs that switch, so the UI can
 * warn about the reconnect instead of appearing to hang.
 */
export function promotionNeedsTransportSwitch(tier: BroadcastTier): boolean {
  return tier === 'viewer';
}

/** How many people may publish in a broadcast (host + co-hosts + promoted
 *  speakers). Kept small on purpose: every extra publisher is forwarded to
 *  EVERY subscriber, so this number multiplies against the audience. */
export const BROADCAST_MAX_PUBLISHERS = 5;

/**
 * Nobody renders 64 live videos on a phone. Beyond this many tiles the UI
 * subscribes to active speakers only, which is what keeps a large call
 * affordable on the device rather than on the server.
 */
export const MAX_RENDERED_TILES = 16;

export interface TopologyInput {
  /** Total participants including yourself. */
  participants: number;
  /** A broadcast is chosen by the organiser; it is not inferred from size. */
  isBroadcast?: boolean;
  /** SFU unavailable (not provisioned, or the flag is off) → mesh only. */
  sfuAvailable?: boolean;
}

/**
 * Decide the topology. Deliberately total and deterministic — the SERVER runs
 * this at call creation and the client only renders the result, so a client
 * cannot opt itself into the SFU to escape a role restriction.
 */
export function topologyFor({ participants, isBroadcast = false, sfuAvailable = true }: TopologyInput): CallTopology {
  if (isBroadcast) return 'broadcast';          // asymmetric by definition, even with 2 people
  if (!sfuAvailable) return 'mesh';             // degrade rather than fail
  // SFU FOR EVERY CALL — 1:1 included. Owner decision, 2026-08-16.
  //
  // This used to hand 1:1 and small calls to the mesh and only reach for the SFU
  // past MESH_MAX. That kept TWO transports alive, and every hard call bug found
  // on device sat where the two meet: per-pair NAT traversal (measured as 1-2
  // minutes before audio became audible, ICE hunting across 7-14 relay
  // candidates), a single module-wide session that made hold impossible, and
  // teardown that differed by path.
  //
  // The SFU costs nothing in trust: RTCFrameCryptor encrypts each frame BEFORE
  // it leaves the device (see joinViaSfu in engine.ts), so the server forwards
  // ciphertext exactly as the mesh peers did. The media key is still the one
  // this call derived over the Double Ratchet — the transport changes, the trust
  // model does not.
  //
  // THIS FUNCTION HAS NO PRODUCTION CALLER. Audited 2026-09-22: the only
  // references anywhere are in mode.selftest.ts. engine.ts's join() goes
  // straight to joinCallRoom with an SFU token and never asks what topology to
  // use, so the sfuAvailable=false branch above is a MODEL of a degradation
  // that does not run.
  //
  // Read that branch as a design intent, never as shipped behaviour: today an
  // unreachable SFU fails the call, it does not fall back to a mesh. There is
  // no mesh left to fall back to — engine.ts's onOffer/onAnswer/onIce are
  // inert and no SDP crosses the wire.
  //
  // Left in place rather than deleted because MESH_MAX, SFU_MAX and the
  // capacity helpers below ARE used, and because this is where the decision
  // belongs the day a fallback is actually built. If that day does not come,
  // delete the branch rather than letting it keep reading as a safety net.
  return 'sfu';
}

/**
 * Who mints the call's shared media key. EXACTLY ONE side must say yes, or the
 * room ends up split across two keys and nobody can decode anybody.
 *
 * GROUP: lowest uid. Everyone is already in the room and listening, so any
 * deterministic rule works and this one needs no extra state.
 *
 * 1:1: the ANSWERING side, which is NOT the lowest-uid rule and must not be.
 * The caller reaches this decision while the callee is still ringing and has
 * not attached its socket listeners yet, so a key minted by the caller is sent
 * to a device that cannot receive it and is lost — after which the caller joins
 * the SFU and the callee never can. The callee mints at the moment it accepts,
 * when the caller is provably listening. Its arrival is also how the caller
 * learns the call was answered.
 */
export function mintsMediaKey(
  a: { oneToOne: boolean; direction: 'outgoing' | 'incoming'; meId: string; others: string[] },
): boolean {
  if (a.oneToOne) return a.direction === 'incoming';
  return [a.meId, ...a.others].sort()[0] === a.meId;
}

/** Hard ceiling for a topology — what the server enforces on join. */
export function capacityFor(t: CallTopology): number {
  switch (t) {
    case 'mesh': return MESH_MAX;
    case 'sfu': return SFU_MAX;
    // Unlimited: past the interactive tier, joiners are served by the CDN.
    case 'broadcast': return VIEWER_MAX;
  }
}

/** Capacity of the WebRTC (interactive) tier specifically — what the SFU must
 *  actually hold. This is the number that sizes servers; capacityFor() is the
 *  number that answers "can this person join at all". */
export function interactiveCapacityFor(t: CallTopology): number {
  return t === 'broadcast' ? BROADCAST_MAX : capacityFor(t);
}

export function canJoin(t: CallTopology, current: number): boolean {
  return current < capacityFor(t);
}

/**
 * May this role send media?
 *
 * The answer is enforced by the MEDIA SERVER (an audience token is minted with
 * canPublish=false and an empty publish-source list), not by hiding a button.
 * This function exists so the UI agrees with that enforcement rather than
 * offering controls the server will refuse.
 */
export function canPublish(t: CallTopology, role: CallRole): boolean {
  if (t !== 'broadcast') return true;           // mesh and ordinary SFU calls are symmetric
  return role !== 'audience';
}

/** Publisher slots left in a broadcast, so promote-to-speaker can be greyed
 *  out rather than failing at the token mint. */
export function publisherSlotsLeft(t: CallTopology, currentPublishers: number): number {
  if (t !== 'broadcast') return Number.POSITIVE_INFINITY;
  return Math.max(0, BROADCAST_MAX_PUBLISHERS - currentPublishers);
}

/**
 * How many remote video tiles to actually subscribe to and render.
 *
 * A broadcast renders only its publishers. A large SFU call renders a page of
 * tiles and takes audio for the rest — subscribing to 63 video streams would
 * cost the device far more than the server.
 */
export function tilesToRender(t: CallTopology, participants: number, publishers = 0): number {
  const remote = Math.max(0, participants - 1);
  if (t === 'broadcast') return Math.min(publishers, BROADCAST_MAX_PUBLISHERS);
  return Math.min(remote, MAX_RENDERED_TILES);
}

/**
 * Simulcast layers to publish, by device capability.
 *
 * Three layers (240/480/720) let the SFU serve each subscriber an appropriate
 * resolution, but encoding three streams at once is a THERMAL problem on a
 * budget phone, not a configuration preference. Two layers is the honest
 * setting there. Mesh publishes one — there is no selective forwarding to
 * feed, so extra layers would be pure waste.
 */
export function simulcastLayers(t: CallTopology, lowEndDevice: boolean): number {
  if (t === 'mesh') return 1;
  return lowEndDevice ? 2 : 3;
}

/**
 * Who gets a sealed copy of an in-call chat message or reaction.
 *
 * 1:1 is the one peer. A GROUP is everyone ON THE CALL except us — the live
 * roster, not the chat's membership, because a message belongs to the people in
 * the room and someone who never joined must not receive it.
 *
 * IT LIVES HERE, in the cost module, because the count IS the cost. In-call
 * text rides the pairwise ratchet, so a group of 64 pays 63 seals per message —
 * the deliberate price of keeping text end-to-end encrypted after the MEDIA
 * stopped being (owner decision 2026-08-16). Text is exactly the content that
 * should not lose the guarantee just because it travels beside video.
 *
 * Pure, so the rule is testable without a device: returning [] for a group is
 * what made in-call chat silently inert, and nothing could catch it while the
 * rule lived inside the engine.
 */
export function chatRecipients(peerUid: string, meId: string, roster: string[]): string[] {
  if (peerUid) return [peerUid];
  return roster.filter(uid => uid && uid !== meId);
}

export default {};
