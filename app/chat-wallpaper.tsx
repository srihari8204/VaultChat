// app/chat-wallpaper.tsx — Per-Chat Wallpaper (WhatsApp-style).
//
// Default (theme wallpaper), solid colors (bright + dark sets), gradient
// presets, or a photo from the gallery. Live preview with real themed bubbles.
// Saved per chatId in AsyncStorage (falls back to a global default). Theme-aware
// in both light and dark. Consumed by app/chat.tsx via getWallpaper()
// (lib/chatWallpaperStore).

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
import { WALLPAPER_GLOBAL_KEY, wallpaperKey, type WallpaperConfig } from '../lib/chatWallpaperStore';
// Fixed wallpaper content, not UI colour (see that file's header).
import { GRADIENT_WALLPAPERS, SOLID_WALLPAPERS, wallpaperInk } from '../constants/wallpaperPalette';
import type { EventArg, NavigationAction } from '@react-navigation/native';


type Tab = 'solid' | 'gradient' | 'custom';


/** What a wallpaper is called, for "Same as all chats · <name>". */
function wallpaperName(w: WallpaperConfig | null): string {
  if (!w) return 'Default';
  if (w.type === 'image') return 'Photo';
  if (w.type === 'gradient') return GRADIENT_WALLPAPERS.find(g => g.id === w.value)?.name ?? 'Gradient';
  return SOLID_WALLPAPERS.find(c => c.hex === w.value)?.name ?? 'Colour';
}

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
  const storageKey = wallpaperKey(chatId);

  // null = default (theme wallpaper)
  const [selected, setSelected] = useState<WallpaperConfig | null>(null);
  // Per-chat only: nothing stored for this chat, so it shows the all-chats
  // wallpaper (lib/scopedChoice). Saving it removes the per-chat key.
  const [inherit, setInherit] = useState(false);
  // The all-chats wallpaper, so a per-chat screen can show what it inherits.
  const [globalWp, setGlobalWp] = useState<WallpaperConfig | null>(null);
  const [tab, setTab] = useState<Tab>('solid');
  // What is stored now, to tell an unsaved change from the saved choice.
  const [savedJson, setSavedJson] = useState('null');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // A pick made before the initial read resolves wins over that read.
  const touched = useRef(false);
  // The saved choice could not be read: say so (Default is shown) and offer Try again.
  const [loadErr, setLoadErr] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const pick = (w: WallpaperConfig | null) => { touched.current = true; setInherit(false); setSelected(w); };
  const pickInherit = () => { touched.current = true; setInherit(true); setSelected(null); };
  const choiceJson = (inh: boolean, w: WallpaperConfig | null) => (inh ? '"inherit"' : JSON.stringify(w));

  useEffect(() => {
    touched.current = false;
    (async () => {
      try {
        const [raw, globalRaw] = await Promise.all([AsyncStorage.getItem(storageKey), AsyncStorage.getItem(WALLPAPER_GLOBAL_KEY)]);
        const loaded: WallpaperConfig | null = raw && raw !== SCOPED_DEFAULT ? JSON.parse(raw) : null;
        const inh = !!chatId && raw == null;
        if (chatId) {
          try { setGlobalWp(JSON.parse(resolveScoped(null, globalRaw) ?? 'null')); } catch { setGlobalWp(null); }
        }
        setSavedJson(choiceJson(inh, loaded));
        setLoadErr(false);
        if (!touched.current) { setSelected(loaded); setInherit(inh); }
      } catch { setLoadErr(true); }
    })();
  }, [storageKey, chatId, reloadKey]);

  // Same model as everywhere else that edits before saving: leaving with an
  // unsaved pick (header back, hardware back, swipe) asks first.
  const dirty = choiceJson(inherit, selected) !== savedJson;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const leaving = useRef(false);
  const navigation = useNavigation();
  // Typed by hand: with strictNullChecks off, the library's own event map
  // resolves beforeRemove as not preventable (`undefined extends true`).
  useEffect(() => navigation.addListener('beforeRemove', (e: EventArg<'beforeRemove', true, { action: NavigationAction }>) => {
    if (leaving.current || !dirtyRef.current) return;
    e.preventDefault();
    Alert.alert('Discard wallpaper change?', 'Tap "Set wallpaper" to keep it.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
    ]);
  }), [navigation]);

  // After a failed read the stored wallpaper is unknown: replacing it is asked,
  // not a side effect of Set wallpaper.
  const save = () => {
    if (!loadErr) { doSave(); return; }
    Alert.alert(
      'Replace your saved wallpaper?',
      "Your saved wallpaper couldn't be read, so this screen can't show it. Setting this one replaces it.",
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Replace', onPress: () => { doSave(); } }],
    );
  };
  const doSave = async () => {
    // A double tap would copy the photo twice and orphan one copy.
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const dir = FileSystem.documentDirectory ? FileSystem.documentDirectory + 'wallpapers/' : '';
    let copied: string | null = null;
    let step: 'copy' | 'store' = 'store';
    try {
      let toSave = selected;
      // The picker returns a cache URI the OS may evict; keep our own copy.
      // It is a plain file in the app's private documents directory, like
      // received chat media: the OS sandbox protects it and uninstall deletes
      // it. It is the user's own photo, picked from their gallery, so it is not
      // sealed with the cache key.
      if (toSave?.type === 'image' && dir && FileSystem.documentDirectory
          && !toSave.value.startsWith(FileSystem.documentDirectory)) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const dest = `${dir}${chatId || 'default'}_${Date.now()}.jpg`;
        step = 'copy';
        await FileSystem.copyAsync({ from: toSave.value, to: dest });
        step = 'store';
        copied = dest;
        toSave = { ...toSave, value: dest };
      }
      const prevRaw = await AsyncStorage.getItem(storageKey).catch(() => null);
      if (chatId && inherit) await AsyncStorage.removeItem(storageKey);
      else if (toSave) await AsyncStorage.setItem(storageKey, JSON.stringify(toSave));
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
      Alert.alert('Could not set wallpaper', step === 'copy'
        ? 'The photo could not be copied into the app — it may have been moved or deleted, or the phone is out of space. Pick it again.'
        : 'Your choice could not be saved on this phone. Your wallpaper was not changed. Try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Per-chat Reset follows all chats (as chat-themes does); global → default.
  const reset = () => (chatId ? pickInherit() : pick(null));

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
    } catch {
      Alert.alert('Could not open your photos', 'Your photo library could not be opened. Try again.');
    }
  };

  const isDefault = !inherit && !selected;

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
        <TouchableOpacity onPress={reset} style={s.resetBtn} accessibilityRole="button" accessibilityLabel={chatId ? 'Reset to the wallpaper used for all chats' : 'Reset to default wallpaper'}><Text style={s.resetText}>Reset</Text></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Preview */}
        <PreviewBg selected={inherit ? globalWp : selected} fallbackBg={colors.chatBg} boxStyle={s.previewBox}>
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

        {loadErr && (
          <View style={s.loadErrBox}>
            <Text style={s.loadErr} accessibilityRole="alert">
              {"Couldn't read your saved wallpaper, so Default is shown. Setting a wallpaper replaces it."}
            </Text>
            <TouchableOpacity style={s.retryBtn} onPress={() => setReloadKey(k => k + 1)} accessibilityRole="button" accessibilityLabel="Try reading your saved wallpaper again">
              <Text style={s.resetText}>Try again</Text>
            </TouchableOpacity>
          </View>
        )}

        {!!chatId && (
          <TouchableOpacity
            style={[s.inheritRow, inherit && s.inheritRowOn]}
            onPress={pickInherit}
            activeOpacity={0.8}
            accessibilityRole="radio"
            accessibilityLabel={`Same as all chats, currently ${wallpaperName(globalWp)}`}
            accessibilityState={{ checked: inherit }}
          >
            <Ionicons name={inherit ? 'radio-button-on' : 'radio-button-off'} size={20} color={inherit ? colors.primary : colors.textFaint} />
            <Text style={s.inheritTxt}>Same as all chats · {wallpaperName(globalWp)}</Text>
          </TouchableOpacity>
        )}

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
              onPress={() => pick(null)}
              style={[s.colorTile, { backgroundColor: colors.chatBg }, isDefault && s.tileSelected]}
              accessibilityRole="radio"
              accessibilityLabel="Default wallpaper"
              accessibilityState={{ checked: isDefault }}
            >
              {isDefault
                ? <Ionicons name="checkmark" size={18} color={colors.primary} />
                : <Text style={[s.defaultTileTxt, { color: colors.textDim }]}>Default</Text>}
            </TouchableOpacity>
            {SOLID_WALLPAPERS.map(({ hex, name }) => {
              const on = selected?.type === 'solid' && selected.value === hex;
              return (
                <TouchableOpacity accessibilityRole="radio" accessibilityLabel={`${name} wallpaper`} accessibilityState={{ checked: on }}
                  key={hex}
                  onPress={() => pick({ type: 'solid', value: hex })}
                  style={[s.colorTile, { backgroundColor: hex }, on && s.tileSelected]}
                >
                  {on && <Ionicons name="checkmark" size={18} color={wallpaperInk([hex])} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {tab === 'gradient' && (
          <View style={s.gradientGrid}>
            {GRADIENT_WALLPAPERS.map(g => {
              const on = selected?.type === 'gradient' && selected.value === g.id;
              return (
                <TouchableOpacity key={g.id} onPress={() => pick({ type: 'gradient', value: g.id, colors: g.colors })} activeOpacity={0.8} accessibilityRole="radio" accessibilityLabel={`${g.name} gradient`} accessibilityState={{ checked: on }}>
                  <LinearGradient colors={g.colors as [string, string, ...string[]]} style={[s.gradientTile, on && s.tileSelected]}>
                    {on && <Ionicons name="checkmark-circle" size={22} color={wallpaperInk(g.colors)} />}
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

        <TouchableOpacity activeOpacity={0.85} onPress={save} disabled={saving} style={[s.setBtn, saving && s.setBtnOff]} accessibilityRole="button" accessibilityState={{ disabled: saving, busy: saving }}>
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

  inheritRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14, marginBottom: 14, borderRadius: 14, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: 'transparent' },
  inheritRowOn: { borderColor: c.primary },
  inheritTxt: { color: c.text, fontSize: 14, fontWeight: '600', flex: 1 },

  tabs: { flexDirection: 'row', backgroundColor: c.glassSoft, borderRadius: 12, padding: 4, marginBottom: 16 },
  loadErrBox: { marginBottom: 12 },
  loadErr: { color: c.danger, fontSize: 13, lineHeight: 18 },
  retryBtn: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  tab: { flex: 1, minHeight: 44, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  tabActive: { backgroundColor: c.primary },
  tabText: { color: c.textDim, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: c.onPrimary },

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

  setBtn: { backgroundColor: c.primary, borderRadius: 26, paddingVertical: 15, minHeight: 50, alignItems: 'center', justifyContent: 'center', marginTop: 24 },
  setBtnOff: { opacity: 0.6 },
  setBtnText: { color: c.onPrimary, fontSize: 16, fontWeight: '800' },
});
}
