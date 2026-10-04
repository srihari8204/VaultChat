import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { AuroraLight, STATUS_STRIP_INK } from '../constants/theme';

export default function NetworkBanner() {
  const s = useMemo(() => makeS(), []);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setOnline(state.isConnected ?? true);
    });
    return unsub;
  }, []);

  if (online) return null;

  return (
    <View style={s.banner} accessibilityLiveRegion="polite">
      <Text style={s.txt}>No internet connection</Text>
    </View>
  );
}

// The light theme's danger in both schemes: white text on the old #FF3C6E
// was ~3.3:1, under AA; on this one it is ~6.5:1.
const makeS = () => StyleSheet.create({
  banner: { backgroundColor: AuroraLight.danger, paddingVertical: 6, alignItems: 'center' },
  txt: { color: STATUS_STRIP_INK, fontSize: 12, fontWeight: '800' },
});
