// components/ui/GlassView.tsx — the ONE translucent surface primitive (U6).
//
// Aurora Glass spends real blur only on chrome that floats over moving content:
// the tab bar, the chat header, the composer, and bottom sheets. Everything
// else — rows, cards, chips — is flat. That rule is the whole reason the list
// still scrolls at 60fps: a blur pass per row is what makes glassmorphism feel
// cheap and look muddy.
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
import { useColors, useTheme } from '../../lib/theme';

export interface GlassViewProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 0-100. Chrome sitting on busy content wants more; a chip wants less. */
  intensity?: number;
  /** Draw the 1px translucent edge that reads as the lip of the glass. */
  bordered?: boolean;
  /** Force the opaque fallback (low-end devices, or when blur is not wanted). */
  blurDisabled?: boolean;
}

export function GlassView({
  children,
  style,
  intensity = 40,
  bordered = true,
  blurDisabled = false,
}: GlassViewProps) {
  const c = useColors();
  const { scheme } = useTheme();
  const edge = bordered ? { borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke } : null;

  if (blurDisabled) {
    // Opaque fallback: the same surface colour the blur would average to.
    return <View style={[{ backgroundColor: c.surfaceSolid }, edge, style]}>{children}</View>;
  }

  return (
    <BlurView
      intensity={intensity}
      tint={scheme === 'light' ? 'light' : 'dark'}
      experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
      style={[{ overflow: 'hidden', backgroundColor: c.glass }, edge, style]}
    >
      {children}
    </BlurView>
  );
}

export default GlassView;
