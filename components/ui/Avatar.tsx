// components/ui/Avatar.tsx — shared avatar primitive (U4).
//
// Image (with auth header) OR name-hashed initials, optional presence dot.
// Replaces the per-screen avatar markup duplicated across chats / contact-info /
// chat header / group-info. Uses expo-image (caching + transition + blurhash-ready).

import React, { useEffect, useState } from 'react';
import { View, StyleSheet, type ViewStyle, type StyleProp } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { avatarColor, avatarRing } from '../../constants/theme';
import { useColors } from '../../lib/theme';
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
  /**
   * Anonymous peer — a chat opened by code where the two people have not both
   * saved each other yet (migration 119). Draws a neutral silhouette instead of
   * an initial.
   *
   * Without this the masked name "Guest" would render as a cheerful "G" in a
   * colour derived from that word, so every anonymous chat would look like the
   * same real person called Guest. A silhouette reads as "not disclosed", which
   * is what is actually true.
   */
  anon?: boolean;
  /**
   * Aurora Glass treatment (U6): a 2px per-contact gradient ring around a dark
   * disc, instead of a filled coloured circle. Identity without giving every
   * list row a solid block of colour to fight the text.
   */
  ring?: boolean;
}

export function Avatar({ uri, headers, name, size = 48, presence, style, anon, ring }: AvatarProps) {
  const c = useColors();
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [uri]);   // retry when the uri changes
  const initial = (name || '?').trim()[0]?.toUpperCase() || '?';
  // With a ring the artwork is inset by the ring width on each side.
  const ringWidth = ring ? Math.max(2, Math.round(size * 0.045)) : 0;
  const inner = size - ringWidth * 2;
  const dim = { width: inner, height: inner, borderRadius: inner / 2 };
  const outer = { width: size, height: size, borderRadius: size / 2 };
  const dotSize = Math.max(10, Math.round(size * 0.28));

  const art = (
    <>
      {anon ? (
        // Ahead of the image branch on purpose: a masked chat must never render
        // a photo even if a stale `uri` is still sitting in a cached list row.
        <View style={[dim, styles.center, { backgroundColor: c.surfaceSolid }]}>
          <Ionicons name="person" size={size * 0.55} color={c.textDim} />
        </View>
      ) : uri && !failed ? (
        <Image
          source={headers ? { uri, headers } : { uri }}
          style={[dim, { backgroundColor: c.surfaceSolid }]}
          contentFit="cover"
          transition={150}
          cachePolicy="memory-disk"          // keep decoded avatars hot → instant re-render on scroll (WhatsApp-like)
          recyclingKey={uri}                 // correct image reuse in recycled list rows
          onError={() => setFailed(true)}   // fall back to initials on a failed load
        />
      ) : (
        // Ringed avatars put the colour in the ring, so the disc stays dark and
        // the initial keeps full contrast against it.
        <View style={[dim, styles.center, { backgroundColor: ring ? c.groundDisc : avatarColor(name || initial) }]}>
          <AppText style={{ fontSize: inner * 0.4, color: '#FFFFFF', fontWeight: '800' }}>{initial}</AppText>
        </View>
      )}
    </>
  );

  const dot = presence === 'online' ? (
    <View style={[styles.dot, { width: dotSize, height: dotSize, borderRadius: dotSize / 2, right: 0, bottom: 0, backgroundColor: c.online, borderColor: c.bg }]} />
  ) : null;

  if (!ring) {
    return <View style={[outer, style]}>{art}{dot}</View>;
  }

  const [from, to] = avatarRing(name || initial);
  return (
    <View style={[outer, style]}>
      <LinearGradient
        colors={[from, to]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[outer, styles.center, { padding: ringWidth }]}
      >
        <View style={[dim, { overflow: 'hidden' }]}>{art}</View>
      </LinearGradient>
      {dot}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', borderWidth: 2 },
});

export default Avatar;
