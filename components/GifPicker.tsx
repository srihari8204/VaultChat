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
// Vector marks: crisp at any size, and immune to the aspect-ratio mis-scaling
// that a raster suffers under resizeMode="contain".
import KlipyBlack from '../assets/klipy/powered-by-klipy-black.svg';
import KlipyWhite from '../assets/klipy/powered-by-klipy-white.svg';

/** Powered by KLIPY, themed. viewBox 640x107.3 = 5.97, so sizes keep that ratio. */
function KlipyMark({ scheme, width }: { scheme: string; width: number }) {
  const Mark = scheme === 'light' ? KlipyBlack : KlipyWhite;
  return <Mark width={width} height={Math.round(width / 5.97)} accessibilityLabel="Powered by KLIPY" />;
}

interface GifResult {
  id: string;
  url: string;      // animated GIF url (sendable + renders in <Image>)
  preview: string;
  width: number;
  height: number;
}

/** The three KLIPY collections we expose. `type` is the server's query param. */
const TABS = [
  { type: 'gifs',     label: 'GIFs' },
  { type: 'stickers', label: 'Stickers' },
  { type: 'emojis',   label: 'Emojis' },
] as const;
type TabType = typeof TABS[number]['type'];

/**
 * REQUIRED by KLIPY's attribution guideline, and it does not vary by tab: the
 * placeholder must read exactly "Search KLIPY", with the brand fully
 * capitalised, so the source of the content library is identifiable from the
 * search bar itself.
 *
 * Attribution compliance is a stated condition of production API approval, so
 * this is not a wording preference — a per-tab "Search GIFs…" fails it.
 */
const SEARCH_PLACEHOLDER = 'Search KLIPY';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (url: string, previewUrl: string) => void;
  /**
   * Which collection to open on. The composer's single button is a STICKER, so
   * it opens on stickers; anything else opening this sheet can still land on
   * GIFs. All three tabs are the same Klipy code path, only `type` differs.
   */
  initialTab?: TabType;
}

export default function GifPicker({ visible, onClose, onSelect, initialTab = 'gifs' }: Props) {
  const { colors, scheme } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [tab,     setTab]     = useState<TabType>(initialTab);
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [note,    setNote]    = useState('');   // shown when there's nothing to display
  // Tapping a tile opens a preview instead of sending outright — see the
  // dialog at the bottom of this file for why.
  const [preview, setPreview] = useState<GifResult | null>(null);

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
    setPreview(null);
    search(query, tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, tab]);

  // Reset to a clean sheet on close, or reopening shows the last search.
  useEffect(() => { if (!visible) { setQuery(''); setResults([]); setNote(''); setPreview(null); } }, [visible]);

  if (!visible) return null;

  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={() => {}}>
        <View style={s.handle} />

        <View style={s.searchRow}>
          <TextInput
            style={s.input}
            placeholder={SEARCH_PLACEHOLDER}
            placeholderTextColor={colors.textDim}
            value={query}
            onChangeText={q => { setQuery(q); queueSearch(q, tab); }}
            autoFocus
          />
          {/* "Powered by KLIPY" belongs NEXT TO THE SEARCH BAR and must stay
              visible the whole time the selector is open — that is where their
              guideline puts it, and it is why this sits in the search row
              rather than at the foot of the sheet where a long grid can push
              it out of view. Black on light, white on dark, from the brand pack. */}
          <KlipyMark scheme={scheme} width={92} />
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
              onPress={() => setPreview(item)}
            >
              {/* contain, not cover: stickers and emojis are transparent and
                  non-square, and cropping them cuts the subject off. */}
              <Image source={{ uri: item.preview }} style={s.gifImg} resizeMode="contain" />
            </TouchableOpacity>
          )}
          ListEmptyComponent={!loading ? <Text style={s.empty}>{note || 'Type to search'}</Text> : null}
        />

        {/* PREVIEW BEFORE SEND — the guideline's "Version 2", and the WhatsApp
            behaviour: a tile is a choice, not a send. Two reasons it earns its
            place beyond attribution: a grid tile is 100px and you cannot really
            tell what you are about to send, and a mis-tap in a 3-wide grid used
            to put the wrong GIF in someone's chat with no undo.

            It is also the second sanctioned home for the KLIPY mark — the
            guideline names "the preview area" alongside the search bar — and
            here it sits directly under the content it is attributing, at full
            size, which is the clearest placement in the app. */}
        {preview && (
          <Pressable style={s.previewBackdrop} onPress={() => setPreview(null)}>
            <Pressable style={s.previewCard} onPress={() => {}}>
              <Image source={{ uri: preview.preview }} style={s.previewImg} resizeMode="contain" />

              <KlipyMark scheme={scheme} width={132} />

              <View style={s.previewActions}>
                <TouchableOpacity style={s.previewCancel} onPress={() => setPreview(null)} activeOpacity={0.8}>
                  <Text style={s.previewCancelTxt}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.previewSend}
                  onPress={() => { const p = preview; setPreview(null); onSelect(p.url, p.preview); onClose(); }}
                  activeOpacity={0.85}
                >
                  <Ionicons name="send" size={16} color="#fff" />
                  <Text style={s.previewSendTxt}>Send</Text>
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        )}
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

  previewBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                     backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  previewCard:     { width: '100%', maxWidth: 340, backgroundColor: c.surfaceSolid, borderRadius: 18,
                     padding: 16, alignItems: 'center', gap: 12 },
  previewImg:      { width: '100%', height: 240, borderRadius: 12, backgroundColor: c.surface },
  previewActions:  { flexDirection: 'row', gap: 10, width: '100%' },
  previewCancel:   { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
                     backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  previewCancelTxt:{ color: c.textDim, fontSize: 15, fontWeight: '700' },
  previewSend:     { flex: 2, flexDirection: 'row', gap: 8, paddingVertical: 12, borderRadius: 12,
                     alignItems: 'center', justifyContent: 'center', backgroundColor: c.primary },
  previewSendTxt:  { color: '#fff', fontSize: 15, fontWeight: '800' },
});
