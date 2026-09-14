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

export type CallProtection = 'e2ee' | 'transport';

/**
 * EVERY call is 'e2ee' while CALL_FRAME_E2EE is on — 1:1 and group alike.
 *
 * Between 2026-08-16 and the frame-crypto rewiring this returned 'transport'
 * unconditionally, because the SFU genuinely could decode every frame. It can
 * no longer: a per-call 32-byte key is sealed to each recipient through the
 * pairwise Double Ratchet and installed as the frame cryptor's shared key
 * before anything is published.
 *
 * The participant count no longer changes the answer — the same mechanism
 * covers both — but it stays so call sites do not churn, and because the
 * decision belongs here if the two guarantees ever diverge again.
 *
 * THE RULE THIS FUNCTION EXISTS TO KEEP: it must never return 'e2ee' while the
 * media path cannot honour it. That is safe here only because the publish path
 * is fail-closed — no key or no cryptor means nothing is published at all
 * (lib/call/room.ts), rather than something published in the clear. If that
 * ever softens to a warn-and-continue, this must go back to 'transport'.
 */
export function protectionFor(_participantCount: number): CallProtection {
  return CALL_FRAME_E2EE ? 'e2ee' : 'transport';
}

const COPY: Record<CallProtection, { icon: any; label: string }> = {
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
