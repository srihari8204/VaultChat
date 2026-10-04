// components/chat/ViewerStack.tsx — Live Chat Viewers UI (feature #58).
//
// A compact avatar stack + count in the chat header ([H][K][A] +2 viewing) that
// opens a "Viewing Now" sheet listing each present viewer with a live activity
// icon (🟢 Reading · ⌨️ Typing · 📎 Uploading). Renders nothing when empty.

import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '../ui/Avatar';
import { useTheme } from '../../lib/theme';
import type { Palette } from '../../constants/theme';
import type { Viewer } from '../../hooks/useChatViewers';

export type ResolvedViewer = { name: string; uri?: string | null; headers?: Record<string, string> };
type Resolve = (userId: string) => ResolvedViewer;

// Colours are palette roles, so the activity text stays readable in both themes.
const ACTIVITY: Record<string, { icon: keyof typeof Ionicons.glyphMap; label: string; color: (c: Palette) => string }> = {
  reading:   { icon: 'eye',                    label: 'Reading',   color: c => c.success },
  typing:    { icon: 'ellipsis-horizontal',    label: 'Typing…',   color: c => c.accentOn },
  uploading: { icon: 'arrow-up-circle',        label: 'Uploading', color: c => c.warning },
};
const act = (a?: string) => ACTIVITY[a || 'reading'] || ACTIVITY.reading;

export function ViewerStack({ viewers, resolve }: { viewers: Viewer[]; resolve: Resolve }) {
  const { colors } = useTheme();
  const S = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  if (!viewers.length) return null;

  const shown = viewers.slice(0, 3);
  const extra = viewers.length - shown.length;

  return (
    <>
      <TouchableOpacity style={S.wrap} onPress={() => setOpen(true)} activeOpacity={0.8} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${viewers.length} viewing now`} accessibilityHint="Shows who is viewing">
        <View style={S.stack}>
          {shown.map((v, i) => {
            const r = resolve(v.userId);
            return (
              <View key={v.userId} style={[S.avatarSlot, { marginLeft: i === 0 ? 0 : -10, zIndex: 10 - i }]}>
                <Avatar uri={r.uri} headers={r.headers} name={r.name} size={22} />
                <View style={[S.dot, { backgroundColor: act(v.activity).color(colors) }]} />
              </View>
            );
          })}
        </View>
        <Text style={S.count}>{extra > 0 ? `+${extra} ` : ''}viewing</Text>
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        {/* The dismiss target is a sibling behind the sheet, not its parent: an
            accessible parent folds the whole sheet into one VoiceOver element. */}
        <View style={S.backdrop} accessibilityViewIsModal>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close viewing now" />
          <View style={[S.sheet, { paddingBottom: 28 + insets.bottom }]}>
            <View style={S.handle} />
            <View style={S.titleRow}>
              <Text style={[S.sheetTitle, { flex: 1 }]}>Viewing now · {viewers.length}</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
                <Ionicons name="close" size={22} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 340 }}>
              {viewers.map(v => {
                const r = resolve(v.userId);
                const a = act(v.activity);
                const tone = a.color(colors);
                return (
                  <View key={v.userId} style={S.row}>
                    <Avatar uri={r.uri} headers={r.headers} name={r.name} size={40} />
                    <Text style={S.name} numberOfLines={1}>{r.name}</Text>
                    <View style={S.activity}>
                      <Ionicons name={a.icon} size={15} color={tone} />
                      <Text style={[S.activityTxt, { color: tone }]}>{a.label}</Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
            <Text style={S.foot}>Live and private — never saved. Hide yours in chat info.</Text>
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stack: { flexDirection: 'row', alignItems: 'center' },
  avatarSlot: { borderWidth: 1.5, borderColor: c.bg, borderRadius: 13 },
  dot: { position: 'absolute', right: -1, bottom: -1, width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: c.bg },
  count: { color: c.textDim, fontSize: 11, fontWeight: '600' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.glassSoft, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 28 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.border, marginBottom: 12 },
  sheetTitle: { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  name: { color: c.text, fontSize: 15, fontWeight: '600', flex: 1 },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  activityTxt: { fontSize: 12, fontWeight: '700' },
  foot: { color: c.textDim, fontSize: 11, marginTop: 12, textAlign: 'center' },
});

export default ViewerStack;
