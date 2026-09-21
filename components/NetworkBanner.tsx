import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import type { Palette } from '../constants/theme';
import { useColors, useTheme } from '../lib/theme';

export default function NetworkBanner() {
  const c = useColors();
  const { scheme } = useTheme();
  const s = useMemo(() => makeS(c), [c]);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setOnline(state.isConnected ?? true);
    });
    return unsub;
  }, []);

  if (online) return null;

  return (
    <View style={[s.banner, scheme === 'light' && { backgroundColor: c.danger }]}>
      <Text style={s.txt}>No internet connection</Text>
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  banner: { backgroundColor: '#FF3C6E', paddingVertical: 6, alignItems: 'center' },
  txt: { color: '#fff', fontSize: 12, fontWeight: '800' },
});
