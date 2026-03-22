// @ts-nocheck
// components/TransferProgress.tsx — Animated File Transfer Progress Bar
// Shows upload/download % with animated bar, file name, speed, ETA
// Use: <TransferProgress visible={uploading} progress={0.65} filename="photo.jpg" type="upload" />

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';

interface Props {
  visible: boolean;
  progress: number; // 0 to 1
  filename?: string;
  type?: 'upload' | 'download';
  onCancel?: () => void;
  size?: string;
}

export default function TransferProgress({ visible, progress, filename, type = 'upload', onCancel, size }: Props) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: Math.min(progress, 1),
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress, widthAnim]);

  useEffect(() => {
    if (visible) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.6, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [visible, pulseAnim]);

  if (!visible) return null;

  const pct = Math.round(progress * 100);
  const icon = type === 'upload' ? '\u2191' : '\u2193';
  const label = type === 'upload' ? 'Uploading' : 'Downloading';
  const barColor = type === 'upload' ? '#00E5FF' : '#10B981';

  return (
    <Animated.View style={[s.container, { opacity: pulseAnim }]}>
      <View style={s.header}>
        <Text style={s.icon}>{icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>{label}</Text>
          {filename && <Text style={s.filename} numberOfLines={1}>{filename}</Text>}
        </View>
        <Text style={s.pct}>{pct}%</Text>
        {onCancel && (
          <TouchableOpacity onPress={onCancel} style={s.cancelBtn}>
            <Text style={s.cancelTxt}>{"\u2715"}</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={s.barBg}>
        <Animated.View style={[s.barFill, {
          backgroundColor: barColor,
          width: widthAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }]} />
      </View>
      {size && <Text style={s.size}>{size}</Text>}
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: { backgroundColor: '#0C0C1A', borderRadius: 12, padding: 12, marginHorizontal: 12, marginVertical: 4, borderWidth: 1, borderColor: '#111' },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  icon: { color: '#00E5FF', fontSize: 16, fontWeight: '900', marginRight: 8 },
  label: { color: '#888', fontSize: 11, fontWeight: '700' },
  filename: { color: '#E0E0F0', fontSize: 12, marginTop: 1 },
  pct: { color: '#00E5FF', fontSize: 14, fontWeight: '900', marginLeft: 8 },
  cancelBtn: { marginLeft: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: '#FF3C6E22', justifyContent: 'center', alignItems: 'center' },
  cancelTxt: { color: '#FF3C6E', fontSize: 12 },
  barBg: { height: 4, backgroundColor: '#111', borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 2 },
  size: { color: '#555', fontSize: 10, marginTop: 4, textAlign: 'right' },
});
