// components/family/HubControls.tsx — the Family hub's two personal controls,
// moved out of app/family.tsx unchanged: the "Share my location" row (with the
// space's own rationale and the adaptive engine's current plan) and the
// hold-to-SOS button.

import React from 'react';
import { View, Switch, Pressable, Animated, Alert, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText as Text } from '../ui/Text';
import { useTheme } from '../../lib/theme';
import { useSpaceGlass } from '../spaces/SpaceGround';
import { currentPlan } from '../../lib/family/presence';
import { locationRationale } from '../../lib/spaces/layout';
import { st } from './hubStyles';
import { tint } from '../../lib/tintColor';

export function HubShareRow({ share, onToggle, locDenied, groupType }: {
  share: boolean;
  onToggle: (v: boolean) => void;
  locDenied: boolean;
  groupType: string | null | undefined;
}) {
  const { colors } = useTheme();
  const plan = share ? currentPlan() : null;
  return (
    <>
      <View style={st.shareRow}>
        {/* flex:1 + shrink so a scaled-up label wraps instead of pushing the
            master sharing Switch past the card edge. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <Ionicons name={share ? 'navigate' : 'navigate-outline'} size={18} color={share ? colors.primary : colors.textDim} />
          <Text style={{ color: colors.text, fontWeight: '600', flexShrink: 1 }}>Share my location</Text>
        </View>
        <Switch value={share} onValueChange={onToggle} accessibilityLabel="Share my location" trackColor={{ true: colors.primary }} />
      </View>
      {/* Explains itself in the SPACE'S OWN TERMS, and only where it matters.
          The old copy said "Location permission is required for Family Circle"
          in every space type — including a school, where a parent needs no
          location at all — and it was an alert on entry rather than a note. */}
      {locDenied && (
        <Text style={{ color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: -4, marginBottom: 10 }}>
          {locationRationale(groupType)}
        </Text>
      )}
      {/* What the adaptive engine is doing right now, in words.
          §71 forbids claiming battery optimisation without measurement — and
          until this line existed there was no way to observe the engine at all
          from a device: expo-location registers through Play Services, so
          `dumpsys location` attributes our interval to com.google.android.gms
          and shows nothing for this app. It also tells a user why their dot
          updates slowly, which is the most common "it's broken" report. */}
      {share && !!plan && (
        <Text style={{ color: colors.textDim, fontSize: 11.5, marginTop: -4, marginBottom: 10 }} numberOfLines={2}>
          {plan.reason} · every {Math.round(plan.timeIntervalMs / 1000)}s
          {plan.publish ? '' : ' · not publishing'}
        </Text>
      )}
    </>
  );
}

/**
 * Hold-to-SOS. The danger wash is deliberate: the one emergency control must
 * not wear the same glass as a settings row. Title in dangerText — raw
 * #EF4444 fails AA at this size on the glass ground (audit-found: the
 * plain-pane version regressed dark mode from 4.95:1 to 4.27).
 */
export function HubSosButton({ progress, onPressIn, onPressOut, onSend }: {
  /** 0 → 1 over the hold; drives the fill. */
  progress: Animated.Value;
  onPressIn: () => void;
  onPressOut: () => void;
  /** Send now — the screen-reader path, after its confirm. */
  onSend: () => void;
}) {
  const { colors, scheme } = useTheme();
  const G = useSpaceGlass();
  return (
    <Pressable
      onPressIn={onPressIn} onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel="Emergency SOS"
      accessibilityHint="Press and hold for one and a half seconds to alert your circle and share your live location. With a screen reader, double-tap to confirm and send."
      // A TalkBack/VoiceOver double-tap cannot perform a 1.5 s hold, so
      // the activate action asks once and sends — the confirm stands in
      // for the hold as the guard against an accidental alarm.
      accessibilityActions={[{ name: 'activate' }, { name: 'longpress' }]}
      onAccessibilityAction={() => Alert.alert('Send SOS?', 'Alert your circle and share your live location.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Send SOS', style: 'destructive', onPress: onSend },
      ])}
      style={[st.sosBig, { borderColor: colors.danger, backgroundColor: tint(colors.danger, scheme === 'dark' ? 0.12 : 0.08) }]}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint(colors.danger, 0.33), transform: [{ scaleX: progress }] }]} />
      <View style={[st.sosIcon, { backgroundColor: colors.danger }]}><Text style={{ fontSize: 20 }}>🆘</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: G.dangerText, fontWeight: '900', fontSize: 15 }}>HOLD FOR SOS</Text>
        <Text style={{ color: colors.textDim, fontSize: 12 }}>Alerts your circle and shares your live location</Text>
      </View>
    </Pressable>
  );
}
