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

/** Broadcast audience ceiling. Audience members never publish, so this is a
 *  bandwidth and connection-count number rather than a CPU one. */
export const BROADCAST_MAX = 10_000;

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
  return participants > MESH_MAX ? 'sfu' : 'mesh';
}

/** Hard ceiling for a topology — what the server enforces on join. */
export function capacityFor(t: CallTopology): number {
  switch (t) {
    case 'mesh': return MESH_MAX;
    case 'sfu': return SFU_MAX;
    case 'broadcast': return BROADCAST_MAX;
  }
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

export default {};
