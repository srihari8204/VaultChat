// components/call/CallEncryptionBadge.tsx — says which protection is actually
// in force on THIS call.
//
// Required by decision D-1 (openspec/changes/calls-sfu-platform/design.md).
// That decision assumed the SFU must read group media for recording and
// streaming to exist. It does not: @livekit/react-native-webrtc ships
// RTCFrameCryptor, so frames are encrypted before they reach the transport and
// the SFU forwards ciphertext it cannot decode (lib/call/frameCrypto.ts).
// Recording/streaming would need a participant that holds the key, not a
// server that reads everyone's.
//
// WHY A COMPONENT RATHER THAN A STRING
// ------------------------------------
// The two guarantees are genuinely different, and the difference is invisible
// to the person on the call. Showing "End-to-end encrypted" on every call —
// or, as today, showing nothing at all — lets someone assume a 12-person call
// protects them the way their 1:1 does. That is misleading by omission, and it
// is the kind of claim a privacy-branded app is held to.
//
// The badge is deliberately quiet: this is reassurance, not a warning. It
// states what IS true rather than what is not.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CALL_FRAME_E2EE } from '../../lib/call/types';
import type { CallCipher } from '../../lib/callCrypto';

export type CallProtection = 'e2ee' | 'transport';

/**
 * THE RULE THIS FUNCTION EXISTS TO KEEP: it must never return 'e2ee' while the
 * live call cannot honour it.
 *
 * It used to keep that rule by assertion only — `CALL_FRAME_E2EE ? 'e2ee' : …`,
 * a compile-time constant that says what the build INTENDS, never what this
 * call actually negotiated. lib/callCrypto.ts hands back a `plainCipher`
 * passthrough (`enc === false`) whenever the peer's key bundle could not be
 * fetched, and a badge reading off a flag cheerfully said "End-to-end
 * encrypted" over it. So the second argument is required, and every call site
 * has to say which of the two shapes it is:
 *
 *   • a CallCipher (or one per mesh link) — the SDP/ICE for this call crosses
 *     OUR OWN socket, so the live cipher is the only honest evidence. One
 *     unsealed link downgrades the whole badge: the SDP carries the DTLS-SRTP
 *     fingerprint that anchors media encryption, and the candidates carry
 *     device IPs.
 *   • null — this call has no signalling cipher because its SDP never crosses
 *     our server: the V2 engine path negotiates with LiveKit over TLS and seals
 *     media frames before publish (lib/call/frameCrypto.ts). That is safe only
 *     because the publish path is fail-closed — no key or no cryptor means
 *     nothing is published at all (lib/call/room.ts). If that ever softens to a
 *     warn-and-continue, this must go back to 'transport'.
 *
 * The participant count no longer changes the answer — the same mechanism
 * covers 1:1 and group — but it stays so call sites do not churn, and because
 * the decision belongs here if the two guarantees ever diverge again.
 */
export function protectionFor(
  _participantCount: number,
  signalling: CallCipher | CallCipher[] | null,
): CallProtection {
  if (!CALL_FRAME_E2EE) return 'transport';
  if (signalling == null) return 'e2ee';
  const links = Array.isArray(signalling) ? signalling : [signalling];
  // Empty = nobody connected yet: nothing has been claimed and nothing has
  // leaked. A missing entry is treated as unsealed, not as "not applicable".
  return links.every(c => !!c && c.enc === true) ? 'e2ee' : 'transport';
}

const COPY: Record<CallProtection, { icon: React.ComponentProps<typeof Ionicons>['name']; label: string }> = {
  e2ee:      { icon: 'lock-closed', label: 'End-to-end encrypted' },
  transport: { icon: 'shield-checkmark-outline', label: 'Encrypted in transit' },
};

export function CallEncryptionBadge({ protection }: { protection: CallProtection }) {
  const { icon, label } = COPY[protection];
  return (
    <View style={s.row}>
      <Ionicons name={icon} size={11} color="rgba(255,255,255,0.55)" />
      <Text style={s.txt}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  txt: { color: 'rgba(255,255,255,0.55)', fontSize: 11, fontWeight: '600', letterSpacing: 0.2 },
});

export default CallEncryptionBadge;
