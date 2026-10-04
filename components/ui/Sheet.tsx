// components/ui/Sheet.tsx — bottom action sheet (U4).
//
// A polished, dependency-free replacement for `Alert.alert(...)` used as a menu.
// Slide-up modal with token-styled action rows (icons, destructive style), a
// scrim, and a Cancel. Fires a light haptic on open + on each pick.

import React, { useEffect } from 'react';
import {
  Modal, View, TouchableOpacity, Pressable, StyleSheet, Animated, Platform, ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { RADIUS, SPACING } from '../../constants/theme';
import { GLASS, glassShadow } from '../../constants/glass';
import { useColors, useTheme } from '../../lib/theme';
import { AppText } from './Text';

export interface SheetAction {
  label: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  destructive?: boolean;
  /** The current choice in a picker: shows a check and reports selected state. */
  selected?: boolean;
  onPress: () => void;
}

export interface SheetProps {
  visible: boolean;
  title?: string;
  message?: string;
  actions: SheetAction[];
  onClose: () => void;
}

export function Sheet({ visible, title, message, actions, onClose }: SheetProps) {
  const Aurora = useColors();
  const { scheme } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: winH, width: winW } = useWindowDimensions();
  const sheetWidth = Math.min(600, winW - insets.left - insets.right);
  const slide = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      Animated.spring(slide, { toValue: 1, damping: 22, stiffness: 260, mass: 0.9, useNativeDriver: true }).start();
    } else {
      slide.setValue(0);
    }
  }, [visible, slide]);

  const pick = (a: SheetAction) => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onClose();
    // Let the modal dismiss before running the action (avoids navigation races).
    setTimeout(() => a.onPress(), 10);
  };

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [400, 0] });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss actions" />
      <Animated.View accessibilityViewIsModal style={[styles.sheet, glassShadow('sheet', scheme), { width: sheetWidth, left: insets.left + (winW - insets.left - insets.right - sheetWidth) / 2, maxHeight: winH - insets.top - SPACING.md, backgroundColor: Aurora.glass, borderColor: Aurora.glassStroke, paddingBottom: insets.bottom + SPACING.sm, transform: [{ translateY }] }]}>
        <View style={[styles.handle, { backgroundColor: Aurora.glassStroke }]} />
        <ScrollView style={{ flexShrink: 1 }} bounces={false} showsVerticalScrollIndicator={false}>
          {(title || message) && (
            <View style={[styles.headerBlock, { borderBottomColor: Aurora.separator }]}>
              {title ? <AppText variant="bodyStrong" style={styles.center}>{title}</AppText> : null}
              {message ? <AppText variant="caption" color={Aurora.textDim} style={styles.center}>{message}</AppText> : null}
            </View>
          )}
          {actions.map((a, i) => (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={a.selected === undefined ? undefined : { selected: a.selected }}
              key={i}
              style={[styles.row, { backgroundColor: Aurora.glassSoft, borderColor: Aurora.glassStroke }]}
              onPress={() => pick(a)}
              activeOpacity={0.7}
            >
              {a.icon && <Ionicons name={a.icon} size={20} color={a.destructive ? Aurora.danger : Aurora.text} />}
              <AppText style={{ flex: 1 }} variant="body" color={a.destructive ? Aurora.danger : Aurora.text}>{a.label}</AppText>
              {a.selected && <Ionicons name="checkmark" size={20} color={Aurora.primary} />}
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity accessibilityRole="button" style={[styles.row, styles.cancel, { backgroundColor: Aurora.glassSoft, borderColor: Aurora.glassStroke }]} onPress={onClose} activeOpacity={0.7}>
          <AppText variant="bodyStrong" color={Aurora.textDim}>Cancel</AppText>
        </TouchableOpacity>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', bottom: 0,
    borderTopLeftRadius: RADIUS.xxl, borderTopRightRadius: RADIUS.xxl,
    paddingTop: SPACING.sm, paddingHorizontal: SPACING.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    ...GLASS.sheet.shadow,
  },
  handle: { width: 42, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: SPACING.xs },
  headerBlock: { paddingVertical: SPACING.md, paddingHorizontal: SPACING.md, gap: 4, borderBottomWidth: 1, marginBottom: SPACING.xs },
  center: { textAlign: 'center' },
  row: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: 14, paddingHorizontal: SPACING.md, borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, marginBottom: SPACING.xs },
  cancel: { justifyContent: 'center', marginTop: SPACING.xs },
});

export default Sheet;
