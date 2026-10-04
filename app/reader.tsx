// app/reader.tsx — Chat Reader.
//
// "This message is easier as a page." A long chat message re-rendered with real
// typography instead of a 66%-wide bubble. Design: docs/design/mobile/
// m19-reader (the page) and m20-reader-settings (the controls).
//
// The caller passes a chat + message id, and the Reader reads the already
// DECRYPTED body from the local message cache (or, for a row still stored as an
// envelope, the E2EE plaintext cache) — so plaintext never travels as a route
// param. Only an unsent message (no server id yet) arrives as `text`. The Reader never touches ciphertext, never
// fetches, and never writes the message anywhere.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  ActivityIndicator, Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text,
  TouchableOpacity, View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { paginate, readStats, formatStats, toBlocks, type Block } from '../lib/reader';
import { getCachedMessagesByIds } from '../lib/localDb';
import { looksEncrypted } from '../lib/chatService';
import { E2EE_UNDECRYPTABLE, e2eeGetCached } from '../services/crypto/e2eeSession.rn';
import {
  MARGIN_PX, READER_THEMES, SIZE_MAX, SIZE_MIN, SPACING_MAX, SPACING_MIN,
  getReaderSettingsCached, resetReaderSettings, setReaderSettings,
  type ReaderSettings,
} from '../lib/readerSettings';
import { AuroraDark } from '../constants/theme';

const FONT_FAMILY: Record<ReaderSettings['font'], string | undefined> = {
  serif: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  sans: undefined,                                   // the platform UI font
  mono: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
};

/** `#RRGGBB` at opacity `a`. The reader palettes are fixed 6-digit hex
 *  (lib/readerSettings READER_THEMES), so this replaces string-appended
 *  alpha suffixes with one checked conversion. */
function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function ReaderScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    chatId?: string; id?: string; text?: string; title?: string; author?: string; at?: string;
  }>();

  const msgId = Number(params.id) || 0;
  const fromCache = !!params.chatId && msgId > 0;
  // null = still reading the cache (renders blank, not "Nothing to read").
  const [cached, setCached] = useState<string | null>(fromCache ? null : '');
  // A failed cache READ is an error with Retry, not "no longer available".
  const [readFailed, setReadFailed] = useState(false);
  // Why an empty read is empty: the row is not in this device's store yet
  // (a server message the chat has not saved locally), or it is stored only
  // as ciphertext this device has no plaintext for. Neither means "deleted".
  const [unavailable, setUnavailable] = useState<null | 'notHere' | 'locked'>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!fromCache) return;
    let live = true;
    setReadFailed(false);
    setUnavailable(null);
    setCached(null);
    getCachedMessagesByIds(params.chatId!, [msgId])
      .then(async ([m]) => {
        let text = '';
        if (m?.content && !looksEncrypted(m.content)) text = m.content;
        else if (m?.content) {
          // A row still stored as an envelope that the bubble decrypted itself:
          // its plaintext is in the E2EE cache, checked against this ciphertext.
          const pt = await e2eeGetCached(params.chatId!, msgId, m.content);
          if (pt && pt !== E2EE_UNDECRYPTABLE) text = pt;
        }
        if (!live) return;
        setUnavailable(!m ? 'notHere' : m.content && !text ? 'locked' : null);
        setCached(text);
      })
      .catch(() => { if (live) { setReadFailed(true); setCached(''); } });
    return () => { live = false; };
  }, [fromCache, params.chatId, msgId, reloadKey]);
  const body = fromCache ? (cached ?? '') : (params.text || '') + '';
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

  // A new page opens at its top, not at the previous page's scroll offset.
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ y: 0, animated: false }); }, [page]);

  const apply = useCallback(async (patch: Partial<ReaderSettings>) => {
    setCfg(await setReaderSettings(patch));
  }, []);

  const theme = READER_THEMES[cfg.theme];
  const rule = withAlpha(theme.dim, 0.13);
  const pad = MARGIN_PX[cfg.margins];
  const fontFamily = FONT_FAMILY[cfg.font];

  const renderBlock = (b: Block, i: number) => {
    const common = { color: theme.text, fontFamily, lineHeight: cfg.size * cfg.spacing };
    switch (b.kind) {
      case 'heading':
        return (
          <Text key={i} style={[common, st.heading, { fontSize: cfg.size + 5, lineHeight: (cfg.size + 5) * 1.3 }]}>
            {b.text}
          </Text>
        );
      case 'bullet':
        return (
          <View key={i} style={st.bullet}>
            <Text style={[common, st.bulletDot, { fontSize: cfg.size }]}>•</Text>
            <Text style={[common, st.flex, { fontSize: cfg.size }]}>{b.text}</Text>
          </View>
        );
      case 'quote':
        return (
          <View key={i} style={st.quote}>
            <View style={[st.quoteBar, { backgroundColor: theme.dim }]} />
            <Text style={[common, st.quoteText, { fontSize: cfg.size, color: theme.dim }]}>{b.text}</Text>
          </View>
        );
      default:
        return <Text key={i} style={[common, st.para, { fontSize: cfg.size }]}>{b.text}</Text>;
    }
  };

  const atLabel = params.at ? new Date(String(params.at)).toLocaleString() : '';

  return (
    <View style={[st.flex, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle={cfg.theme === 'light' || cfg.theme === 'sepia' ? 'dark-content' : 'light-content'} />

      {/* Header */}
      <View style={[st.head, { paddingTop: insets.top + 8, borderBottomColor: rule }]}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Close the reader" hitSlop={12}>
          <Ionicons name="chevron-down" size={26} color={theme.text} />
        </TouchableOpacity>
        <Text style={[st.headTitle, { color: theme.dim }]} numberOfLines={1}>
          {title || 'Reader'}
        </Text>
        <TouchableOpacity onPress={() => setShowSettings(true)} accessibilityRole="button" accessibilityLabel="Reading settings" hitSlop={12}>
          <Ionicons name="text" size={22} color={theme.text} />
        </TouchableOpacity>
      </View>

      {cached === null ? (
        <ActivityIndicator style={st.loading} color={theme.dim} accessibilityLabel="Loading message" />
      ) : readFailed ? (
        <View style={st.state} accessibilityLiveRegion="polite">
          <Ionicons name="alert-circle-outline" size={44} color={theme.dim} />
          <Text accessibilityRole="header" style={[st.stateTitle, { color: theme.text }]}>Couldn’t open this message</Text>
          <Text style={[st.stateBody, { color: theme.dim }]}>It could not be read from this device’s storage.</Text>
          <TouchableOpacity onPress={() => setReloadKey(k => k + 1)} accessibilityRole="button" accessibilityLabel="Retry"
            style={st.stateBtn}>
            <Text style={[st.stateBtnTxt, { color: theme.text }]}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : !body.trim() ? (
        // Reached without a message (bare deep link), or the message is not
        // readable on this device: say which, rather than render
        // "Long message · 0 words" or claim a message that exists is gone.
        <View style={st.state} accessibilityLiveRegion="polite">
          <Ionicons name="document-text-outline" size={44} color={theme.dim} />
          <Text accessibilityRole="header" style={[st.stateTitle, { color: theme.text }]}>
            {unavailable === 'notHere' ? 'Not on this device yet' : unavailable === 'locked' ? 'Can’t show this message here' : 'Nothing to read'}
          </Text>
          <Text style={[st.stateBody, { color: theme.dim }]}>
            {unavailable === 'notHere'
              ? 'This message hasn’t been saved on this device yet. Go back to the chat, let it finish loading, then try again.'
              : unavailable === 'locked'
                ? 'This message is end-to-end encrypted and hasn’t been decrypted on this device. Open it in the chat first, then try again.'
                : 'This message is no longer available.'}
          </Text>
          {unavailable && (
            <TouchableOpacity onPress={() => setReloadKey(k => k + 1)} accessibilityRole="button" accessibilityLabel="Try again"
              style={st.stateBtn}>
              <Text style={[st.stateBtnTxt, { color: theme.text }]}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
      <ScrollView
        ref={scrollRef}
        style={st.flex}
        contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: insets.bottom + 48 }}
        showsVerticalScrollIndicator={false}
      >
        <Text numberOfLines={1} style={[st.pageTitle, { color: theme.text, fontFamily, fontSize: cfg.size + 12, lineHeight: (cfg.size + 12) * 1.2 }]}>
          {title || 'Long message'}
        </Text>
        <Text style={[st.byline, { color: theme.dim }]}>
          {[author, atLabel].filter(Boolean).join(' · ')}
        </Text>
        <Text style={[st.stats, { color: theme.dim }]}>{formatStats(stats)}</Text>
        <View style={[st.rule, { backgroundColor: rule }]} />

        {(pages[page] ?? []).map(renderBlock)}

        {cfg.layout === 'pages' && pages.length > 1 && (
          <View style={st.pager}>
            <TouchableOpacity disabled={page === 0} onPress={() => setPage(p => p - 1)} accessibilityRole="button" accessibilityLabel="Previous page" accessibilityState={{ disabled: page === 0 }} hitSlop={10}>
              <Ionicons name="chevron-back" size={22} color={page === 0 ? withAlpha(theme.dim, 0.33) : theme.text} />
            </TouchableOpacity>
            <Text style={[st.pageNum, { color: theme.dim }]}>{page + 1} / {pages.length}</Text>
            <TouchableOpacity disabled={page >= pages.length - 1} onPress={() => setPage(p => p + 1)} accessibilityRole="button" accessibilityLabel="Next page" accessibilityState={{ disabled: page >= pages.length - 1 }} hitSlop={10}>
              <Ionicons name="chevron-forward" size={22} color={page >= pages.length - 1 ? withAlpha(theme.dim, 0.33) : theme.text} />
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      )}

      {/* ── Settings sheet ─────────────────────────────────────────── */}
      <Modal visible={showSettings} transparent animationType="slide" onRequestClose={() => setShowSettings(false)}>
        <Pressable style={st.scrim} onPress={() => setShowSettings(false)} accessibilityRole="button" accessibilityLabel="Close reading settings" />
        <View style={[st.sheet, { backgroundColor: theme.bg, borderColor: withAlpha(theme.dim, 0.2), paddingBottom: insets.bottom + 16 }]}>
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
              <TouchableOpacity onPress={async () => setCfg(await resetReaderSettings())} accessibilityRole="button" accessibilityLabel="Reset reading settings">
                <Text style={[st.resetTxt, { color: theme.dim }]}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowSettings(false)} accessibilityRole="button" accessibilityLabel="Done">
                <Text style={[st.doneTxt, { color: theme.text }]}>Done</Text>
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
    <View style={st.group}>
      <Text style={[st.groupLabel, { color: theme.dim }]}>
        {label.toUpperCase()}
      </Text>
      <View style={st.segRow}>
        {options.map(([v, lbl]) => {
          const on = v === value;
          return (
            <TouchableOpacity key={v} onPress={() => onChange(v)} activeOpacity={0.8}
              accessibilityRole="radio" accessibilityLabel={`${label}: ${lbl}`} accessibilityState={{ selected: on }}
              style={[st.seg, {
                borderColor: on ? theme.text : withAlpha(theme.dim, 0.27),
                backgroundColor: on ? withAlpha(theme.text, 0.09) : 'transparent',
              }]}>
              <Text style={[st.segTxt, on && st.segTxtOn, { color: on ? theme.text : theme.dim }]}>{lbl}</Text>
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
    <View style={[st.group, st.stepRow]}>
      <Text style={[st.groupLabel, st.stepLabel, { color: theme.dim }]}>
        {label.toUpperCase()}
      </Text>
      <TouchableOpacity onPress={onDec} accessibilityRole="button" accessibilityLabel={`Decrease ${label.toLowerCase()}`} hitSlop={10}><Ionicons name="remove-circle-outline" size={26} color={theme.text} /></TouchableOpacity>
      <Text style={[st.stepValue, { color: theme.text }]}>{value}</Text>
      <TouchableOpacity onPress={onInc} accessibilityRole="button" accessibilityLabel={`Increase ${label.toLowerCase()}`} hitSlop={10}><Ionicons name="add-circle-outline" size={26} color={theme.text} /></TouchableOpacity>
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1 },
  loading: { marginTop: 48 },
  heading: { fontWeight: '700', marginTop: 26, marginBottom: 8 },
  bullet: { flexDirection: 'row', marginTop: 8, paddingRight: 6 },
  bulletDot: { marginRight: 10 },
  quote: { flexDirection: 'row', marginTop: 16 },
  quoteBar: { width: 3, borderRadius: 2, marginRight: 12 },
  quoteText: { flex: 1, fontStyle: 'italic' },
  para: { marginTop: 16 },
  pageTitle: { fontWeight: '800', marginTop: 24 },
  byline: { fontSize: 13, marginTop: 10 },
  stats: { fontSize: 12, marginTop: 4 },
  rule: { height: 1, marginTop: 18 },
  pageNum: { fontSize: 13 },
  resetTxt: { fontSize: 15, fontWeight: '600' },
  doneTxt: { fontSize: 15, fontWeight: '700' },
  group: { marginTop: 20 },
  groupLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  segRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  seg: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1 },
  segTxt: { fontSize: 14, fontWeight: '500' },
  segTxtOn: { fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'center' },
  stepLabel: { flex: 1, marginBottom: 0 },
  stepValue: { fontSize: 15, fontWeight: '600', minWidth: 56, textAlign: 'center' },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 26, marginTop: 36 },
  // The reader has its own palettes (paper/sepia/night), not the app theme, so
  // the scrim is the fixed dark token over all of them (0.6 ≥ the old 0.55).
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: AuroraDark.scrim },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '80%',
    borderTopLeftRadius: 22, borderTopRightRadius: 22, borderTopWidth: 1,
    paddingHorizontal: 20, paddingTop: 18,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  sheetActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, marginBottom: 4 },
  // Error / nothing-to-read states
  state: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  stateTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  stateBody: { fontSize: 14, textAlign: 'center' },
  stateBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 20 },
  stateBtnTxt: { fontSize: 15, fontWeight: '700' },
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
