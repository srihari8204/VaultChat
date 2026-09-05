// components/spaces/SpaceGround.tsx — the shared dusk-glass ground for every
// Space screen: gradient + a soft identity-coloured aura, drawn ONCE behind
// the screen (same mechanics as the finance ice ground — no BlurView, ever;
// concentric fading circles stand in for a radial glow).
//
// The hub passes the active space's groupIdentity() colour so switching
// spaces re-colours the room; sub-screens omit `aura` and get the brand
// lavender — consistent atmosphere without plumbing the registry into every
// detail screen.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SPACE_GLASS, type SpaceGlass } from '../../constants/spaceTheme';
import { useTheme } from '../../lib/theme';

/** The active dusk-glass palette, resolved from the app theme. */
export function useSpaceGlass(): SpaceGlass {
  return SPACE_GLASS[useTheme().scheme];
}

export default function SpaceGround({ aura }: { aura?: string }) {
  const { colors, scheme } = useTheme();
  const G = SPACE_GLASS[scheme];
  const a = aura || colors.primary;
  const [a0, a1, a2] = G.auraAlphas;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={[G.bgTop, G.bgMid, G.bgBottom]} locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[st.aura, { width: 360, height: 360, top: -170, right: -120, backgroundColor: a + a2 }]} />
      <View style={[st.aura, { width: 260, height: 260, top: -120, right: -70, backgroundColor: a + a1 }]} />
      <View style={[st.aura, { width: 170, height: 170, top: -75, right: -25, backgroundColor: a + a0 }]} />
      <View style={[st.aura, { width: 320, height: 320, bottom: -160, left: -130, backgroundColor: a + a2 }]} />
      <View style={[st.aura, { width: 230, height: 230, bottom: -115, left: -85, backgroundColor: a + a1 }]} />
    </View>
  );
}

const st = StyleSheet.create({
  aura: { position: 'absolute', borderRadius: 999 },
});
