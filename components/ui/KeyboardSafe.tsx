// components/ui/KeyboardSafe.tsx — a screen container the keyboard cannot cover.
//
// Drop-in for the `<KeyboardAvoidingView behavior={Platform.OS === 'ios' ?
// 'padding' : undefined}>` that twenty-three screens were using. That form is
// no avoidance at all on Android, and edge-to-edge defeats the manifest's
// adjustResize, so the keyboard simply sat on top of whatever was at the bottom
// of the screen — on Delete account it covered the confirm button outright.
//
// Padding the container rather than translating it is deliberate: a screen's
// ScrollView then shrinks to the visible area and can scroll its own content
// clear, which is what you want when the keyboard covers half the page. A
// transform would move the whole screen and push the header off the top.
//
// The bottom inset is Math.max(keyboard, safe-area), NOT the sum: an Android
// keyboard is measured to the physical bottom of the display, so the gesture
// bar is already inside it. Adding them floats the content a nav-bar too high.

import React, { useMemo } from 'react';
import { View, StyleSheet, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardInset } from '../../lib/useKeyboardInset';

export interface KeyboardSafeProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Passed straight to the View — live-view uses it for a tap-through overlay. */
  pointerEvents?: ViewProps['pointerEvents'];
  /**
   * Skip the resting safe-area padding and only react to the keyboard. For a
   * screen that already pads its own bottom (a composer bar, a pinned CTA).
   */
  keyboardOnly?: boolean;
}

export function KeyboardSafe({ children, style, keyboardOnly, pointerEvents }: KeyboardSafeProps) {
  const kb = useKeyboardInset();
  const insets = useSafeAreaInsets();
  const paddingBottom = keyboardOnly ? kb : Math.max(kb, insets.bottom);
  const computed = useMemo(() => ({ paddingBottom }), [paddingBottom]);
  return <View style={[styles.fill, style, computed]} pointerEvents={pointerEvents}>{children}</View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

export default KeyboardSafe;
