// app/chat-wallpaper.tsx — Per-Chat Wallpaper (WhatsApp-style).
//
// Default (theme wallpaper), solid colors (bright + dark sets), gradient
// presets, or a photo from the gallery. Live preview with real themed bubbles.
// Saved per chatId in AsyncStorage (falls back to a global default). Theme-aware
// in both light and dark. Consumed by app/chat.tsx via getWallpaper().

import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
  ScrollView, Dimensions, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

const { width: SW } = Dimensions.get('window');
const COLOR_SIZE = (SW - 32 - 4 * 12) / 5;
const PRESET_W = (SW - 32 - 16) / 3;

// WhatsApp-style solid wallpapers — a bright row then a dark row.
const SOLID_COLORS = [
  '#ECE5DD', '#E4DDD3', '#DCEAF5', '#EAF2E9', '#F5E6E8',
  '#E8EAF0', '#F0E6D8', '#E6EEF5', '#FFFFFF', '#F6F7F9',
  '#0B141A', '#1F2C34', '#131C21', '#17212B', '#202C33',
  '#0A0A0F', '#102027', '#1A1A2E', '#0B3D2E', '#075E54',
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
    const raw = (await AsyncStorage.getItem(`vc_wallpaper_${chatId}`))
      || (await AsyncStorage.getItem('vc_wallpaper_default'));
    return raw ? JSON.parse(raw) as WallpaperConfig : null;
  } catch { return null; }
}

type Tab = 'solid' | 'gradient' | 'custom';

export default function ChatWallpaperScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const storageKey = `vc_wallpaper_${chatId || 'default'}`;

  // null = default (theme wallpaper)
  const [selected, setSelected] = useState<WallpaperConfig | null>(null);
  const [tab, setTab] = useState<Tab>('solid');

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        setSelected(raw ? JSON.parse(raw) : null);
      } catch { /* keep default */ }
    })();
  }, [storageKey]);

  const save = async () => {
    try {
      if (selected) await AsyncStorage.setItem(storageKey, JSON.stringify(selected));
      else await AsyncStorage.removeItem(storageKey);
      router.back();
    } catch { Alert.alert('Error', 'Failed to save wallpaper.'); }
  };

  const reset = () => setSelected(null);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Allow access to your photos to set a custom wallpaper.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true, aspect: [9, 16], quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setSelected({ type: 'image', value: result.assets[0].uri });
    }
  };

  const isDefault = !selected;

  const PreviewBg = ({ children }: { children: React.ReactNode }) => {
    if (selected?.type === 'image') {
      return (
        <View style={s.previewBox}>
          <Image source={{ uri: selected.value }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />
          {children}
        </View>
      );
    }
    if (selected?.type === 'gradient' && selected.colors) {
      return <LinearGradient colors={selected.colors as [string, string, ...string[]]} style={s.previewBox}>{children}</LinearGradient>;
    }
    const bg = selected?.type === 'solid' ? selected.value : colors.chatBg;
    return <View style={[s.previewBox, { backgroundColor: bg }]}>{children}</View>;
  };

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Wallpaper</Text>
        <TouchableOpacity onPress={reset} hitSlop={8}><Text style={s.resetText}>Reset</Text></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Preview */}
        <PreviewBg>
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
            <TouchableOpacity key={t} style={[s.tab, tab === t && s.tabActive]} onPress={() => setTab(t)} activeOpacity={0.8}>
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
            >
              {isDefault
                ? <Ionicons name="checkmark" size={18} color={colors.primary} />
                : <Text style={[s.defaultTileTxt, { color: colors.textDim }]}>Default</Text>}
            </TouchableOpacity>
            {SOLID_COLORS.map((color, i) => {
              const on = selected?.type === 'solid' && selected.value === color;
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => setSelected({ type: 'solid', value: color })}
                  style={[s.colorTile, { backgroundColor: color }, on && s.tileSelected]}
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
                <TouchableOpacity key={g.id} onPress={() => setSelected({ type: 'gradient', value: g.id, colors: g.colors })} activeOpacity={0.8}>
                  <LinearGradient colors={g.colors as [string, string, ...string[]]} style={[s.gradientTile, on && s.tileSelected]}>
                    {on && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
                  </LinearGradient>
                  <Text style={s.gradientLabel}>{g.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {tab === 'custom' && (
          <View>
            <TouchableOpacity style={s.customPickBtn} activeOpacity={0.8} onPress={pickImage}>
              <Ionicons name="image-outline" size={28} color={colors.primary} />
              <Text style={s.customPickText}>Choose from gallery</Text>
              <Text style={s.customPickSub}>Pick a photo to use as the chat wallpaper</Text>
            </TouchableOpacity>
            {selected?.type === 'image' && (
              <View style={{ marginTop: 12 }}>
                <Image source={{ uri: selected.value }} style={s.customImage} resizeMode="cover" />
                <View style={s.customCheckRow}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                  <Text style={[s.customCheckText, { color: colors.success }]}>Photo selected</Text>
                </View>
              </View>
            )}
          </View>
        )}

        <TouchableOpacity activeOpacity={0.85} onPress={save} style={s.setBtn}>
          <Text style={s.setBtnText}>Set wallpaper</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: c.text, fontSize: 18, fontWeight: '700' },
  resetText: { color: c.primary, fontSize: 14, fontWeight: '700', paddingHorizontal: 8 },

  previewBox: { height: 200, borderRadius: 16, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, justifyContent: 'flex-end', marginBottom: 18 },
  sampleBubbles: { padding: 12 },
  peerBubble: { alignSelf: 'flex-start', borderRadius: 14, borderTopLeftRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8, maxWidth: '78%' },
  myBubble: { alignSelf: 'flex-end', borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '78%' },
  bubbleText: { fontSize: 14, lineHeight: 19 },
  bubbleTime: { fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },

  tabs: { flexDirection: 'row', backgroundColor: c.surface, borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 9 },
  tabActive: { backgroundColor: c.primary },
  tabText: { color: c.textDim, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: '#fff' },

  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  colorTile: { width: COLOR_SIZE, height: COLOR_SIZE, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, justifyContent: 'center', alignItems: 'center' },
  tileSelected: { borderWidth: 2.5, borderColor: c.primary },
  defaultTileTxt: { fontSize: 9, fontWeight: '700' },

  gradientGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  gradientTile: { width: PRESET_W, height: PRESET_W * 1.25, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  gradientLabel: { color: c.textDim, fontSize: 11, fontWeight: '600', marginTop: 4, textAlign: 'center', width: PRESET_W },

  customPickBtn: { backgroundColor: c.surface, borderRadius: 14, borderWidth: 1, borderColor: c.border, borderStyle: 'dashed', padding: 24, alignItems: 'center', gap: 8 },
  customPickText: { color: c.primary, fontSize: 16, fontWeight: '700' },
  customPickSub: { color: c.textDim, fontSize: 13, textAlign: 'center' },
  customImage: { width: '100%', height: 200, borderRadius: 12 },
  customCheckRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  customCheckText: { fontSize: 13, fontWeight: '600' },

  setBtn: { backgroundColor: c.primary, borderRadius: 26, paddingVertical: 15, alignItems: 'center', marginTop: 24 },
  setBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
