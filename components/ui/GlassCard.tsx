// components/ui/GlassCard.tsx — the glass card (U8). Figma: Glass/Card.
//
// The recipe most screens actually want: translucent fill, hairline rim, lip
// highlight, soft shadow — and NO blur pass by default. A blur per card in a
// scrolling list is exactly the cost the Aurora Glass rule forbids (see
// GlassView). `blur` opts a single hero card in: Profile's security score sits
// alone on the aurora ground, so it can afford one.
//
// Replaces the ad-hoc "glassSoft + glassStroke + radius 20" cards screens kept
// re-deriving; `Card` (U4) stays for callers that want the plain version.

import React from 'react';
import { StyleSheet, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { GLASS, GLOW, lipGradient, lipPeak, type GlowKind } from '../../constants/glass';
import { SPACING } from '../../constants/theme';
import { useColors, useTheme } from '../../lib/theme';
import { GlassView } from './GlassView';

export interface GlassCardProps {
  children: React.ReactNode;
  onPress?: () => void;
  padded?: boolean;
  /** Real backdrop blur — one hero card per screen, never a list row. */
  blur?: boolean;
  /** Coloured glow under the card (a highlighted or selected card). */
  glow?: GlowKind;
  /** Lip highlight along the top edge (default on). */
  highlight?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function GlassCard({
  children, onPress, padded = true, blur = false, glow, highlight = true, style, testID,
}: GlassCardProps) {
  const c = useColors();
  const { scheme } = useTheme();
  const recipe = GLASS.card;
  // Shadow lives on the OUTER view: the surface clips (overflow hidden) so the
  // lip and children stay inside the curve, and a clipped view cannot cast.
  const outer = [styles.outer, { borderRadius: recipe.radius }, glow ? GLOW[glow] : recipe.shadow, style];

  const body = blur ? (
    <GlassView kind="card" highlight={highlight} style={[styles.surface, { borderRadius: recipe.radius }, padded && styles.padded]}>
      {children}
    </GlassView>
  ) : (
    <View
      style={[
        styles.surface,
        { borderRadius: recipe.radius, backgroundColor: c.glass, borderColor: c.glassStroke, borderWidth: StyleSheet.hairlineWidth },
        padded && styles.padded,
      ]}
    >
      {children}
      {highlight && (
        <LinearGradient
          pointerEvents="none"
          colors={lipGradient(lipPeak('card', scheme))}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.lip, { left: recipe.radius, right: recipe.radius }]}
        />
      )}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={outer} testID={testID}>
        {body}
      </TouchableOpacity>
    );
  }
  return <View style={outer} testID={testID}>{body}</View>;
}

const styles = StyleSheet.create({
  outer: {},
  surface: { overflow: 'hidden' },
  padded: { padding: SPACING.lg },
  lip: { position: 'absolute', top: 0, height: 1 },
});

export default GlassCard;
