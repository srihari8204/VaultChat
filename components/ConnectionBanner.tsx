// components/ConnectionBanner.tsx — WhatsApp-style connectivity strip.
//
// Surfaces the 3-state socket status (lib/socket useConnectionState) that the
// offline campaign already tracks: a thin "Connecting…" / "Waiting for network"
// bar under the header, hidden while ONLINE. Purely presentational — the store
// is the single source of truth.

import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useConnectionState } from '../lib/socket';

export default function ConnectionBanner() {
  const state = useConnectionState();
  if (state === 'ONLINE') return null;

  const connecting = state === 'CONNECTING';
  return (
    <View style={[styles.bar, connecting ? styles.connecting : styles.offline]}>
      {connecting && <ActivityIndicator size="small" color="#fff" style={styles.spinner} />}
      <Text style={styles.txt}>{connecting ? 'Connecting…' : 'Waiting for network…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 6, paddingHorizontal: 12 },
  connecting: { backgroundColor: '#8A8D91' },
  offline: { backgroundColor: '#B00020' },
  spinner: { marginRight: 8 },
  txt: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
