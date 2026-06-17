// app/chat-themes.tsx — Chat Themes & Wallpapers
// Per-chat or global theme. Gradient backgrounds, solid colors, patterns.
// Stored in AsyncStorage per chatId + global default.

import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  StatusBar, Dimensions, Alert, ScrollView,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';

const { width: SW } = Dimensions.get('window');
const TILE = (SW - 56) / 3;
const C = { bg: '#FFFFFF', accent: '#4A9FFF', card: '#F9FAFB' };

const THEMES = [
  { id: 'default', name: 'Default Dark', colors: ['#FFFFFF', '#FFFFFF'], type: 'solid' },
  { id: 'midnight', name: 'Midnight Blue', colors: ['#0a0a2e', '#1a1a4e'], type: 'gradient' },
  { id: 'ocean', name: 'Deep Ocean', colors: ['#001427', '#003459'], type: 'gradient' },
  { id: 'forest', name: 'Dark Forest', colors: ['#0b1a0b', '#1a3a1a'], type: 'gradient' },
  { id: 'aurora', name: 'Aurora', colors: ['#0d0221', '#0a4429', '#150050'], type: 'gradient' },
  { id: 'sunset', name: 'Sunset', colors: ['#1a0a2e', '#2d1b4e', '#4a1942'], type: 'gradient' },
  { id: 'cyber', name: 'Cyberpunk', colors: ['#0a0014', '#1a0028', '#00141a'], type: 'gradient' },
  { id: 'blood', name: 'Dark Red', colors: ['#1a0505', '#2a0a0a'], type: 'gradient' },
  { id: 'gold', name: 'Black Gold', colors: ['#0a0a00', '#1a1a05'], type: 'gradient' },
  { id: 'purple', name: 'Deep Purple', colors: ['#0e0020', '#1a0040'], type: 'gradient' },
  { id: 'arctic', name: 'Arctic', colors: ['#0a1628', '#0d2137'], type: 'gradient' },
  { id: 'matrix', name: 'Matrix', colors: ['#000a00', '#001a00'], type: 'gradient' },
  { id: 'warm', name: 'Warm Dark', colors: ['#1a1008', '#0e0a05'], type: 'gradient' },
  { id: 'steel', name: 'Steel', colors: ['#0e1117', '#1a1e25'], type: 'gradient' },
  { id: 'neon', name: 'Neon Night', colors: ['#0a0020', '#000a1a', '#1a0028'], type: 'gradient' },
];

const BUBBLE_COLORS = [
  { id: 'default', name: 'Default Green', mine: '#DCF8C6', peer: '#F3F4F6' },
  { id: 'blue', name: 'Blue', mine: '#0a2a4a', peer: '#F3F4F6' },
  { id: 'purple', name: 'Purple', mine: '#2a0a3a', peer: '#F3F4F6' },
  { id: 'red', name: 'Crimson', mine: '#3a0a0a', peer: '#F3F4F6' },
  { id: 'teal', name: 'Teal', mine: '#0a3a3a', peer: '#F3F4F6' },
  { id: 'orange', name: 'Orange', mine: '#3a2a0a', peer: '#F3F4F6' },
  { id: 'pink', name: 'Pink', mine: '#3a0a2a', peer: '#0e0e20' },
  { id: 'gray', name: 'Gray', mine: '#2a2a2a', peer: '#1a1a1a' },
];

const THEME_KEY = 'vc_chat_theme_';
const GLOBAL_KEY = 'vc_global_theme';
const BUBBLE_KEY = 'vc_bubble_color_';

export default function ChatThemesScreen() {
  const { chatId } = useLocalSearchParams();
  const isGlobal = !chatId;
  const [selectedTheme, setSelectedTheme] = useState('default');
  const [selectedBubble, setSelectedBubble] = useState('default');

  useEffect(() => {
    (async () => {
      const key = isGlobal ? GLOBAL_KEY : THEME_KEY + chatId;
      const saved = await AsyncStorage.getItem(key);
      if (saved) setSelectedTheme(saved);
      const bKey = isGlobal ? 'vc_global_bubble' : BUBBLE_KEY + chatId;
      const bSaved = await AsyncStorage.getItem(bKey);
      if (bSaved) setSelectedBubble(bSaved);
    })();
  }, [chatId, isGlobal]);

  const applyTheme = async (themeId) => {
    setSelectedTheme(themeId);
    const key = isGlobal ? GLOBAL_KEY : THEME_KEY + chatId;
    await AsyncStorage.setItem(key, themeId);
  };

  const applyBubble = async (bubbleId) => {
    setSelectedBubble(bubbleId);
    const bKey = isGlobal ? 'vc_global_bubble' : BUBBLE_KEY + chatId;
    await AsyncStorage.setItem(bKey, bubbleId);
  };

  const currentTheme = THEMES.find(t => t.id === selectedTheme) || THEMES[0];

  return (
    <>
      <Stack.Screen options={{ title: isGlobal ? 'Global Theme' : 'Chat Theme', headerStyle: { backgroundColor: '#FFFFFF' }, headerTintColor: '#1F2937' }} />
      <ScrollView style={s.container}>
        <StatusBar barStyle="light-content" />

        {/* Preview */}
        <Text style={s.sectionTitle}>PREVIEW</Text>
        <LinearGradient colors={currentTheme.colors} style={s.preview}>
          <View style={[s.previewBubbleL, { backgroundColor: BUBBLE_COLORS.find(b => b.id === selectedBubble)?.peer || '#F3F4F6' }]}>
            <Text style={s.previewTxt}>Hey, how are you?</Text>
            <Text style={s.previewTime}>10:30 AM</Text>
          </View>
          <View style={[s.previewBubbleR, { backgroundColor: BUBBLE_COLORS.find(b => b.id === selectedBubble)?.mine || '#DCF8C6' }]}>
            <Text style={s.previewTxt}>I&apos;m great! Love this new theme</Text>
            <Text style={s.previewTime}>10:31 AM</Text>
          </View>
          <View style={[s.previewBubbleL, { backgroundColor: BUBBLE_COLORS.find(b => b.id === selectedBubble)?.peer || '#F3F4F6' }]}>
            <Text style={s.previewTxt}>It looks amazing!</Text>
            <Text style={s.previewTime}>10:32 AM</Text>
          </View>
        </LinearGradient>

        {/* Backgrounds */}
        <Text style={[s.sectionTitle, { marginTop: 20 }]}>BACKGROUND</Text>
        <FlatList
          data={THEMES}
          horizontal={false}
          numColumns={3}
          scrollEnabled={false}
          keyExtractor={t => t.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={[s.themeTile, selectedTheme === item.id && s.themeTileActive]} onPress={() => applyTheme(item.id)}>
              <LinearGradient colors={item.colors} style={s.themeTileGrad}>
                {selectedTheme === item.id && <Text style={s.checkmark}>{"\u2713"}</Text>}
              </LinearGradient>
              <Text style={s.themeTileName}>{item.name}</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ gap: 8 }}
        />

        {/* Bubble Colors */}
        <Text style={[s.sectionTitle, { marginTop: 20 }]}>BUBBLE COLOR</Text>
        <FlatList
          data={BUBBLE_COLORS}
          horizontal
          scrollEnabled={true}
          showsHorizontalScrollIndicator={false}
          keyExtractor={b => b.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={[s.bubbleTile, selectedBubble === item.id && s.bubbleTileActive]} onPress={() => applyBubble(item.id)}>
              <View style={[s.bubblePreview, { backgroundColor: item.mine }]} />
              <Text style={s.bubbleName}>{item.name}</Text>
            </TouchableOpacity>
          )}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}
        />

        <TouchableOpacity style={s.resetBtn} onPress={() => { applyTheme('default'); applyBubble('default'); Alert.alert('Reset', 'Theme reset to default'); }}>
          <Text style={s.resetTxt}>Reset to Default</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 16 },
  sectionTitle: { color: '#6B7280', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  preview: { borderRadius: 16, padding: 16, minHeight: 180 },
  previewBubbleL: { alignSelf: 'flex-start', maxWidth: '75%', borderRadius: 14, borderBottomLeftRadius: 2, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  previewBubbleR: { alignSelf: 'flex-end', maxWidth: '75%', borderRadius: 14, borderBottomRightRadius: 2, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 6 },
  previewTxt: { color: '#1F2937', fontSize: 14 },
  previewTime: { color: '#6B7280', fontSize: 10, marginTop: 3, textAlign: 'right' },
  themeTile: { width: TILE, marginBottom: 8, marginRight: 8 },
  themeTileActive: { borderWidth: 2, borderColor: C.accent, borderRadius: 14 },
  themeTileGrad: { width: '100%', height: 70, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  checkmark: { color: '#fff', fontSize: 20, fontWeight: '900' },
  themeTileName: { color: '#6B7280', fontSize: 10, textAlign: 'center', marginTop: 4 },
  bubbleTile: { alignItems: 'center', padding: 8 },
  bubbleTileActive: { backgroundColor: '#4A9FFF22', borderRadius: 10 },
  bubblePreview: { width: 40, height: 40, borderRadius: 10 },
  bubbleName: { color: '#6B7280', fontSize: 10, marginTop: 4 },
  resetBtn: { marginTop: 20, padding: 14, borderRadius: 12, backgroundColor: '#FF3C6E15', borderWidth: 1, borderColor: '#FF3C6E33', alignItems: 'center' },
  resetTxt: { color: '#FF3C6E', fontSize: 13, fontWeight: '700' },
});

// Export helper for other screens to read theme
export async function getChatTheme(chatId) {
  const specific = await AsyncStorage.getItem(THEME_KEY + chatId);
  if (specific) return THEMES.find(t => t.id === specific) || THEMES[0];
  const global = await AsyncStorage.getItem(GLOBAL_KEY);
  return THEMES.find(t => t.id === global) || THEMES[0];
}

// Bubble colors chosen for this chat. Returns null for the built-in default so
// chat.tsx keeps its native styling. Consumed by app/chat.tsx.
export async function getBubbleColors(chatId) {
  try {
    const id = await AsyncStorage.getItem(BUBBLE_KEY + chatId);
    const found = BUBBLE_COLORS.find(b => b.id === id);
    if (!found || found.id === 'default') return null;
    return { mine: found.mine, peer: found.peer };
  } catch { return null; }
}
