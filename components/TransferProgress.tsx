// components/TransferProgress.tsx — Animated File Transfer Progress Bar
// Shows upload/download % with animated bar, file name, speed, ETA
// Use: <TransferProgress visible={uploading} progress={0.65} filename="photo.jpg" type="upload" />

import { BRAND_ACCENT } from '../constants/theme';
import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface Props {
  visible: boolean;
  progress: number; // 0 to 1
  filename?: string;
  type?: 'upload' | 'download';
  onCancel?: () => void;
  size?: string;
}

export default function TransferProgress({ visible, progress, filename, type = 'upload', onCancel, size }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
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
  const icon = type === 'upload' ? 'arrow-up' : 'arrow-down';
  const label = type === 'upload' ? 'Uploading' : 'Downloading';
  const barColor = type === 'upload' ? c.accentOn : BRAND_ACCENT;

  return (
    <Animated.View style={[s.container, { opacity: pulseAnim }]}>
      <View style={s.header}>
        <Ionicons name={icon} size={16} color={c.accentOn} style={s.icon} />
        <View style={s.flex}>
          <Text style={s.label}>{label}</Text>
          {filename && <Text style={s.filename} numberOfLines={1}>{filename}</Text>}
        </View>
        <Text style={s.pct}>{pct}%</Text>
        {onCancel && (
          <TouchableOpacity hitSlop={10} onPress={onCancel} style={s.cancelBtn}
            accessibilityRole="button" accessibilityLabel={`Cancel ${label.toLowerCase()}`}>
            <Ionicons name="close" size={12} color={c.danger} />
          </TouchableOpacity>
        )}
      </View>
      {/* The bar carries the progress semantics; the container is not one
          element, so the Cancel button inside it stays reachable. */}
      <View style={s.barBg} accessible accessibilityRole="progressbar"
        accessibilityLabel={`${label}${filename ? ` ${filename}` : ''}`}
        accessibilityValue={{ min: 0, max: 100, now: pct }}>
        <Animated.View style={[s.barFill, {
          backgroundColor: barColor,
          width: widthAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        }]} />
      </View>
      {size && <Text style={s.size}>{size}</Text>}
    </Animated.View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  container: { backgroundColor: c.bg, borderRadius: 12, padding: 12, marginHorizontal: 12, marginVertical: 4, borderWidth: 1, borderColor: c.glassStroke },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  icon: { marginRight: 8 },
  flex: { flex: 1 },
  label: { color: c.textDim, fontSize: 11, fontWeight: '700' },
  filename: { color: c.text, fontSize: 12, marginTop: 1 },
  pct: { color: c.accentOn, fontSize: 14, fontWeight: '900', marginLeft: 8 },
  cancelBtn: { marginLeft: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center' },
  barBg: { height: 4, backgroundColor: c.bg, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 2 },
  size: { color: c.textDim, fontSize: 10, marginTop: 4, textAlign: 'right' },
});
