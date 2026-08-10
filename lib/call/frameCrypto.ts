// lib/call/frameCrypto.ts — end-to-end encryption of MEDIA frames.
//
// WHY THIS EXISTS
// ---------------
// A mesh call is already end-to-end encrypted: DTLS-SRTP runs directly between
// the two devices and no server sits in the media path. An SFU breaks that — it
// terminates SRTP in order to forward, so by default the server can decode every
// frame it routes. That is the trade-off usually quoted as "E2EE or scale, pick
// one".
//
// It is not true on this stack. `@livekit/react-native-webrtc` (already a
// dependency, used for every call today) ships RTCFrameCryptor: insertable-
// streams encryption applied to each frame BEFORE it reaches the transport and
// undone after it leaves, natively on Android and iOS. The SFU forwards
// ciphertext it cannot read.
//
// WHERE THE KEY COMES FROM — nothing new is invented here:
//   1:1    lib/callCrypto mints a random 32-byte per-call key and wraps it once
//          through the Double Ratchet. That key is exactly what setSharedKey
//          wants.
//   group  services/crypto/senderKey provides the Sender Key already used for
//          group messaging; the same distribution rides the existing E2EE
//          channel, so no new key-agreement protocol is introduced.
//
// The SFU therefore changes the TRANSPORT, not the key agreement — which is why
// this module is small.
//
// SCOPE: only worth attaching when a server is in the media path. On a mesh
// call it would encrypt already-encrypted frames for no benefit and real CPU
// cost, so enableFrameCrypto() is called from the SFU path only.

import {
  RTCFrameCryptorFactory,
  RTCFrameCryptorAlgorithm,
} from '@livekit/react-native-webrtc';

/** AES-GCM. The only algorithm the native side implements. */
const ALGORITHM = RTCFrameCryptorAlgorithm.kAesGcm;

export interface FrameCryptoHandle {
  /** Rotate to a new key — call on join/leave so departed members go dark. */
  setKey(key: Uint8Array): Promise<void>;
  /** Advance the ratchet without a full re-key. */
  ratchet(): Promise<void>;
  /** Detach and free native resources. Safe to call twice. */
  dispose(): Promise<void>;
  /** True once at least one cryptor is attached. */
  readonly active: boolean;
}

const NOOP: FrameCryptoHandle = {
  async setKey() {}, async ratchet() {}, async dispose() {}, active: false,
};

/**
 * Encrypt every outgoing frame and decrypt every incoming one on `pc`.
 *
 * @param pc            the RTCPeerConnection carrying media to/from the SFU
 * @param participantId our identity in the room (from the SFU token)
 * @param key           32-byte media key — the per-call key or group sender key
 *
 * Returns a no-op handle when frame crypto is unavailable rather than throwing:
 * a build without the native module must still be able to place a call, and the
 * CALLER decides whether an unencrypted SFU path is acceptable — see `active`.
 */
export async function enableFrameCrypto(
  pc: any,
  participantId: string,
  key: Uint8Array,
): Promise<FrameCryptoHandle> {
  if (!pc || !participantId || key?.length !== 32) return NOOP;

  let provider: any;
  try {
    provider = RTCFrameCryptorFactory.createDefaultKeyProvider({
      sharedKey: true,
      // Domain separation for the ratchet, NOT a secret — it only has to be
      // identical on every participant, so it is a constant rather than
      // something negotiated. Versioned so a future change can be rolled out
      // without silently breaking calls between mixed builds.
      ratchetSalt: 'vaultchat-call-frame-v1',
      // A key ring lets frames sealed with the PREVIOUS key still decrypt for a
      // window after a rotation. Without it, every join/leave would produce a
      // burst of undecryptable frames — visible as a freeze — because senders
      // do not switch keys at the same instant.
      keyRingSize: 16,
      ratchetWindowSize: 16,
      // -1 = never give up on a participant. A few undecryptable frames during a
      // rotation must not permanently mute someone.
      failureTolerance: -1,
    });
    await provider.setSharedKey(key);
  } catch (err) {
    console.warn('[call] frame crypto unavailable —', (err as any)?.message ?? err);
    return NOOP;
  }

  const cryptors: any[] = [];
  const attach = () => {
    try {
      for (const sender of pc.getSenders?.() ?? []) {
        if (!sender?.track) continue;
        const c = RTCFrameCryptorFactory.createFrameCryptorForRtpSender(
          participantId, sender, ALGORITHM, provider);
        c.setEnabled?.(true);
        cryptors.push(c);
      }
      for (const receiver of pc.getReceivers?.() ?? []) {
        if (!receiver?.track) continue;
        const c = RTCFrameCryptorFactory.createFrameCryptorForRtpReceiver(
          // Receivers are keyed by the SENDING participant. With sharedKey the
          // same key covers everyone, so our own id is a valid label here.
          participantId, receiver, ALGORITHM, provider);
        c.setEnabled?.(true);
        cryptors.push(c);
      }
    } catch (err) {
      console.warn('[call] could not attach a frame cryptor —', (err as any)?.message ?? err);
    }
  };

  attach();
  console.warn('[call] frame E2EE active —', cryptors.length, 'cryptors attached');

  let disposed = false;
  return {
    get active() { return cryptors.length > 0; },
    async setKey(next: Uint8Array) {
      if (disposed || next?.length !== 32) return;
      await provider.setSharedKey(next);
      console.warn('[call] frame E2EE key rotated');
    },
    async ratchet() {
      if (disposed) return;
      try { await provider.ratchetSharedKey(); } catch {}
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const c of cryptors) { try { await c.dispose?.(); } catch {} }
      cryptors.length = 0;
      try { await provider.dispose?.(); } catch {}
    },
  };
}

export default { enableFrameCrypto };
