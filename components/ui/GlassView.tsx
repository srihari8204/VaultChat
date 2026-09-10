// components/ui/GlassView.tsx — the ONE translucent surface primitive (U6, U8).
//
// Aurora Glass spends real blur only on chrome that floats over moving content:
// the tab bar, the chat header, the composer, and bottom sheets. Everything
// else — rows, cards, chips — is flat. That rule is the whole reason the list
// still scrolls at 60fps: a blur pass per row is what makes glassmorphism feel
// cheap and look muddy.
//
// U8 adds the two things the Figma effect styles (Glass/Chrome, Glass/Card,
// Glass/Chip, Glass/Sheet) carry that this view did not:
//
//   `kind`      — the surface CLASS. Picks the blur intensity, default radius
//                 and lip strength from constants/glass, so a screen says what
//                 the surface IS instead of guessing a number.
//   `highlight` — the LIP: a 1px gradient along the top edge, the light
//                 catching the pane. One LinearGradient, absolutely positioned,
//                 no extra blur pass. It is what makes a translucent rectangle
//                 read as glass rather than as a grey wash.
//
// ANDROID
// -------
// expo-blur only performs a genuine backdrop blur on Android when
// `experimentalBlurMethod="dimezisBlurView"` is set; without it the view falls
// back to a flat translucent wash. We opt in on Android and leave iOS on the
// native path. `blurDisabled` is the escape hatch for low-end devices — the
// surface degrades to an opaque tint that still meets contrast.

import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors, useTheme } from '../../lib/theme';
import { GLASS, lipGradient, lipPeak, type GlassKind } from '../../constants/glass';

export interface GlassViewProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Surface class — sets the default blur intensity, radius and lip. */
  kind?: GlassKind;
  /** 0-100. Overrides the class default. Chrome on busy content wants more; a chip wants less. */
  intensity?: number;
  /** Draw the 1px translucent edge that reads as the rim of the glass. */
  bordered?: boolean;
  /** Draw the lip highlight along the top edge. */
  highlight?: boolean;
  /** Quieter fill (`glassSoft`) for inline surfaces — fields, search pills. */
  soft?: boolean;
  /** Force the opaque fallback (low-end devices, or when blur is not wanted). */
  blurDisabled?: boolean;
}

export function GlassView({
  children,
  style,
  kind = 'chrome',
  intensity,
  bordered = true,
  highlight = false,
  soft = false,
  blurDisabled = false,
}: GlassViewProps) {
  const c = useColors();
  const { scheme } = useTheme();
  const recipe = GLASS[kind];
  const edge = bordered ? { borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke } : null;
  const lip = highlight
    ? <Lip radius={radiusOf(style) ?? recipe.radius} peak={lipPeak(kind, scheme)} />
    : null;

  if (blurDisabled) {
    // Opaque fallback: the same surface colour the blur would average to.
    return (
      <View style={[{ overflow: 'hidden', backgroundColor: c.surfaceSolid }, edge, style]}>
        {children}
        {lip}
      </View>
    );
  }

  return (
    <BlurView
      intensity={intensity ?? recipe.intensity}
      tint={scheme === 'light' ? 'light' : 'dark'}
      experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
      style={[{ overflow: 'hidden', backgroundColor: soft ? c.glassSoft : c.glass }, edge, style]}
    >
      {children}
      {lip}
    </BlurView>
  );
}

/**
 * The corner radius the caller styled the surface with, so the lip can start
 * past the curve instead of poking out of it. Falls back to the class default.
 */
function radiusOf(style: StyleProp<ViewStyle>): number | undefined {
  const flat = StyleSheet.flatten(style);
  const r = flat?.borderRadius ?? flat?.borderTopLeftRadius;
  return typeof r === 'number' ? r : undefined;
}

function Lip({ radius, peak }: { radius: number; peak: number }) {
  // A pill's curve is half its height; insetting by the full radius would
  // leave nothing on a 36pt chip, so cap the inset.
  const inset = Math.min(radius, 40);
  return (
    <LinearGradient
      pointerEvents="none"
      colors={lipGradient(peak)}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={[styles.lip, { left: inset, right: inset }]}
    />
  );
}

const styles = StyleSheet.create({
  lip: { position: 'absolute', top: 0, height: 1 },
});

export default GlassView;
