// components/call/CallEncryptionBadge.tsx — says which protection is actually
// in force on THIS call.
//
// Required by decision D-1 (openspec/changes/calls-sfu-platform/design.md):
// 1:1 calls are end-to-end encrypted; group calls will be routed through the
// SFU and are encrypted in transit only, because the server must be able to
// decrypt group media for recording and streaming to exist at all.
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

export type CallProtection = 'e2ee' | 'transport';

/**
 * EVERY call is 'transport' now — owner decision, 2026-08-16.
 *
 * Calls used to be end-to-end encrypted at 1:1 (a per-call key, media never
 * leaving the two devices) and this returned 'e2ee' for two participants. That
 * is no longer true: all media goes through the SFU and the frame encryption
 * was removed to get calling working (see lib/call/room.ts for the reasoning).
 *
 * The count argument stays so call sites do not churn, and because a future
 * build that restores frame encryption will need exactly this decision back.
 * What must never happen is this function returning 'e2ee' while the media
 * path cannot honour it — a privacy claim the product cannot keep is worse
 * than no badge at all.
 */
export function protectionFor(_participantCount: number): CallProtection {
  return 'transport';
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
