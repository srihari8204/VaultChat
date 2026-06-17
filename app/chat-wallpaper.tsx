// app/chat-wallpaper.tsx — Per-Chat Wallpaper Selector
// Solid colors, gradient presets, custom image from gallery.
// Preview with sample chat bubbles. Saves per chatId in AsyncStorage.

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Image,
  StatusBar, ScrollView, Dimensions, Alert,
} from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';

const { width: SW } = Dimensions.get('window');
const C = { bg: '#FFFFFF', accent: '#4A9FFF', cyan: '#4A9FFF', card: '#F9FAFB', border: '#112240' };
const COLOR_SIZE = (SW - 64 - 4 * 12) / 5;
const PRESET_W = (SW - 48 - 8) / 3;

const SOLID_COLORS = [
  '#FFFFFF', '#FFFFFF', '#0D1B2A', '#F9FAFB', '#1A1A2E',
  '#0A192F', '#0B0C10', '#1B1B2F', '#162447', '#1F4068',
  '#0F0E0E', '#1A1A1A', '#2D2D2D', '#0D0D0D', '#121212',
  '#F9FAFB', '#0E2433', '#102030', '#071420', '#050D15',
];

const GRADIENT_PRESETS = [
  { id: 'midnight',  name: 'Midnight',  colors: ['#0a0a2e', '#1a1a4e'] },
  { id: 'ocean',     name: 'Ocean',     colors: ['#001427', '#003459'] },
  { id: 'forest',    name: 'Forest',    colors: ['#0b1a0b', '#1a3a1a'] },
  { id: 'aurora',    name: 'Aurora',    colors: ['#0d0221', '#0a4429', '#150050'] },
  { id: 'sunset',    name: 'Sunset',    colors: ['#1a0a2e', '#2d1b4e', '#4a1942'] },
  { id: 'cyberpunk', name: 'Cyberpunk', colors: ['#0a0014', '#1a0028', '#00141a'] },
  { id: 'crimson',   name: 'Crimson',   colors: ['#1a0505', '#2a0a0a'] },
  { id: 'arctic',    name: 'Arctic',    colors: ['#0a1628', '#0d2137'] },
  { id: 'matrix',    name: 'Matrix',    colors: ['#000a00', '#001a00'] },
  { id: 'nebula',    name: 'Nebula',    colors: ['#0e0020', '#1a0040', '#0a001a'] },
  { id: 'ember',     name: 'Ember',     colors: ['#1a0a00', '#2a1500'] },
  { id: 'steel',     name: 'Steel',     colors: ['#0e1117', '#1a1e25'] },
];

export interface WallpaperConfig {
  type: 'solid' | 'gradient' | 'image';
  value: string;         // hex for solid, preset id for gradient, uri for image
  colors?: string[];     // gradient colors
}

// Read the saved wallpaper for a chat (falls back to the global default).
// Consumed by app/chat.tsx to actually render the background.
export async function getWallpaper(chatId: string): Promise<WallpaperConfig | null> {
  try {
    const raw = (await AsyncStorage.getItem(`vc_wallpaper_${chatId}`))
      || (await AsyncStorage.getItem('vc_wallpaper_default'));
    return raw ? JSON.parse(raw) as WallpaperConfig : null;
  } catch { return null; }
}

export default function ChatWallpaperScreen() {
  const router = useRouter();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const storageKey = `vc_wallpaper_${chatId || 'default'}`;

  const [selected, setSelected] = useState<WallpaperConfig>({
    type: 'solid',
    value: C.bg,
  });
  const [tab, setTab] = useState<'solid' | 'gradient' | 'custom'>('solid');

  useEffect(() => {
    const loadWallpaper = async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) setSelected(JSON.parse(raw));
      } catch (e) {
      }
    };
    loadWallpaper();
  }, [storageKey]);

  const saveWallpaper = async () => {
    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(selected));
      Alert.alert('Wallpaper Set', 'Chat wallpaper has been updated.');
      router.back();
    } catch (e) {
      Alert.alert('Error', 'Failed to save wallpaper.');
    }
  };

  const resetWallpaper = async () => {
    try {
      await AsyncStorage.removeItem(storageKey);
      setSelected({ type: 'solid', value: C.bg });
      Alert.alert('Reset', 'Wallpaper has been reset to default.');
    } catch (e) {
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [9, 16],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setSelected({ type: 'image', value: result.assets[0].uri });
    }
  };

  // Render wallpaper preview background
  const PreviewBackground = ({ children }: any) => {
    if (selected.type === 'image') {
      return (
        <View style={s.previewBox}>
          <Image
            source={{ uri: selected.value }}
            style={StyleSheet.absoluteFillObject}
            resizeMode="cover"
          />
          {children}
        </View>
      );
    }
    if (selected.type === 'gradient' && selected.colors) {
      return (
        <LinearGradient colors={selected.colors} style={s.previewBox}>
          {children}
        </LinearGradient>
      );
    }
    return (
      <View style={[s.previewBox, { backgroundColor: selected.value }]}>
        {children}
      </View>
    );
  };

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <LinearGradient colors={['#F9FAFB', C.bg]} style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Chat Wallpaper</Text>
        <TouchableOpacity onPress={resetWallpaper}>
          <Text style={s.resetText}>Reset</Text>
        </TouchableOpacity>
      </LinearGradient>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* Preview */}
        <Text style={s.sectionTitle}>Preview</Text>
        <PreviewBackground>
          <View style={s.sampleBubbles}>
            <View style={s.peerBubble}>
              <Text style={s.bubbleText}>Hey, how are you?</Text>
              <Text style={s.bubbleTime}>10:30 AM</Text>
            </View>
            <View style={s.myBubble}>
              <Text style={s.bubbleText}>Doing great! Working on the project.</Text>
              <Text style={s.bubbleTime}>10:32 AM</Text>
            </View>
            <View style={s.peerBubble}>
              <Text style={s.bubbleText}>Awesome, let me know if you need help!</Text>
              <Text style={s.bubbleTime}>10:33 AM</Text>
            </View>
          </View>
        </PreviewBackground>

        {/* Tab selector */}
        <View style={s.tabs}>
          {(['solid', 'gradient', 'custom'] as const).map(t => (
            <TouchableOpacity
              key={t}
              style={[s.tab, tab === t && s.tabActive]}
              onPress={() => setTab(t)}
            >
              <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                {t === 'solid' ? 'Solid' : t === 'gradient' ? 'Gradients' : 'Custom'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Solid colors grid */}
        {tab === 'solid' && (
          <View style={s.colorGrid}>
            {SOLID_COLORS.map((color, i) => (
              <TouchableOpacity
                key={i}
                onPress={() => setSelected({ type: 'solid', value: color })}
                style={[
                  s.colorTile,
                  { backgroundColor: color },
                  selected.type === 'solid' && selected.value === color && s.colorSelected,
                ]}
              >
                {selected.type === 'solid' && selected.value === color && (
                  <Ionicons name="checkmark" size={18} color={C.accent} />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Gradient presets */}
        {tab === 'gradient' && (
          <View style={s.gradientGrid}>
            {GRADIENT_PRESETS.map(g => (
              <TouchableOpacity
                key={g.id}
                onPress={() =>
                  setSelected({ type: 'gradient', value: g.id, colors: g.colors })
                }
                activeOpacity={0.7}
              >
                <LinearGradient
                  colors={g.colors}
                  style={[
                    s.gradientTile,
                    selected.type === 'gradient' && selected.value === g.id && s.gradientSelected,
                  ]}
                >
                  {selected.type === 'gradient' && selected.value === g.id && (
                    <Ionicons name="checkmark-circle" size={22} color={C.accent} />
                  )}
                  <Text style={s.gradientLabel}>{g.name}</Text>
                </LinearGradient>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Custom image */}
        {tab === 'custom' && (
          <View>
            <TouchableOpacity style={s.customPickBtn} activeOpacity={0.7} onPress={pickImage}>
              <Ionicons name="images-outline" size={28} color={C.cyan} />
              <Text style={s.customPickText}>Choose from Gallery</Text>
              <Text style={s.customPickSub}>Select an image to use as wallpaper</Text>
            </TouchableOpacity>
            {selected.type === 'image' && (
              <View style={s.customPreview}>
                <Image
                  source={{ uri: selected.value }}
                  style={s.customImage}
                  resizeMode="cover"
                />
                <View style={s.customCheckRow}>
                  <Ionicons name="checkmark-circle" size={18} color="#00C853" />
                  <Text style={s.customCheckText}>Custom image selected</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Set button */}
        <TouchableOpacity activeOpacity={0.8} onPress={saveWallpaper}>
          <LinearGradient
            colors={[C.accent, '#3A8FEF']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={s.setBtn}
          >
            <Text style={s.setBtnText}>Set Wallpaper</Text>
          </LinearGradient>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  backBtn: { width: 36 },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  resetText: { color: '#F44', fontSize: 14, fontWeight: '600' },
  sectionTitle: {
    color: '#8899AA',
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  previewBox: {
    height: 220,
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: C.border,
    justifyContent: 'flex-end',
    marginBottom: 20,
  },
  sampleBubbles: {
    padding: 12,
  },
  peerBubble: {
    alignSelf: 'flex-start',
    backgroundColor: '#F3F4F6',
    borderRadius: 14,
    borderTopLeftRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
    maxWidth: '75%',
  },
  myBubble: {
    alignSelf: 'flex-end',
    backgroundColor: '#DCF8C6',
    borderRadius: 14,
    borderTopRightRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
    maxWidth: '75%',
  },
  bubbleText: {
    color: '#EEF',
    fontSize: 13,
    lineHeight: 18,
  },
  bubbleTime: {
    color: '#667',
    fontSize: 10,
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 10,
  },
  tabActive: {
    backgroundColor: C.accent + '22',
  },
  tabText: {
    color: '#667',
    fontSize: 14,
    fontWeight: '600',
  },
  tabTextActive: {
    color: C.accent,
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'flex-start',
  },
  colorTile: {
    width: COLOR_SIZE,
    height: COLOR_SIZE,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  colorSelected: {
    borderColor: C.accent,
  },
  gradientGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  gradientTile: {
    width: PRESET_W,
    height: PRESET_W * 1.2,
    borderRadius: 12,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 10,
  },
  gradientSelected: {
    borderWidth: 2,
    borderColor: C.accent,
  },
  gradientLabel: {
    color: '#AAB',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 4,
  },
  customPickBtn: {
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.cyan + '33',
    borderStyle: 'dashed',
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  customPickText: {
    color: C.cyan,
    fontSize: 16,
    fontWeight: '600',
  },
  customPickSub: {
    color: '#556',
    fontSize: 13,
  },
  customPreview: {
    marginTop: 12,
  },
  customImage: {
    width: '100%',
    height: 180,
    borderRadius: 12,
  },
  customCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  customCheckText: {
    color: '#00C853',
    fontSize: 13,
    fontWeight: '500',
  },
  setBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 24,
  },
  setBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
