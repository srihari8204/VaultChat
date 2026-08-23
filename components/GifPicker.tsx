// components/GifPicker.tsx
// GIFs, stickers and emojis from KLIPY, through our backend proxy so the API
// key never ships in the APK. One /gif/search route serves all three — only the
// `type` parameter changes — so the three tabs are one code path.

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  Image, StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

interface GifResult {
  id: string;
  url: string;      // animated GIF url (sendable + renders in <Image>)
  preview: string;
  width: number;
  height: number;
}

/** The three KLIPY collections we expose. `type` is the server's query param. */
const TABS = [
  { type: 'gifs',     label: 'GIFs',     placeholder: 'Search GIFs…' },
  { type: 'stickers', label: 'Stickers', placeholder: 'Search stickers…' },
  { type: 'emojis',   label: 'Emojis',   placeholder: 'Search emojis…' },
] as const;
type TabType = typeof TABS[number]['type'];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (url: string, previewUrl: string) => void;
}

export default function GifPicker({ visible, onClose, onSelect }: Props) {
  const { colors, scheme } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [tab,     setTab]     = useState<TabType>('gifs');
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [note,    setNote]    = useState('');   // shown when there's nothing to display

  const search = useCallback(async (q: string, type: TabType) => {
    setLoading(true);
    try {
      const data = await api<{ results: any[]; error?: string }>(
        `/gif/search?type=${type}&q=${encodeURIComponent(q.trim())}`,
      );
      if (data.error === 'not_configured') {
        setResults([]);
        setNote('Not set up on the server yet.');
        return;
      }
      const items: GifResult[] = (data.results ?? []).map((r) => ({
        id:      r.id,
        url:     r.gif || r.url || '',         // animated gif (broad compatibility)
        preview: r.preview || r.gif || '',
        width:   r.width  ?? 100,
        height:  r.height ?? 100,
      })).filter((g: GifResult) => g.url);
      setResults(items);
      setNote(items.length === 0 ? (q.trim() ? 'Nothing found' : 'Type to search') : '');
    } catch {
      setResults([]);
      setNote('Unavailable right now.');
    } finally { setLoading(false); }
  }, []);

  // DEBOUNCED. This used to fire a request per keystroke — "birthday" was nine
  // searches, eight of them for prefixes nobody wanted, against a metered API.
  // 300ms is below the point a picker feels laggy and above normal typing speed.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSearch = useCallback((q: string, type: TabType) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => search(q, type), 300);
  }, [search]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Opening, or switching tab, shows that collection's trending straight away —
  // no debounce, because neither is typing and a blank grid reads as broken.
  useEffect(() => {
    if (!visible) return;
    if (timer.current) clearTimeout(timer.current);
    search(query, tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab]);

  // Reset to a clean sheet on close, or reopening shows the last search.
  useEffect(() => { if (!visible) { setQuery(''); setResults([]); setNote(''); } }, [visible]);

  if (!visible) return null;

  const active = TABS.find(t => t.type === tab)!;

  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={() => {}}>
        <View style={s.handle} />

        <View style={s.searchRow}>
          <TextInput
            style={s.input}
            placeholder={active.placeholder}
            placeholderTextColor={colors.textDim}
            value={query}
            onChangeText={q => { setQuery(q); queueSearch(q, tab); }}
            autoFocus
          />
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={22} color={colors.textDim} />
          </TouchableOpacity>
        </View>

        <View style={s.tabs}>
          {TABS.map(t => (
            <TouchableOpacity
              key={t.type}
              style={[s.tab, tab === t.type && s.tabOn]}
              onPress={() => setTab(t.type)}
              activeOpacity={0.8}
            >
              <Text style={[s.tabTxt, tab === t.type && s.tabTxtOn]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading && <ActivityIndicator color={colors.primary} style={{ margin: 16 }} />}

        <FlatList
          data={results}
          numColumns={3}
          key={tab}                       // remount on tab change so the grid resets to the top
          keyExtractor={g => g.id}
          contentContainerStyle={s.grid}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.gifCell}
              onPress={() => { onSelect(item.url, item.preview); onClose(); }}
            >
              {/* contain, not cover: stickers and emojis are transparent and
                  non-square, and cropping them cuts the subject off. */}
              <Image source={{ uri: item.preview }} style={s.gifImg} resizeMode="contain" />
            </TouchableOpacity>
          )}
          ListEmptyComponent={!loading ? <Text style={s.empty}>{note || 'Type to search'}</Text> : null}
        />

        {/* Attribution is a condition of using KLIPY, not decoration — it stays
            visible with the picker rather than hidden behind a scroll. Black on
            light, white on dark, from the brand pack. */}
        <View style={s.attribution}>
          <Image
            source={scheme === 'light'
              ? require('../assets/klipy/powered-by-klipy-black.png')
              : require('../assets/klipy/powered-by-klipy-white.png')}
            style={s.klipyLogo}
            resizeMode="contain"
            accessibilityLabel="Powered by KLIPY"
          />
        </View>
      </Pressable>
    </Pressable>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  overlay:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: c.surfaceSolid, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '75%' },
  handle:    { width: 40, height: 4, backgroundColor: c.border, borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  input:     { flex: 1, backgroundColor: c.surface, color: c.text, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  closeX:    { color: c.textDim, fontSize: 20, padding: 4 },
  tabs:      { flexDirection: 'row', gap: 8, paddingHorizontal: 12, marginBottom: 6 },
  tab:       { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, backgroundColor: c.surface },
  tabOn:     { backgroundColor: c.primary },
  tabTxt:    { color: c.textDim, fontSize: 13, fontWeight: '700' },
  tabTxtOn:  { color: '#fff' },
  grid:      { padding: 4 },
  gifCell:   { flex: 1, margin: 2, height: 100, backgroundColor: c.surface, borderRadius: 8, overflow: 'hidden' },
  gifImg:    { width: '100%', height: '100%' },
  empty:     { color: c.textDim, textAlign: 'center', marginTop: 40, fontSize: 14 },
  attribution: { alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  klipyLogo: { width: 104, height: 18, opacity: 0.85 },
});
