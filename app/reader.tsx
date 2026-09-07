// app/reader.tsx — Chat Reader.
//
// "This message is easier as a page." A long chat message re-rendered with real
// typography instead of a 66%-wide bubble. Design: docs/design/mobile/
// m19-reader (the page) and m20-reader-settings (the controls).
//
// The text is passed in already DECRYPTED by the caller — the Reader never
// touches ciphertext, never fetches, and never writes the message anywhere. It
// is a rendering surface over a string, which is what keeps it out of the E2EE
// story entirely.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { paginate, readStats, formatStats, toBlocks, type Block } from '../lib/reader';
import {
  MARGIN_PX, READER_THEMES, SIZE_MAX, SIZE_MIN, SPACING_MAX, SPACING_MIN,
  getReaderSettingsCached, resetReaderSettings, setReaderSettings,
  type ReaderSettings,
} from '../lib/readerSettings';

const FONT_FAMILY: Record<ReaderSettings['font'], string | undefined> = {
  serif: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  sans: undefined,                                   // the platform UI font
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
};

function ReaderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ text: string; title?: string; author?: string; at?: string }>();

  const body = (params.text || '') + '';
  const title = (params.title || '') + '';
  const author = (params.author || '') + '';

  // Cached settings paint immediately; the async read only matters if another
  // screen changed them since this module was loaded.
  const [cfg, setCfg] = useState<ReaderSettings>(getReaderSettingsCached());
  const [showSettings, setShowSettings] = useState(false);
  const [page, setPage] = useState(0);

  const stats = useMemo(() => readStats(body), [body]);
  const blocks = useMemo(() => toBlocks(body), [body]);
  const pages = useMemo(() => (cfg.layout === 'pages' ? paginate(blocks) : [blocks]), [blocks, cfg.layout]);

  useEffect(() => { setPage(p => Math.min(p, Math.max(0, pages.length - 1))); }, [pages.length]);

  const apply = useCallback(async (patch: Partial<ReaderSettings>) => {
    setCfg(await setReaderSettings(patch));
  }, []);

  const theme = READER_THEMES[cfg.theme];
  const pad = MARGIN_PX[cfg.margins];
  const fontFamily = FONT_FAMILY[cfg.font];

  const renderBlock = (b: Block, i: number) => {
    const common = { color: theme.text, fontFamily, lineHeight: cfg.size * cfg.spacing };
    switch (b.kind) {
      case 'heading':
        return (
          <Text key={i} style={[common, { fontSize: cfg.size + 5, fontWeight: '700', marginTop: 26, marginBottom: 8, lineHeight: (cfg.size + 5) * 1.3 }]}>
            {b.text}
          </Text>
        );
      case 'bullet':
        return (
          <View key={i} style={{ flexDirection: 'row', marginTop: 8, paddingRight: 6 }}>
            <Text style={[common, { fontSize: cfg.size, marginRight: 10 }]}>•</Text>
            <Text style={[common, { fontSize: cfg.size, flex: 1 }]}>{b.text}</Text>
          </View>
        );
      case 'quote':
        return (
          <View key={i} style={{ flexDirection: 'row', marginTop: 16 }}>
            <View style={{ width: 3, borderRadius: 2, backgroundColor: theme.dim, marginRight: 12 }} />
            <Text style={[common, { fontSize: cfg.size, flex: 1, fontStyle: 'italic', color: theme.dim }]}>{b.text}</Text>
          </View>
        );
      default:
        return <Text key={i} style={[common, { fontSize: cfg.size, marginTop: 16 }]}>{b.text}</Text>;
    }
  };

  const atLabel = params.at ? new Date(String(params.at)).toLocaleString() : '';

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle={cfg.theme === 'light' || cfg.theme === 'sepia' ? 'dark-content' : 'light-content'} />

      {/* Header */}
      <View style={[st.head, { paddingTop: insets.top + 8, borderBottomColor: theme.dim + '22' }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-down" size={26} color={theme.text} />
        </TouchableOpacity>
        <Text style={[st.headTitle, { color: theme.dim }]} numberOfLines={1}>
          {title || 'Reader'}
        </Text>
        <TouchableOpacity onPress={() => setShowSettings(true)} hitSlop={12}>
          <Ionicons name="text" size={22} color={theme.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: insets.bottom + 48 }}
        showsVerticalScrollIndicator={false}
      >
        <Text numberOfLines={1} style={{ color: theme.text, fontFamily, fontSize: cfg.size + 12, fontWeight: '800', marginTop: 24, lineHeight: (cfg.size + 12) * 1.2 }}>
          {title || 'Long message'}
        </Text>
        <Text style={{ color: theme.dim, fontSize: 13, marginTop: 10 }}>
          {[author, atLabel].filter(Boolean).join(' · ')}
        </Text>
        <Text style={{ color: theme.dim, fontSize: 12, marginTop: 4 }}>{formatStats(stats)}</Text>
        <View style={{ height: 1, backgroundColor: theme.dim + '22', marginTop: 18 }} />

        {(pages[page] ?? []).map(renderBlock)}

        {cfg.layout === 'pages' && pages.length > 1 && (
          <View style={st.pager}>
            <TouchableOpacity disabled={page === 0} onPress={() => setPage(p => p - 1)} hitSlop={10}>
              <Ionicons name="chevron-back" size={22} color={page === 0 ? theme.dim + '55' : theme.text} />
            </TouchableOpacity>
            <Text style={{ color: theme.dim, fontSize: 13 }}>{page + 1} / {pages.length}</Text>
            <TouchableOpacity disabled={page >= pages.length - 1} onPress={() => setPage(p => p + 1)} hitSlop={10}>
              <Ionicons name="chevron-forward" size={22} color={page >= pages.length - 1 ? theme.dim + '55' : theme.text} />
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* ── Settings sheet ─────────────────────────────────────────── */}
      <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <Pressable style={st.scrim} onPress={() => setShowSettings(false)} />
        <View style={[st.sheet, { backgroundColor: theme.bg, borderColor: theme.dim + '33', paddingBottom: insets.bottom + 16, maxHeight: '80%' }]}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={[st.sheetTitle, { color: theme.text }]}>Reader settings</Text>

            <Seg label="Theme" theme={theme}
              options={[['dark', 'Dark'], ['light', 'Light'], ['sepia', 'Sepia'], ['oled', 'OLED']]}
              value={cfg.theme} onChange={v => apply({ theme: v as ReaderSettings['theme'] })} />

            <Seg label="Font" theme={theme}
              options={[['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Mono']]}
              value={cfg.font} onChange={v => apply({ font: v as ReaderSettings['font'] })} />

            <Stepper label="Text size" theme={theme} value={`${cfg.size}px`}
              onDec={() => apply({ size: Math.max(SIZE_MIN, cfg.size - 1) })}
              onInc={() => apply({ size: Math.min(SIZE_MAX, cfg.size + 1) })} />

            <Stepper label="Line spacing" theme={theme} value={cfg.spacing.toFixed(1)}
              onDec={() => apply({ spacing: Math.max(SPACING_MIN, +(cfg.spacing - 0.1).toFixed(1)) })}
              onInc={() => apply({ spacing: Math.min(SPACING_MAX, +(cfg.spacing + 0.1).toFixed(1)) })} />

            <Seg label="Margins" theme={theme}
              options={[['narrow', 'Narrow'], ['comfortable', 'Comfortable'], ['wide', 'Wide']]}
              value={cfg.margins} onChange={v => apply({ margins: v as ReaderSettings['margins'] })} />

            <Seg label="Layout" theme={theme}
              options={[['scroll', 'Scroll'], ['pages', 'Pages']]}
              value={cfg.layout} onChange={v => apply({ layout: v as ReaderSettings['layout'] })} />

            <View style={st.sheetActions}>
              <TouchableOpacity onPress={async () => setCfg(await resetReaderSettings())}>
                <Text style={{ color: theme.dim, fontSize: 15, fontWeight: '600' }}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowSettings(false)}>
                <Text style={{ color: theme.text, fontSize: 15, fontWeight: '700' }}>Done</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function Seg({ label, options, value, onChange, theme }: {
  label: string; options: [string, string][]; value: string;
  onChange: (v: string) => void; theme: { text: string; dim: string; bg: string };
}) {
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={{ color: theme.dim, fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 8 }}>
        {label.toUpperCase()}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {options.map(([v, lbl]) => {
          const on = v === value;
          return (
            <TouchableOpacity key={v} onPress={() => onChange(v)} activeOpacity={0.8}
              style={{
                paddingVertical: 9, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1,
                borderColor: on ? theme.text : theme.dim + '44',
                backgroundColor: on ? theme.text + '18' : 'transparent',
              }}>
              <Text style={{ color: on ? theme.text : theme.dim, fontSize: 14, fontWeight: on ? '700' : '500' }}>{lbl}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function Stepper({ label, value, onDec, onInc, theme }: {
  label: string; value: string; onDec: () => void; onInc: () => void;
  theme: { text: string; dim: string };
}) {
  return (
    <View style={{ marginTop: 20, flexDirection: 'row', alignItems: 'center' }}>
      <Text style={{ color: theme.dim, fontSize: 12, fontWeight: '700', letterSpacing: 1, flex: 1 }}>
        {label.toUpperCase()}
      </Text>
      <TouchableOpacity onPress={onDec} hitSlop={10}><Ionicons name="remove-circle-outline" size={26} color={theme.text} /></TouchableOpacity>
      <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600', minWidth: 56, textAlign: 'center' }}>{value}</Text>
      <TouchableOpacity onPress={onInc} hitSlop={10}><Ionicons name="add-circle-outline" size={26} color={theme.text} /></TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 26, marginTop: 36 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1,
    paddingHorizontal: 20, paddingTop: 18,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  sheetActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 4 },
});

// A render fault in a viewer used to take the WHOLE app down: these screens
// render untrusted, arbitrary media (a truncated video, a malformed PDF, an
// office file with a codec this device lacks) and none of them were wrapped.
// The boundary turns that crash into a dismissable screen with the chat intact.
export default function ReaderScreenBoundary() {
  return (
    <ErrorBoundary screen="ReaderScreen" fallbackTitle="Reader Error" fallbackMessage="This document could not be read.">
      <ReaderScreen />
    </ErrorBoundary>
  );
}
