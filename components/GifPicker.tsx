// components/GifPicker.tsx
// Search and pick GIFs using Tenor API (free public key)
// Get your own key free at: https://tenor.com/developer/dashboard

import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  Image, StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';

// Replace with your own free Tenor API key from tenor.com/developer
const TENOR_KEY = 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCPY';
const TENOR_URL = 'https://tenor.googleapis.com/v2/search';

interface GifResult {
  id: string;
  url: string;
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
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const url = `${TENOR_URL}?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=24&media_filter=gif,tinygif`;
      const res  = await fetch(url);
      const data = await res.json();
      const gifs: GifResult[] = (data.results ?? []).map((r: any) => ({
        id:      r.id,
        url:     r.media_formats?.gif?.url     ?? r.media_formats?.tinygif?.url ?? '',
        preview: r.media_formats?.tinygif?.url ?? r.media_formats?.gif?.url     ?? '',
        width:   r.media_formats?.tinygif?.dims?.[0] ?? 100,
        height:  r.media_formats?.tinygif?.dims?.[1] ?? 100,
      }));
      setResults(gifs);
    } catch { setResults([]); }
    finally { setLoading(false); }
  }, []);

  if (!visible) return null;

  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={() => {}}>
        <View style={s.handle} />
        <View style={s.searchRow}>
          <TextInput
            style={s.input}
            placeholder="Search GIFsâ€¦"
            placeholderTextColor="#444"
            value={query}
            onChangeText={q => { setQuery(q); search(q); }}
            autoFocus
          />
          <TouchableOpacity onPress={onClose}>
            <Text style={s.closeX}>âœ•</Text>
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