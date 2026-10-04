// components/InvisibleInk.tsx
// Invisible Ink message — text hidden behind shimmer until phone tilted to ~45°
// Uses device accelerometer to detect tilt angle
// PDF spec: "Tilt phone to 45° to reveal message"

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';
import { Accelerometer } from 'expo-sensors';
import type { Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface InvisibleInkProps {
  text: string;
  isMe: boolean;
}

const TILT_THRESHOLD = 0.55; // ~45° tilt (accelerometer z value)
const REVEAL_DURATION = 300;

export default function InvisibleInk({ text, isMe }: InvisibleInkProps) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  const [revealed, setRevealed] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  // Shimmer animation loop
  useEffect(() => {
    if (revealed) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [revealed, shimmer]);

  // Accelerometer listener
  useEffect(() => {
    if (Platform.OS === 'web') {
      // Web: reveal on click/tap instead (no accelerometer)
      return;
    }

    Accelerometer.setUpdateInterval(100);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      // Calculate tilt angle from z-axis
      // z ≈ 1 when flat, z ≈ 0.7 at 45°, z ≈ 0 when vertical
      const tiltAngle = Math.abs(z);
      if (tiltAngle < TILT_THRESHOLD && !revealed) {
        setRevealed(true);
        Animated.timing(opacity, { toValue: 1, duration: REVEAL_DURATION, useNativeDriver: true }).start();
      }
    });

    return () => sub.remove();
  }, [revealed, opacity]);

  // Web fallback: tap to reveal
  const handlePress = () => {
    if (Platform.OS === 'web' && !revealed) {
      setRevealed(true);
      Animated.timing(opacity, { toValue: 1, duration: REVEAL_DURATION, useNativeDriver: true }).start();
    }
  };

  return (
    <View
      style={[s.container, isMe ? s.containerMe : s.containerPeer]}
      onTouchEnd={handlePress}
    >
      {/* Hidden text (revealed on tilt) */}
      <Animated.Text style={[s.text, isMe ? s.textMe : s.textPeer, { opacity: revealed ? opacity : 0 }]}>
        {text}
      </Animated.Text>

      {/* Overlay shimmer (hidden once revealed) */}
      {!revealed && (
        <Animated.View style={[s.overlay, { opacity: shimmer.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.8] }) }]}>
          <View style={s.shimmerRow}>
            <Text style={s.inkIcon}>{'\u270D\uFE0F'}</Text>
            <Text style={s.inkLabel}>Invisible Ink — tilt to reveal</Text>
          </View>
          {/* Fake text blocks */}
          <View style={s.fakeLines}>
            <View style={[s.fakeLine, { width: '80%' }]} />
            <View style={[s.fakeLine, { width: '60%' }]} />
            <View style={[s.fakeLine, { width: '45%' }]} />
          </View>
        </Animated.View>
      )}

      {/* Revealed indicator */}
      {revealed && (
        <Text style={s.revealedTag}>{'\u270D\uFE0F'} Invisible Ink</Text>
      )}
    </View>
  );
}

const makeS = (c: Palette) => StyleSheet.create({
  container: {
    borderRadius: 16,
    padding: 12,
    minWidth: 180,
    maxWidth: '80%',
    overflow: 'hidden',
  },
  containerMe: {
    backgroundColor: c.primary,
  },
  containerPeer: {
    backgroundColor: c.bg,
  },
  text: {
    fontSize: 15,
    lineHeight: 20,
  },
  textMe: {
    color: c.onPrimary,
  },
  textPeer: {
    color: c.text,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: c.surfaceSolid,
    borderRadius: 16,
    padding: 12,
    justifyContent: 'center',
  },
  shimmerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  inkIcon: {
    fontSize: 14,
  },
  inkLabel: {
    color: c.accentOn,
    fontSize: 11,
    fontWeight: '600',
  },
  fakeLines: {
    gap: 6,
  },
  fakeLine: {
    height: 8,
    backgroundColor: c.surfaceSolid,
    borderRadius: 4,
  },
  revealedTag: {
    color: c.accentOn,
    fontSize: 9,
    marginTop: 4,
    fontWeight: '600',
  },
});
