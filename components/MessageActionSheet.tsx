/**
 * MessageActionSheet — long-press message context menu (Obsidian Aurora).
 *
 * A bottom sheet (slide-up + backdrop) with a quick-reaction row and a
 * 3-column action grid. Generic + controlled: the caller passes the actions
 * and the reaction handler, so it stays decoupled from chat.tsx's logic.
 * Built on RN Modal + Animated (no @gorhom/bottom-sheet dependency).
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  Animated, Dimensions, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';

export interface SheetAction {
  key: string;
  label: string;
  icon: string;
  onPress: () => void;
  danger?: boolean;
}

const DEFAULT_REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍'];
export function MessageActionSheet({

  visible, onClose, actions, onReact, reactions = DEFAULT_REACTIONS,
}: {
  visible: boolean;
  onClose: () => void;
  actions: SheetAction[];
  onReact?: (emoji: string) => void;
  reactions?: string[];
}) {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const { height: SCREEN_H } = useWindowDimensions();

  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const slide = useRef(new Animated.Value(SCREEN_H)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slide, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slide, backdrop]);

  const close = () => {
    Animated.parallel([
      Animated.timing(slide, { toValue: SCREEN_H, duration: 200, useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 180, useNativeDriver: true }),
    ]).start(() => onClose());
  };

  const fire = (fn: () => void) => { close(); setTimeout(fn, 120); };

  // chunk actions into rows of 3
  const rows: SheetAction[][] = [];
  for (let i = 0; i < actions.length; i += 3) rows.push(actions.slice(i, i + 3));

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
      <Animated.View style={[s.backdrop, { opacity: backdrop }]}>
        <Pressable style={{ flex: 1 }} onPress={close} />
      </Animated.View>

      <Animated.View style={[s.sheet, { transform: [{ translateY: slide }] }]}>
        <View style={s.handle} />

        {/* Quick reactions */}
        {onReact && (
          <View style={s.reactionRow}>
            {reactions.map(e => (
              <TouchableOpacity key={e} style={s.reaction} onPress={() => fire(() => onReact(e))} activeOpacity={0.6}>
                <Text style={s.reactionEmoji}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Action grid */}
        <View style={s.grid}>
          {rows.map((row, ri) => (
            <View key={ri} style={s.gridRow}>
              {row.map(a => (
                <TouchableOpacity key={a.key} style={s.tile} onPress={() => fire(a.onPress)} activeOpacity={0.7}>
                  <Ionicons name={a.icon as any} size={23} color={a.danger ? colors.danger : colors.text} />
                  <Text style={[s.tileLabel, a.danger && { color: colors.danger }]} numberOfLines={1}>{a.label}</Text>
                </TouchableOpacity>
              ))}
              {/* pad the last row so tiles stay left-aligned in a 3-col grid */}
              {row.length < 3 && Array.from({ length: 3 - row.length }).map((_, i) => <View key={`pad${i}`} style={s.tile} />)}
            </View>
          ))}
        </View>
      </Animated.View>
    </Modal>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: c.surfaceSolid, borderTopLeftRadius: 26, borderTopRightRadius: 26,
    paddingHorizontal: 16, paddingTop: 10, paddingBottom: 34,
    borderTopWidth: 1, borderColor: c.glassStroke,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 16 },

  reactionRow: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: c.glassSoft, borderRadius: 18, paddingVertical: 10, paddingHorizontal: 10, marginBottom: 16 },
  reaction: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  reactionEmoji: { fontSize: 26 },

  grid: { gap: 12 },
  gridRow: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, minHeight: 68, borderRadius: 16, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center', gap: 6 },
  tileIcon: { fontSize: 22 },
  tileLabel: { color: c.text, fontSize: 11, fontWeight: '600' },
});

export default MessageActionSheet;
