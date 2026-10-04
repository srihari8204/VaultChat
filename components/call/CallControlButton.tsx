// components/call/CallControlButton.tsx — the one call-control button.
//
// app/voicecall.tsx and app/videocall.tsx each carried a private `ControlBtn`
// with the same structure but different metrics (the voice screen has 3 large
// buttons in a row; the video screen has 7 smaller ones that wrap). Two copies
// of the same component is how they drift, so this merges the STRUCTURE while
// keeping both metric sets verbatim behind `variant`.
//
// Both variants below are transcribed byte-for-byte from the screens they
// replace — same sizes, radii, borders, icon sizes, label sizes, numberOfLines
// and activeOpacity. This renders pixel-identically to what shipped; it is a
// de-duplication, not a redesign.

import { memo } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CALL } from '../../constants/callTheme';

export type CallControlVariant = 'voice' | 'video';

export interface CallControlButtonProps {
  icon: string;
  label: string;
  onPress: () => void;
  /** Armed/engaged state — mute on, speaker on, sharing, filter open. */
  active?: boolean;
  /** End-call styling. */
  danger?: boolean;
  /** 'voice' = 3 large buttons; 'video' = 7 compact buttons that wrap. */
  variant?: CallControlVariant;
  /** Spoken label when the short visible one does not name the action. */
  a11yLabel?: string;
}

function CallControlButtonImpl({
  icon, label, onPress, active, danger, variant = 'voice', a11yLabel,
}: CallControlButtonProps) {
  const S = variant === 'video' ? VIDEO : VOICE;
  return (
    <TouchableOpacity
      style={[S.btn, active && S.btnActive, danger && S.btnDanger]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      // Toggle state was conveyed only by colour. A button that never passes
      // `active` (Flip, End) is not a toggle and announces no state.
      accessibilityState={active === undefined ? undefined : { selected: active }}
    >
      <Ionicons name={icon as any} size={variant === 'video' ? 22 : 24} color="#fff" style={S.btnIcon} />
      <Text style={S.btnLabel} numberOfLines={variant === 'video' ? 1 : undefined}>{label}</Text>
    </TouchableOpacity>
  );
}

export const CallControlButton = memo(CallControlButtonImpl);

// ── voice call: 3 buttons, evenly spaced, bordered ────────────────────
const VOICE = StyleSheet.create({
  btn:       { width: 78, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 18, backgroundColor: CALL.ctrl, borderWidth: 1, borderColor: CALL.ctrlBorder },
  btnActive: { backgroundColor: CALL.active, borderColor: CALL.active },
  btnDanger: { backgroundColor: CALL.danger, borderColor: CALL.danger },
  btnIcon:   { fontSize: 24 },
  btnLabel:  { color: CALL.text, fontSize: 11, marginTop: 4 },
});

// ── video call: 7 compact buttons inside a frosted bar, wraps to 2 rows ─
const VIDEO = StyleSheet.create({
  btn:       { width: 62, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 14, backgroundColor: CALL.ctrl },
  btnActive: { backgroundColor: CALL.active },
  btnDanger: { backgroundColor: CALL.danger },
  btnIcon:   { fontSize: 22 },
  btnLabel:  { color: CALL.text, fontSize: 10, marginTop: 2 },
});

export default CallControlButton;
