// app/chat-wallpaper.tsx — Per-Chat Wallpaper (WhatsApp-style).
//
// Default (theme wallpaper), solid colors (bright + dark sets), gradient
// presets, or a photo from the gallery. Live preview with real themed bubbles.
// Saved per chatId in AsyncStorage (falls back to a global default). Theme-aware
// in both light and dark. Consumed by app/chat.tsx via getWallpaper().

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
  ScrollView, Alert, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useNavigation, Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { AuroraBackground } from '../components/ui';
import { permissionDenied } from '../lib/permissionDenied';
import { resolveScoped, SCOPED_DEFAULT } from '../lib/scopedChoice';
import { replacedWallpaperFile } from '../lib/wallpaperFile';


// WhatsApp-style solid wallpapers — a bright row then a dark row. These are
// wallpaper content, not UI colour, so they stay fixed in both themes. The name
// is what a screen reader announces (not the hex code).
const SOLID_COLORS: { hex: string; name: string }[] = [
  { hex: '#ECE5DD', name: 'Classic beige' }, { hex: '#E4DDD3', name: 'Sand' },
  { hex: '#DCEAF5', name: 'Pale blue' },     { hex: '#EAF2E9', name: 'Mint' },
  { hex: '#F5E6E8', name: 'Blush' },         { hex: '#E8EAF0', name: 'Cloud grey' },
  { hex: '#F0E6D8', name: 'Cream' },         { hex: '#E6EEF5', name: 'Ice blue' },
  { hex: '#FFFFFF', name: 'White' },         { hex: '#F6F7F9', name: 'Off-white' },
  { hex: '#0B141A', name: 'Night' },         { hex: '#1F2C34', name: 'Slate' },
  { hex: '#131C21', name: 'Charcoal' },      { hex: '#17212B', name: 'Ink blue' },
  { hex: '#202C33', name: 'Graphite' },      { hex: '#0A0A0F', name: 'Black' },
  { hex: '#102027', name: 'Deep teal' },     { hex: '#1A1A2E', name: 'Midnight blue' },
  { hex: '#0B3D2E', name: 'Forest green' },  { hex: '#075E54', name: 'Teal green' },
];

const GRADIENT_PRESETS = [
  { id: 'midnight',  name: 'Midnight',  colors: ['#0a0a2e', '#1a1a4e'] },
  { id: 'ocean',     name: 'Ocean',     colors: ['#001427', '#003459'] },
  { id: 'forest',    name: 'Forest',    colors: ['#0b1a0b', '#1a3a1a'] },
  { id: 'teal',      name: 'Teal',      colors: ['#053b34', '#0b6b5b'] },
  { id: 'sunset',    name: 'Sunset',    colors: ['#1a0a2e', '#2d1b4e', '#4a1942'] },
  { id: 'arctic',    name: 'Arctic',    colors: ['#0a1628', '#0d2137'] },
  { id: 'ember',     name: 'Ember',     colors: ['#1a0a00', '#2a1500'] },
  { id: 'steel',     name: 'Steel',     colors: ['#0e1117', '#1a1e25'] },
  { id: 'dawn',      name: 'Dawn',      colors: ['#dfe9f3', '#ffffff'] },
];

export interface WallpaperConfig {
  type: 'solid' | 'gradient' | 'image';
  value: string;         // hex for solid, preset id for gradient, uri for image
  colors?: string[];     // gradient colors
}

// Read the saved wallpaper for a chat (falls back to the global default).
// Returns null = "default", so app/chat.tsx paints the theme's chat background.
export async function getWallpaper(chatId: string): Promise<WallpaperConfig | null> {
  try {
    // A per-chat SCOPED_DEFAULT means "app default" even when a global
    // wallpaper is set (lib/scopedChoice.ts).
    const raw = resolveScoped(
      await AsyncStorage.getItem(`vc_wallpaper_${chatId}`),
      await AsyncStorage.getItem('vc_wallpaper_default'),
    );
    return raw ? JSON.parse(raw) as WallpaperConfig : null;
  } catch { return null; }
}

type Tab = 'solid' | 'gradient' | 'custom';

// The live preview behind the sample bubbles. Module scope, so the Image /
// LinearGradient are not remounted on every render of the screen.
function PreviewBg({ selected, fallbackBg, boxStyle, children }: {
  selected: WallpaperConfig | null; fallbackBg: string; boxStyle: object; children: React.ReactNode;
}) {
  if (selected?.type === 'image') {
    return (
      <View style={boxStyle}>
        <Image source={{ uri: selected.value }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
        {children}
      </View>
    );
  }
  if (selected?.type === 'gradient' && selected.colors) {
    return <LinearGradient colors={selected.colors as [string, string, ...string[]]} style={boxStyle}>{children}</LinearGradient>;
  }
  const bg = selected?.type === 'solid' ? selected.value : fallbackBg;
  return <View style={[boxStyle, { backgroundColor: bg }]}>{children}</View>;
}

export default function ChatWallpaperScreen() {
  // Reactive size, so the tile grid follows rotation.
  const {width: SW} = useWindowDimensions();

  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors, SW), [colors, SW]);
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const storageKey = `vc_wallpaper_${chatId || 'default'}`;

  // null = default (theme wallpaper)
  const [selected, setSelected] = useState<WallpaperConfig | null>(null);
  const [tab, setTab] = useState<Tab>('solid');
  // What is stored now, to tell an unsaved change from the saved choice.
  const [savedJson, setSavedJson] = useState('null');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // A pick made before the initial read resolves wins over that read.
  const touched = useRef(false);
  const pick = (w: WallpaperConfig | null) => { touched.current = true; setSelected(w); };

  useEffect(() => {
    touched.current = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        const loaded: WallpaperConfig | null = raw && raw !== SCOPED_DEFAULT ? JSON.parse(raw) : null;
        setSavedJson(JSON.stringify(loaded));
        if (!touched.current) setSelected(loaded);
      } catch { /* keep default */ }
    })();
  }, [storageKey]);

  // Same model as everywhere else that edits before saving: leaving with an
  // unsaved pick (header back, hardware back, swipe) asks first.
  const dirty = JSON.stringify(selected) !== savedJson;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const leaving = useRef(false);
  const navigation = useNavigation();
  useEffect(() => navigation.addListener('beforeRemove', (ev) => {
    // beforeRemove is preventable at runtime; the generic navigation type says otherwise.
    const e = ev as typeof ev & { preventDefault(): void };
    if (leaving.current || !dirtyRef.current) return;
    e.preventDefault();
    Alert.alert('Discard wallpaper change?', 'Tap "Set wallpaper" to keep it.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);

  const save = async () => {
    // A double tap would copy the photo twice and orphan one copy.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const dir = FileSystem.documentDirectory ? FileSystem.documentDirectory + 'wallpapers/' : '';
    let copied: string | null = null;
    try {
      let toSave = selected;
      // The picker returns a cache URI the OS may evict; keep our own copy.
      if (toSave?.type === 'image' && dir && FileSystem.documentDirectory
          && !toSave.value.startsWith(FileSystem.documentDirectory)) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const dest = `${dir}${chatId || 'default'}_${Date.now()}.jpg`;
        await FileSystem.copyAsync({ from: toSave.value, to: dest });
        copied = dest;
        toSave = { ...toSave, value: dest };
      }
      const prevRaw = await AsyncStorage.getItem(storageKey).catch(() => null);
      if (toSave) await AsyncStorage.setItem(storageKey, JSON.stringify(toSave));
      // Per-chat Default must beat a global wallpaper, so it is stored, not removed.
      else if (chatId) await AsyncStorage.setItem(storageKey, SCOPED_DEFAULT);
      else await AsyncStorage.removeItem(storageKey);
      // Only once the new choice is stored: drop the photo copy it replaced,
      // or every change leaves another full-size file in documents.
      const stale = replacedWallpaperFile(prevRaw, toSave?.type === 'image' ? toSave.value : null, dir);
      if (stale) FileSystem.deleteAsync(stale, { idempotent: true }).catch(() => {});
      leaving.current = true;
      router.back();
    } catch {
      // Not stored: the fresh copy is referenced by nothing.
      if (copied) FileSystem.deleteAsync(copied, { idempotent: true }).catch(() => {});
      Alert.alert('Error', 'Failed to save wallpaper.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reset = () => pick(null);

  const pickImage = async () => {
    try {
      const { status, canAskAgain } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        permissionDenied('Permission required', 'Allow access to your photos to set a custom wallpaper.', canAskAgain);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [9, 16], quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        pick({ type: 'image', value: result.assets[0].uri });
      }
    } catch (e: any) {
      Alert.alert('Could not open your photos', e?.message ?? 'Try again.');
    }
  };

  const isDefault = !selected;

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">{chatId ? 'Wallpaper · this chat' : 'Wallpaper · all chats'}</Text>
        <TouchableOpacity onPress={reset} style={s.resetBtn} accessibilityRole="button" accessibilityLabel="Reset to default wallpaper"><Text style={s.resetText}>Reset</Text></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Preview */}
        <PreviewBg selected={selected} fallbackBg={colors.chatBg} boxStyle={s.previewBox}>
          <View style={s.sampleBubbles}>
            <View style={[s.peerBubble, { backgroundColor: colors.bubbleIn }]}>
              <Text style={[s.bubbleText, { color: colors.bubbleInText }]}>Hey, how are you?</Text>
              <Text style={[s.bubbleTime, { color: colors.bubbleMetaIn }]}>10:30</Text>
            </View>
            <View style={[s.myBubble, { backgroundColor: colors.bubbleOut }]}>
              <Text style={[s.bubbleText, { color: colors.bubbleOutText }]}>Great! Love this wallpaper 🎨</Text>
              <Text style={[s.bubbleTime, { color: colors.bubbleMetaOut }]}>10:32 ✓✓</Text>
            </View>
          </View>
        </PreviewBg>

        {/* Tabs */}
        <View style={s.tabs}>
          {(['solid', 'gradient', 'custom'] as const).map(t => (
            <TouchableOpacity key={t} style={[s.tab, tab === t && s.tabActive]} onPress={() => setTab(t)} activeOpacity={0.8} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}>
              <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                {t === 'solid' ? 'Colors' : t === 'gradient' ? 'Gradients' : 'My photo'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'solid' && (
          <View style={s.colorGrid}>
            {/* Default tile */}
            <TouchableOpacity
              onPress={reset}
              style={[s.colorTile, { backgroundColor: colors.chatBg }, isDefault && s.tileSelected]}
              accessibilityRole="radio"
              accessibilityLabel="Default wallpaper"
              accessibilityState={{ checked: isDefault }}
            >
              {isDefault
                ? <Ionicons name="checkmark" size={18} color={colors.primary} />
                : <Text style={[s.defaultTileTxt, { color: colors.textDim }]}>Default</Text>}
            </TouchableOpacity>
            {SOLID_COLORS.map(({ hex, name }) => {
              const on = selected?.type === 'solid' && selected.value === hex;
              return (
                <TouchableOpacity accessibilityRole="radio" accessibilityLabel={`${name} wallpaper`} accessibilityState={{ checked: on }}
                  key={hex}
                  onPress={() => pick({ type: 'solid', value: hex })}
                  style={[s.colorTile, { backgroundColor: hex }, on && s.tileSelected]}
                >
                  {on && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {tab === 'gradient' && (
          <View style={s.gradientGrid}>
            {GRADIENT_PRESETS.map(g => {
              const on = selected?.type === 'gradient' && selected.value === g.id;
              return (
                <TouchableOpacity key={g.id} onPress={() => pick({ type: 'gradient', value: g.id, colors: g.colors })} activeOpacity={0.8} accessibilityRole="radio" accessibilityLabel={`${g.name} gradient`} accessibilityState={{ checked: on }}>
                  <LinearGradient colors={g.colors as [string, string, ...string[]]} style={[s.gradientTile, on && s.tileSelected]}>
                    {on && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
                  </LinearGradient>
                  <Text numberOfLines={1} style={s.gradientLabel}>{g.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {tab === 'custom' && (
          <View>
            <TouchableOpacity style={s.customPickBtn} activeOpacity={0.8} onPress={pickImage} accessibilityRole="button" accessibilityLabel="Choose a photo from the gallery">
              <Ionicons name="image-outline" size={28} color={colors.primary} />
              <Text style={s.customPickText}>Choose from gallery</Text>
              <Text style={s.customPickSub}>Pick a photo to use as the chat wallpaper</Text>
            </TouchableOpacity>
            {selected?.type === 'image' && (
              <View style={{ marginTop: 12 }}>
                <Image source={{ uri: selected.value }} style={s.customImage} resizeMode="cover" accessibilityIgnoresInvertColors accessible accessibilityLabel="Selected wallpaper photo" />
                <View style={s.customCheckRow}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                  <Text style={[s.customCheckText, { color: colors.success }]}>Photo selected</Text>
                </View>
              </View>
            )}
          </View>
        )}

        <TouchableOpacity activeOpacity={0.85} onPress={save} disabled={saving} style={[s.setBtn, saving && { opacity: 0.6 }]} accessibilityRole="button" accessibilityState={{ disabled: saving, busy: saving }}>
          <Text style={s.setBtnText}>{saving ? 'Saving…' : 'Set wallpaper'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// Width/height are threaded in from useWindowDimensions() rather than read
// from a module-level Dimensions.get(): orientation is 'default', so a frozen
// value survived rotation, folds and split-screen resizes.
const makeStyles = (c: Palette, SW: number) => {
  // Derived from the LIVE width, so a rotation re-sizes the tiles. These were
  // module-level consts computed from a frozen Dimensions.get().
  const COLOR_SIZE = (SW - 32 - 4 * 12) / 5;
  const PRESET_W = (SW - 32 - 16) / 3;
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: c.text, fontSize: 18, fontWeight: '700' },
  resetBtn: { minHeight: 44, justifyContent: 'center' },
  resetText: { color: c.primary, fontSize: 14, fontWeight: '700', paddingHorizontal: 8 },

  previewBox: { minHeight: 200, borderRadius: 16, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, justifyContent: 'flex-end', marginBottom: 18 },
  sampleBubbles: { padding: 12 },
  peerBubble: { alignSelf: 'flex-start', borderRadius: 14, borderTopLeftRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8, maxWidth: '78%' },
  myBubble: { alignSelf: 'flex-end', borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '78%' },
  bubbleText: { fontSize: 14, lineHeight: 19 },
  bubbleTime: { fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },

  tabs: { flexDirection: 'row', backgroundColor: c.glassSoft, borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, minHeight: 44, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  tabActive: { backgroundColor: c.primary },
  tabText: { color: c.textDim, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: c.bubbleOutText },

  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  colorTile: { width: COLOR_SIZE, height: COLOR_SIZE, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, justifyContent: 'center', alignItems: 'center' },
  tileSelected: { borderWidth: 2.5, borderColor: c.primary },
  defaultTileTxt: { fontSize: 9, fontWeight: '700' },

  gradientGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gradientTile: { width: PRESET_W, height: PRESET_W * 1.25, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  gradientLabel: { color: c.textDim, fontSize: 11, fontWeight: '600', marginTop: 4, textAlign: 'center', width: PRESET_W },

  customPickBtn: { backgroundColor: c.glassSoft, borderRadius: 14, borderWidth: 1, borderColor: c.glassStroke, borderStyle: 'dashed', padding: 24, alignItems: 'center', gap: 8 },
  customPickText: { color: c.primary, fontSize: 16, fontWeight: '700' },
  customPickSub: { color: c.textDim, fontSize: 13, textAlign: 'center' },
  customImage: { width: '100%', height: 200, borderRadius: 12 },
  customCheckRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  customCheckText: { fontSize: 13, fontWeight: '600' },

  setBtn: { backgroundColor: c.primary, borderRadius: 26, paddingVertical: 15, alignItems: 'center', marginTop: 24 },
  setBtnText: { color: c.bubbleOutText, fontSize: 16, fontWeight: '800' },
});
}
