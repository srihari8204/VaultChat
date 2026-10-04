// app/chat-themes.tsx — Bubble Theme (WhatsApp-style).
//
// Picks the color of YOUR (outgoing) message bubble; received bubbles always
// follow the app theme. Live preview over the real chat background. Per-chat or
// global. Theme-aware (light + dark). Consumed by app/chat.tsx via
// getBubbleColors() (lib/chatBubbleTheme), which returns null for "Default".

import { HEADER_TOP } from '../constants/layout';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert,
} from 'react-native';
import { resolveScoped, SCOPED_DEFAULT } from '../lib/scopedChoice';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { AuroraBackground } from '../components/ui';
import { tint } from '../lib/tintColor';
import { BUBBLE_KEY, BUBBLE_THEMES, GLOBAL_BUBBLE, idealText } from '../lib/chatBubbleTheme';

export default function ChatThemesScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const isGlobal = !chatId;
  const key = isGlobal ? GLOBAL_BUBBLE : BUBBLE_KEY + chatId;

  // The raw value stored under this screen's key. null = nothing stored: the
  // app default on the global screen, "same as all chats" on a per-chat one.
  const [stored, setStored] = useState<string | null>(null);
  // The all-chats choice, so a per-chat screen can show what it inherits.
  const [globalId, setGlobalId] = useState<string | null>(null);
  // A tap made before the initial read resolves wins over that read.
  const touched = useRef(false);
  // The saved choice could not be read: the screen shows the default, says
  // so, and offers Try again.
  const [loadErr, setLoadErr] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // What is known to be in storage, for rolling back a failed save. Not the
  // `stored` of the tap: with two quick taps that is the first tap's value.
  const savedRef = useRef<string | null>(null);
  // Only the latest tap's failure rolls back (an older one's must not undo it).
  const applySeq = useRef(0);

  useEffect(() => {
    touched.current = false;
    (async () => {
      try {
        const [saved, global] = await Promise.all([AsyncStorage.getItem(key), AsyncStorage.getItem(GLOBAL_BUBBLE)]);
        if (touched.current) return;
        savedRef.current = saved;
        setStored(saved);
        setGlobalId(global);
        setLoadErr(false);
      } catch { if (!touched.current) setLoadErr(true); }
    })();
  }, [key, reloadKey]);

  // Saves on tap. Per-chat "Default" is stored explicitly (see lib/scopedChoice);
  // null removes the key (global: app default, per-chat: follow all chats).
  const apply = async (id: string | null) => {
    touched.current = true;
    setLoadErr(false);
    const seq = ++applySeq.current;
    const next = id === SCOPED_DEFAULT && isGlobal ? null : id;
    setStored(next);
    try {
      if (next == null) await AsyncStorage.removeItem(key);
      else await AsyncStorage.setItem(key, next);
      savedRef.current = next;
    } catch {
      if (seq !== applySeq.current) return;
      setStored(savedRef.current);
      Alert.alert('Could not save', 'Your bubble colour was not changed. Try again.');
    }
  };

  // What the chat actually shows, through the same rule chat.tsx uses.
  const effectiveId = isGlobal ? resolveScoped(null, stored) : resolveScoped(stored, globalId);
  const inherited = BUBBLE_THEMES.find(t => t.id === resolveScoped(null, globalId)) || BUBBLE_THEMES[0];
  const current = BUBBLE_THEMES.find(t => t.id === effectiveId) || BUBBLE_THEMES[0];
  const mineBg = current.color ?? colors.bubbleOut;
  const mineText = current.color ? idealText(current.color) : colors.bubbleOutText;
  // Meta (time, ticks) is the bubble's own ink, dimmed.
  const mineMeta = current.color ? tint(mineText, 0.6) : colors.bubbleMetaOut;

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">{isGlobal ? 'Bubble theme · all chats' : 'Bubble theme · this chat'}</Text>
        <TouchableOpacity
          onPress={() => apply(null)}
          style={s.resetBtn}
          accessibilityRole="button"
          accessibilityLabel={isGlobal ? 'Reset to default bubble colour' : 'Reset to the colour used for all chats'}
        >
          <Text style={s.resetText}>Reset</Text>
        </TouchableOpacity>
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

        {loadErr && (
          <View style={s.loadErrBox}>
            <Text style={s.loadErr} accessibilityRole="alert">
              {"Couldn't read your saved colour, so the default is shown. Picking a colour replaces it."}
            </Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => setReloadKey(k => k + 1)} accessibilityRole="button" accessibilityLabel="Try reading your saved colour again">
              <Text style={s.resetText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}
        <Text style={s.sectionTitle}>YOUR BUBBLE COLOR</Text>
        {!isGlobal && (
          <TouchableOpacity
            style={[s.inheritRow, stored == null && s.inheritRowOn]}
            onPress={() => apply(null)}
            activeOpacity={0.8}
            accessibilityRole="radio"
            accessibilityLabel={`Same as all chats, currently ${inherited.name}`}
            accessibilityState={{ checked: stored == null }}
          >
            <Ionicons name={stored == null ? 'radio-button-on' : 'radio-button-off'} size={20} color={stored == null ? colors.primary : colors.textFaint} />
            <Text style={s.inheritTxt}>Same as all chats · {inherited.name}</Text>
          </TouchableOpacity>
        )}
        <View style={s.grid}>
          {BUBBLE_THEMES.map(t => {
            const swatch = t.color ?? colors.bubbleOut;
            const on = isGlobal ? (stored ?? SCOPED_DEFAULT) === t.id : stored === t.id;
            return (
              <TouchableOpacity key={t.id} style={s.cell} onPress={() => apply(t.id)} activeOpacity={0.8} accessibilityRole="radio" accessibilityLabel={`${t.name} bubble colour`} accessibilityState={{ checked: on }}>
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

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 12, paddingBottom: 12, backgroundColor: c.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, color: c.text, fontSize: 18, fontWeight: '700' },
  resetBtn: { minHeight: 44, justifyContent: 'center' },
  resetText: { color: c.primary, fontSize: 14, fontWeight: '700', paddingHorizontal: 8 },
  inheritRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14, marginBottom: 14, borderRadius: 14, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: 'transparent' },
  inheritRowOn: { borderColor: c.primary },
  inheritTxt: { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },

  preview: { borderRadius: 16, padding: 14, minHeight: 180, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, justifyContent: 'center', marginBottom: 20 },
  peerBubble: { alignSelf: 'flex-start', maxWidth: '78%', borderRadius: 14, borderTopLeftRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  myBubble: { alignSelf: 'flex-end', maxWidth: '78%', borderRadius: 14, borderTopRightRadius: 4, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  txt: { fontSize: 14, lineHeight: 19 },
  time: { fontSize: 10, alignSelf: 'flex-end', marginTop: 2 },

  loadErrBox: { marginBottom: 12 },
  loadErr: { color: c.danger, fontSize: 13, lineHeight: 18 },
  retryBtn: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  sectionTitle: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' },
  cell: { width: '22%', alignItems: 'center', gap: 6 },
  swatch: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  swatchOn: { borderWidth: 3, borderColor: c.primary },
  cellName: { color: c.textDim, fontSize: 11 },

  note: { color: c.textFaint, fontSize: 12, marginTop: 24, lineHeight: 17, textAlign: 'center' },
});
