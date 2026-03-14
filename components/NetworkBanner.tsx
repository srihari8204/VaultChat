// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NetInfo from '@react-native-community/netinfo';

export default function NetworkBanner() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setOnline(state.isConnected ?? true);
    });
    return unsub;
  }, []);

  if (online) return null;

  return (
    <View style={s.banner}>
      <Text style={s.txt}>No internet connection</Text>
    </View>
  );
}

const s = StyleSheet.create({
  banner: { backgroundColor: '#FF3C6E', paddingVertical: 6, alignItems: 'center' },
  txt:    { color: '#fff', fontSize: 12, fontWeight: '800' },
});