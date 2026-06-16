// components/ui/Avatar.tsx — shared avatar primitive (U4).
//
// Image (with auth header) OR name-hashed initials, optional presence dot.
// Replaces the per-screen avatar markup duplicated across chats / contact-info /
// chat header / group-info. Uses expo-image (caching + transition + blurhash-ready).

import React from 'react';
import { View, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { Image } from 'expo-image';
import { Aurora, avatarColor } from '../../constants/theme';
import { AppText } from './Text';

export interface AvatarProps {
  /** Remote image URL (auth-gated /uploads etc). Falls back to initials if absent. */
  uri?: string | null;
  headers?: Record<string, string>;
  /** Display name — drives the initial + the deterministic background color. */
  name?: string | null;
  size?: number;
  /** Show a presence dot when 'online'. */
  presence?: 'online' | 'offline' | null;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({ uri, headers, name, size = 48, presence, style }: AvatarProps) {
  const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
  const dim = { width: size, height: size, borderRadius: size / 2 };
  const dotSize = Math.max(10, Math.round(size * 0.28));
  return (
    <View style={[dim, style]}>
      {uri ? (
        <Image
          source={headers ? { uri, headers } : { uri }}
          style={[dim, styles.img]}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View style={[dim, styles.center, { backgroundColor: avatarColor(name || initial) }]}>
          <AppText style={{ fontSize: size * 0.4, color: '#04130D', fontWeight: '800' }}>{initial}</AppText>
        </View>
      )}
      {presence === 'online' && (
        <View style={[styles.dot, { width: dotSize, height: dotSize, borderRadius: dotSize / 2, right: 0, bottom: 0 }]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  img: { backgroundColor: Aurora.surfaceSolid },
  center: { alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', backgroundColor: Aurora.online, borderWidth: 2, borderColor: Aurora.bg },
});

export default Avatar;
