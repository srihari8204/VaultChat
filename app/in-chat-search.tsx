// app/in-chat-search.tsx — In-Chat Message Search (on-device, zero-knowledge).
//
// Searches the DECRYPTED local message store via searchInChat — the server only
// holds ciphertext and never sees the query or the content. Covers the chat
// history cached on this device. Debounced, highlighted, Obsidian colors.
//
// Tapping a result hands the message id to the chat (lib/chatJump), which
// scrolls to it on focus.
//
// LOCKED CHATS (2026-10-04): this screen is reachable without opening the chat
// (Chats list avatar → contact-info → Search), so it applies the chat's own
// lock — the same factors app/chat.tsx enforces — before any search runs. An
// unreadable lock table fails closed.

import { brandAlpha, type Palette } from '../constants/theme';
import React, { useState, useEffect, useRef, useCallback , useMemo} from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { getLock, pinRetryAfterMs, verifyBiometric, verifyPin, type LockedChat } from '../lib/chatLock';
import { useLocalSearchParams, Stack, useRouter, useNavigation } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { searchInChat, type InChatMessageHit } from '../lib/chatService';
import { setPendingJump } from '../lib/chatJump';
import { AuroraBackground, KeyboardSafe } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const ResultGap = () => <View style={{ height: 8 }} />;
// searchInChat's cap per page; a full page says so and offers the next one.
const HIT_LIMIT = 80;

export default function InChatSearchScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const navigation = useNavigation();
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const inputRef = useRef<TextInput>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqSeq = useRef(0);

  const [query, setQuery] = useState('');
  // Grows by HIT_LIMIT with "Show more matches"; a new query starts over.
  const [limit, setLimit] = useState(HIT_LIMIT);
  const onQuery = useCallback((t: string) => { setQuery(t); setLimit(HIT_LIMIT); }, []);
  const [results, setResults] = useState<InChatMessageHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Try again to re-run the same query.
  const [retryKey, setRetryKey] = useState(0);

  // The chat's lock, satisfied before anything is searched.
  const [gate, setGate] = useState<'checking' | 'locked' | 'unreadable' | 'open'>('checking');
  const [lockInfo, setLockInfo] = useState<LockedChat | null>(null);
  const [lockBio, setLockBio] = useState(false);   // 'both': biometric half done
  const [lockPin, setLockPin] = useState('');
  const [lockErr, setLockErr] = useState<string | null>(null);
  // Bumped by Try again on an unreadable lock to re-run the check.
  const [gateKey, setGateKey] = useState(0);

  const tryBiometric = useCallback(async (lock: LockedChat) => {
    if (!(await verifyBiometric('Unlock this chat to search it'))) return;
    if (lock.lockMethod === 'both') { setLockBio(true); return; }
    setGate('open');
  }, []);

  useEffect(() => {
    let cancel = false;
    setGate('checking');
    (async () => {
      if (!chatId) { setGate('open'); return; }   // nothing to search anyway
      let lock: LockedChat | null;
      try { lock = await getLock(chatId); }
      catch { if (!cancel) setGate('unreadable'); return; }   // fail closed
      if (cancel) return;
      setLockInfo(lock); setLockBio(false); setLockPin(''); setLockErr(null);
      if (!lock) { setGate('open'); return; }
      setGate('locked');
      if (lock.lockMethod !== 'pin') await tryBiometric(lock);
    })();
    return () => { cancel = true; };
  }, [chatId, tryBiometric, gateKey]);

  const submitLockPin = () => {
    if (!lockInfo) return;
    if (!verifyPin(lockInfo, lockPin)) {
      const wait = pinRetryAfterMs(lockInfo);
      setLockPin('');
      setLockErr(wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` : 'Incorrect PIN');
      return;
    }
    // The PIN is the SECOND factor on a 'both' chat, never the only one.
    if (lockInfo.lockMethod === 'both' && !lockBio) {
      setLockErr('This chat needs biometrics too — tap “Use biometrics”.');
      return;
    }
    setLockPin(''); setLockErr(null); setGate('open');
  };

  // Debounced on-device search (lib/localDb via searchInChat). A monotonically increasing reqSeq guards
  // against out-of-order responses overwriting a newer query's results.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    // Invalidate an in-flight request immediately when the text changes; doing
    // this inside the timer leaves a 300 ms window where stale results can win.
    const seq = ++reqSeq.current;
    const term = query.trim();
    if (!chatId || !term || gate !== 'open') { setResults([]); setLoading(false); setError(null); return; }
    setLoading(true);
    debounce.current = setTimeout(async () => {
      try {
        const hits = await searchInChat(chatId, term, limit);
        if (seq === reqSeq.current) { setResults(hits); setError(null); }
      } catch {
        // The local store failed (it is on-device, so not a network error);
        // the raw SQLite message means nothing to the user.
        if (seq === reqSeq.current) { setError('The messages saved on this device could not be searched.'); setResults([]); }
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, 300);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [query, chatId, gate, retryKey, limit]);

  // Auto-focus the input once the chat is open to search.
  useEffect(() => {
    if (gate !== 'open') return;
    const t = setTimeout(() => inputRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, [gate]);

  const formatTime = useCallback((iso: string) => {
    try {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      const days = Math.floor(diff / 86400000);
      if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (days === 1) return 'Yesterday';
      if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch { return ''; }
  }, []);

  const highlightMatch = useCallback((text: string, q: string) => {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    if (idx === -1) return <Text style={s.msgText} numberOfLines={2}>{text}</Text>;
    const match = text.substring(idx, idx + q.length);
    // Trim context: up to 40 chars before, 60 after, with ellipses.
    const startCtx = Math.max(0, idx - 40);
    const endCtx = Math.min(text.length, idx + q.length + 60);
    const prefix = startCtx > 0 ? '…' : '';
    const suffix = endCtx < text.length ? '…' : '';
    return (
      <Text style={s.msgText} numberOfLines={2}>
        {prefix}{text.substring(startCtx, idx)}
        <Text style={s.highlight}>{match}</Text>
        {text.substring(idx + q.length, endCtx)}{suffix}
      </Text>
    );
  }, [s]);

  const onTapResult = useCallback((messageId: number) => {
    // Hand the target to the chat screen, then return to it; it scrolls there.
    if (!chatId) { router.back(); return; }
    setPendingJump(chatId, messageId);
    // Opened from the chat: go back to it. Opened from contact-info (Chats list
    // avatar → contact-info → Search): back would land on contact-info, so pop
    // to the chat if it is in the stack, or open it in place of this screen.
    const st = navigation.getState();
    if (st?.routes[st.index - 1]?.name === 'chat') router.back();
    else router.dismissTo({ pathname: '/chat', params: { id: chatId } });
  }, [chatId, router, navigation]);

  const term = query.trim();
  const renderItem = useCallback(({ item }: { item: InChatMessageHit }) => (
    <TouchableOpacity
      style={s.resultCard}
      activeOpacity={0.7}
      onPress={() => onTapResult(item.id)}
      accessibilityRole="button"
      accessibilityLabel={`${item.senderName || 'Unknown'}, ${formatTime(item.createdAt)}: ${item.content}`}
      accessibilityHint="Opens the chat at this message"
    >
      <View style={s.resultHeader}>
        <Text style={s.senderName} numberOfLines={1}>{item.senderName || 'Unknown'}</Text>
        <Text style={s.timestamp}>{formatTime(item.createdAt)}</Text>
      </View>
      {highlightMatch(item.content, term)}
    </TouchableOpacity>
  ), [s, onTapResult, formatTime, highlightMatch, term]);

  const hasQuery = query.trim().length > 0;
  // Fetching the next page keeps the current matches on screen.
  const loadingMore = loading && limit > HIT_LIMIT && results.length > 0;

  if (gate !== 'open') {
    const m = lockInfo?.lockMethod;
    return (
      // KeyboardSafe: the PIN input is centred and would sit under the keyboard.
      <KeyboardSafe style={s.root}>
        <AuroraBackground />
        <Stack.Screen options={{ headerShown: false }} />
        <View style={s.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
        <View style={s.center}>
          {gate === 'checking' ? <ActivityIndicator size="large" color={colors.primary} /> : (
            <>
              <Ionicons name="lock-closed" size={48} color={colors.textDim} />
              <Text style={s.emptyTitle}>{gate === 'unreadable' ? 'Can’t search this chat' : 'This chat is locked'}</Text>
              <Text style={s.emptySubtitle}>
                {gate === 'unreadable'
                  ? 'The chat lock settings could not be read, so this chat cannot be searched.'
                  : m === 'both' ? 'Unlock it with biometrics and its PIN to search it.'
                  : m === 'biometric' ? 'Unlock it with biometrics to search it.'
                  : 'Enter its PIN to search it.'}
              </Text>
              {gate === 'unreadable' && (
                <TouchableOpacity style={s.unlockBtn} onPress={() => setGateKey(k => k + 1)} accessibilityRole="button">
                  <Text style={s.unlockTxt}>Try again</Text>
                </TouchableOpacity>
              )}
              {gate === 'locked' && lockInfo && (
                <>
                  {(m === 'biometric' || m === 'both') && !lockBio && (
                    <TouchableOpacity style={s.unlockBtn} onPress={() => tryBiometric(lockInfo)} accessibilityRole="button">
                      <Text style={s.unlockTxt}>Use biometrics</Text>
                    </TouchableOpacity>
                  )}
                  {!!lockInfo.pinHash && (
                    <>
                      <TextInput
                        style={s.pinInput}
                        value={lockPin}
                        onChangeText={(t) => { setLockPin(t.replace(/\D/g, '').slice(0, 8)); setLockErr(null); }}
                        keyboardType="number-pad"
                        secureTextEntry
                        maxLength={8}
                        placeholder="Chat PIN"
                        placeholderTextColor={colors.textFaint}
                        onSubmitEditing={submitLockPin}
                        accessibilityLabel="Chat PIN"
                      />
                      <TouchableOpacity
                        style={[s.unlockBtn, lockPin.length < 4 && { opacity: 0.5 }]}
                        onPress={submitLockPin}
                        disabled={lockPin.length < 4}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: lockPin.length < 4 }}
                      >
                        <Text style={s.unlockTxt}>Unlock</Text>
                      </TouchableOpacity>
                    </>
                  )}
                  {!!lockErr && <Text style={[s.emptySubtitle, { color: colors.danger }]} accessibilityRole="alert" accessibilityLiveRegion="polite">{lockErr}</Text>}
                </>
              )}
            </>
          )}
        </View>
      </KeyboardSafe>
    );
  }

  return (
    <View style={s.root}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>

        <View style={s.searchBox}>
          <Ionicons name="search" size={18} color={colors.textDim} style={{ marginRight: 8 }} />
          <TextInput
            ref={inputRef}
            style={s.searchInput}
            placeholder="Search messages…"
            accessibilityLabel="Search messages in this chat"
            placeholderTextColor={colors.textFaint}
            value={query}
            onChangeText={onQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onQuery('')} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.textDim} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {hasQuery && (!loading || loadingMore) && !error && (
        <View style={s.badgeRow}>
          <View style={s.badge}>
            <Text style={s.badgeText}>
              {results.length >= limit
                ? `Showing the first ${limit} matches — type more to narrow it`
                : `${results.length} result${results.length !== 1 ? 's' : ''}`}
            </Text>
          </View>
        </View>
      )}

      {error ? (
        <View style={s.center}>
          <Ionicons name="alert-circle-outline" size={56} color={colors.danger} />
          <Text style={s.emptyTitle}>Couldn’t search</Text>
          <Text style={s.emptySubtitle} accessibilityRole="alert">{error}</Text>
          <TouchableOpacity style={s.unlockBtn} onPress={() => setRetryKey(k => k + 1)} accessibilityRole="button">
            <Text style={s.unlockTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : loading && !loadingMore ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.loadingText}>Searching…</Text>
        </View>
      ) : !hasQuery ? (
        <View style={s.center}>
          <Ionicons name="search-outline" size={64} color={colors.surfaceSolid} />
          <Text style={s.emptyTitle}>Search Messages</Text>
          <Text style={s.emptySubtitle}>Searches messages saved on this device — on-device and private.</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={s.center}>
          <Ionicons name="document-text-outline" size={64} color={colors.surfaceSolid} />
          <Text style={s.emptyTitle}>No Results</Text>
          <Text style={s.emptySubtitle}>No messages match “{query.trim()}”.</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={i => String(i.id)}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={ResultGap}
          ListFooterComponent={results.length >= limit ? (
            <TouchableOpacity
              style={s.moreBtn}
              onPress={() => setLimit(l => l + HIT_LIMIT)}
              disabled={loadingMore}
              accessibilityRole="button"
              accessibilityState={{ disabled: loadingMore, busy: loadingMore }}
            >
              {loadingMore ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading more matches" />
                : <Text style={s.moreTxt}>Show more matches</Text>}
            </TouchableOpacity>
          ) : null}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: HEADER_TOP,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  backBtn: { marginRight: 12 },
  // 2026-09-18: the 15sp input is ~30dp of line box at font scale 1.5 and the
  // pinned 42 clipped it. minHeight holds the same 42 at scale 1.0.
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.glassStroke,
    paddingHorizontal: 12,
    minHeight: 42,
    paddingVertical: 6,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 15, padding: 0 },
  badgeRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8 },
  badge: {
    backgroundColor: brandAlpha(0.13),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  badgeText: { color: c.primary, fontSize: 13, fontWeight: '600' },
  moreBtn: { marginTop: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  moreTxt: { color: c.primary, fontSize: 15, fontWeight: '700' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  loadingText: { color: c.textDim, marginTop: 12, fontSize: 14 },
  emptyTitle: { color: c.text, fontSize: 18, fontWeight: '600', marginTop: 16 },
  emptySubtitle: {
    color: c.textDim,
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  resultCard: {
    backgroundColor: c.glassSoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.glassStroke,
    padding: 14,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  senderName: { color: c.accent, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  timestamp: { color: c.textFaint, fontSize: 11 },
  msgText: { color: c.textDim, fontSize: 14, lineHeight: 20 },
  highlight: { color: c.text, backgroundColor: brandAlpha(0.28), fontWeight: '700' },
  unlockBtn: { marginTop: 16, minHeight: 48, minWidth: 200, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.primary, justifyContent: 'center', alignItems: 'center' },
  unlockTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '700' },
  pinInput: {
    marginTop: 16, minWidth: 200, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke,
    backgroundColor: c.glassSoft, color: c.text, fontSize: 20, letterSpacing: 6, textAlign: 'center', paddingHorizontal: 12,
  },
});
