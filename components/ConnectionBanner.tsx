// components/ConnectionBanner.tsx — WhatsApp-style connectivity strip.
//
// Surfaces the 3-state socket status (lib/socket useConnectionState) that the
// offline campaign already tracks: a thin "Connecting…" / "Waiting for network"
// bar under the header, hidden while ONLINE. Purely presentational — the store
// is the single source of truth.

import React, { useMemo } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useConnectionState } from '../lib/socket';
import { AuroraLight, STATUS_STRIP_INK, type Palette } from '../constants/theme';
import { useColors, useTheme } from '../lib/theme';

export default function ConnectionBanner() {
  const c = useColors();
  const { scheme } = useTheme();
  const styles = useMemo(() => makeStyles(c), [c]);
  const state = useConnectionState();
  if (state === 'ONLINE') return null;

  const connecting = state === 'CONNECTING';
  const ink = connecting && scheme === 'light' ? c.text : STATUS_STRIP_INK;
  return (
    // Android announces the strip as it appears and changes state.
    <View style={[styles.bar, connecting ? styles.connecting : styles.offline]} accessibilityLiveRegion="polite">
      {connecting && <ActivityIndicator size="small" color={ink} style={styles.spinner} />}
      <Text style={[styles.txt, { color: ink }]}>{connecting ? 'Connecting…' : 'Waiting for network…'}</Text>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 12 },
  connecting: { backgroundColor: c.surfaceSolid },
  // The light theme's danger in both schemes: white 13px text on the dark
  // theme's brighter danger was ~3.8:1, under AA; on this one it is ~6.5:1.
  offline: { backgroundColor: AuroraLight.danger },
  spinner: { marginRight: 8 },
  txt: { color: STATUS_STRIP_INK, fontSize: 13, fontWeight: '600' },
});
