// components/GifPicker.tsx
// Search and pick GIFs via our backend Tenor proxy (key stays server-side).

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  Image, StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';
import { api } from '../lib/api';

interface GifResult {
  id: string;
  url: string;      // animated GIF url (sendable + renders in <Image>)
  preview: string;
  width: number;
  height: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (url: string, previewUrl: string) => void;
}

export default function GifPicker({ visible, onClose, onSelect }: Props) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const data = await api<{ results: any[] }>(`/gif/search?q=${encodeURIComponent(q.trim())}`);
      const gifs: GifResult[] = (data.results ?? []).map((r) => ({
        id:      r.id,
        url:     r.gif || r.url || '',         // animated gif (broad compatibility)
        preview: r.preview || r.gif || '',
        width:   r.width  ?? 100,
        height:  r.height ?? 100,
      })).filter((g: GifResult) => g.url);
      setResults(gifs);
    } catch { setResults([]); }
    finally { setLoading(false); }
  }, []);

  // Show trending GIFs (empty query) when opened.
  useEffect(() => { if (visible) search(''); }, [visible, search]);

  if (!visible) return null;

  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={() => {}}>
        <View style={s.handle} />
        <View style={s.searchRow}>
          <TextInput
            style={s.input}
            placeholder="Search GIFs…"
            placeholderTextColor="#444"
            value={query}
            onChangeText={q => { setQuery(q); search(q); }}
            autoFocus
          />
          <TouchableOpacity onPress={onClose}>
            <Text style={s.closeX}>✕</Text>
          </TouchableOpacity>
        </View>
        {loading && <ActivityIndicator color="#00E5FF" style={{ margin: 16 }} />}
        <FlatList
          data={results}
          numColumns={3}
          keyExtractor={g => g.id}
          contentContainerStyle={s.grid}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.gifCell}
              onPress={() => { onSelect(item.url, item.preview); onClose(); }}
            >
              <Image source={{ uri: item.preview }} style={s.gifImg} resizeMode="cover" />
            </TouchableOpacity>
          )}
          ListEmptyComponent={!loading ? <Text style={s.empty}>Type to search GIFs</Text> : null}
        />
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: '#0E0E20', borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '75%' },
  handle:    { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  input:     { flex: 1, backgroundColor: '#181830', color: '#E0E0F0', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14 },
  closeX:    { color: '#555', fontSize: 20, padding: 4 },
  grid:      { padding: 4 },
  gifCell:   { flex: 1, margin: 2, height: 100, backgroundColor: '#111', borderRadius: 8, overflow: 'hidden' },
  gifImg:    { width: '100%', height: '100%' },
  empty:     { color: '#444', textAlign: 'center', marginTop: 40, fontSize: 14 },
});