// app/chat-themes.tsx — Bubble Theme (WhatsApp-style).
//
// Picks the color of YOUR (outgoing) message bubble; received bubbles always
// follow the app theme. Live preview over the real chat background. Per-chat or
// global. Theme-aware (light + dark). Consumed by app/chat.tsx via
// getBubbleColors(), which returns null for "Default" (theme green).

import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

const BUBBLE_KEY = 'vc_bubble_color_';
const GLOBAL_BUBBLE = 'vc_global_bubble';

interface BubbleTheme { id: string; name: string; color: string | null }

const BUBBLE_THEMES: BubbleTheme[] = [
  { id: 'default', name: 'Default', color: null },
  { id: 'emerald', name: 'Emerald', color: '#0E7256' },
  { id: 'teal',    name: 'Teal',    color: '#0B6E63' },
  { id: 'sky',     name: 'Sky',     color: '#0369A1' },
  { id: 'blue',    name: 'Blue',    color: '#1E40AF' },
  { id: 'indigo',  name: 'Indigo',  color: '#4338CA' },
  { id: 'purple',  name: 'Purple',  color: '#6D28D9' },
  { id: 'magenta', name: 'Magenta', color: '#9D2A6E' },
  { id: 'rose',    name: 'Rose',    color: '#BE123C' },
  { id: 'crimson', name: 'Crimson', color: '#B01E3C' },
  { id: 'sunset',  name: 'Sunset',  color: '#B45309' },
  { id: 'slate',   name: 'Slate',   color: '#334155' },
];

// Legible text (black/white) for a given background — matches chat.tsx idealText.
function idealText(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#111B21' : '#FFFFFF';
}

export default function ChatThemesScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const isGlobal = !chatId;
  const key = isGlobal ? GLOBAL_BUBBLE : BUBBLE_KEY + chatId;

  const [selected, setSelected] = useState('default');

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(key);
      if (saved) setSelected(saved);
    })();
  }, [key]);

  const apply = async (id: string) => {
    setSelected(id);
    if (id === 'default') await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, id);
  };

  const current = BUBBLE_THEMES.find(t => t.id === selected) || BUBBLE_THEMES[0];
  const mineBg = current.color ?? colors.bubbleOut;
  const mineText = current.color ? idealText(current.color) : colors.bubbleOutText;
  const mineMeta = current.color ? (idealText(current.color) === '#FFFFFF' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.45)') : colors.bubbleMetaOut;

  return (
    <View style={s.root}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>{isGlobal ? 'Bubble theme' : 'Bubble theme'}</Text>
        <TouchableOpacity onPress={() => apply('default')} hitSlop={8}><Text style={s.resetText}>Reset</Text></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Live preview over the real chat background */}
        <View style={[s.preview, { backgroundColor: colors.chatBg }]}>
          <View style={[s.peerBubble, { backgroundColor: colors.bubbleIn }]}>
            <Text style={[s.txt, { color: colors.bubbleInText }]}>Hey, how are you?</Text>
            <Text style={[s.time, { color: colors.bubbleMetaIn }]}>10:30</Text>
          </View>
          <View style={[s.myBubble, { backgroundColor: mineBg }]}>
            <Text style={[s.txt, { color: mineText }]}>I&apos;m great — love this theme!</Text>
            <Text style={[s.time, { color: mineMeta }]}>10:31 ✓✓</Text>
          </View>
          <View style={[s.peerBubble, { backgroundColor: colors.bubbleIn }]}>
            <Text style={[s.txt, { color: colors.bubbleInText }]}>Looks great 🔥</Text>
            <Text style={[s.time, { color: colors.bubbleMetaIn }]}>10:32</Text>
          </View>
        </View>

        <Text style={s.sectionTitle}>YOUR BUBBLE COLOR</Text>
        <View style={s.grid}>
          {BUBBLE_THEMES.map(t => {
            const swatch = t.color ?? colors.bubbleOut;
            const on = selected === t.id;
            return (
              <TouchableOpacity key={t.id} style={s.cell} onPress={() => apply(t.id)} activeOpacity={0.8}>
                <View style={[s.swatch, { backgroundColor: swatch }, on && s.swatchOn]}>
                  {on && <Ionicons name="checkmark" size={20} color={idealText(swatch)} />}
                </View>
                <Text style={[s.cellName, on && { color: colors.primary, fontWeight: '700' }]} numberOfLines={1}>{t.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <Text style={s.note}>Received messages always use the app theme — only your own bubble changes.</Text>
      </ScrollView>
    </View>
  );
}

// Bubble colors chosen for a chat. Returns null for "Default" so chat.tsx keeps
// the theme's green outgoing bubble. (peer is unused by chat.tsx now — received
// bubbles always follow the theme — but kept for the existing call shape.)
export async function getBubbleColors(chatId: string): Promise<{ mine: string; peer: string } | null> {
  try {
    const id = (await AsyncStorage.getItem(BUBBLE_KEY + chatId))
      || (await AsyncStorage.getItem(GLOBAL_BUBBLE));
    const found = BUBBLE_THEMES.find(b => b.id === id);
    if (!found || !found.color) return null;
    return { mine: found.color, peer: found.color };
  } catch { return null; }
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 54, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, gap: 8 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: c.text, fontSize: 18, fontWeight: '700' },
  resetText: { color: c.primary, fontSize: 14, fontWeight: '700', paddingHorizontal: 8 },

  preview: { borderRadius: 16, padding: 14, minHeight: 180, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, justifyContent: 'center', marginBottom: 20 },
  peerBubble: { alignSelf: 'flex-start', maxWidth: '78%', borderRadius: 14, borderTopLeftRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  myBubble: { alignSelf: 'flex-end', maxWidth: '78%', borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  txt: { fontSize: 14, lineHeight: 19 },
  time: { fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },

  sectionTitle: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' },
  cell: { width: '22%', alignItems: 'center', gap: 6 },
  swatch: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  swatchOn: { borderWidth: 3, borderColor: c.primary },
  cellName: { color: c.textDim, fontSize: 11 },

  note: { color: c.textFaint, fontSize: 12, marginTop: 24, lineHeight: 17, textAlign: 'center' },
});
