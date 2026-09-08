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
import { useColors } from '../../lib/theme';
import { AppText } from './Text';

export interface SheetAction {
  label: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  destructive?: boolean;
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
  const insets = useSafeAreaInsets();
  const { height: winH } = useWindowDimensions();
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
      <Pressable style={styles.scrim} onPress={onClose} />
      <Animated.View style={[styles.sheet, { backgroundColor: Aurora.surfaceSolid, borderColor: Aurora.border, paddingBottom: insets.bottom + SPACING.sm, transform: [{ translateY }] }]}>
        {(title || message) && (
          <View style={[styles.headerBlock, { borderBottomColor: Aurora.separator }]}>
            {title ? <AppText variant="bodyStrong" style={styles.center}>{title}</AppText> : null}
            {message ? <AppText variant="caption" color={Aurora.textDim} style={styles.center}>{message}</AppText> : null}
          </View>
        )}
        {/* 60% of the LIVE window, not a static Dimensions.get.
            Dimensions.get returns the current size when it runs, but nothing
            subscribes to it, so a sheet already open when the device rotates
            keeps the height it was built with — in landscape that is taller
            than the screen, and the Cancel row goes off the bottom with no way
            to scroll to it. useWindowDimensions re-renders on the change.
            This is a shared primitive, so the bug was every sheet in the app. */}
        <ScrollView style={{ maxHeight: winH * 0.6 }} bounces={false} showsVerticalScrollIndicator={false}>
          {actions.map((a, i) => (
            <TouchableOpacity key={i} style={styles.row} onPress={() => pick(a)} activeOpacity={0.7}>
              {a.icon && <Ionicons name={a.icon} size={20} color={a.destructive ? Aurora.danger : Aurora.text} />}
              <AppText variant="body" color={a.destructive ? Aurora.danger : Aurora.text}>{a.label}</AppText>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity style={[styles.row, styles.cancel]} onPress={onClose} activeOpacity={0.7}>
          <AppText variant="bodyStrong" color={Aurora.textDim}>Cancel</AppText>
        </TouchableOpacity>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: RADIUS.xxl, borderTopRightRadius: RADIUS.xxl,
    paddingTop: SPACING.sm, paddingHorizontal: SPACING.sm,
    borderTopWidth: 1,
  },
  headerBlock: { paddingVertical: SPACING.md, paddingHorizontal: SPACING.md, gap: 4, borderBottomWidth: 1, marginBottom: SPACING.xs },
  center: { textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, paddingVertical: 15, paddingHorizontal: SPACING.md, borderRadius: RADIUS.md },
  cancel: { justifyContent: 'center', marginTop: SPACING.xs },
});

export default Sheet;
