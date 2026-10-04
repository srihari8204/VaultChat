// app/hidden-chats.tsx — PIN-gated list of hidden chats (Postgres).
//
// Two-stage screen:
//   1. PIN gate — POST /user/pin/verify. 5 wrong attempts → kicked back.
//      If the user has no PIN set yet, we tell them to set one in Profile.
//   2. List — fetches GET /chats?includeHidden=1 (server returns hidden
//      rows ONLY when the flag is set). Tap a row to open the chat.
//      Long-press → unhide back into the regular list.
//
// PIN session is screen-scoped: leaving the screen, or sending the app to the
// background, requires re-entering. Wrong PINs are counted in AsyncStorage
// (same backoff schedule as the Device PIN), so leaving and re-entering does
// not reset the limit. The server limit (5 wrong per 15 min, 423 + retryAfter)
// is written but not deployed (fixes/R4BE.md C1); a 423 is shown as a real wait.

import { useAuthHeader } from '../hooks/useAuthHeader';
import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, Image, RefreshControl, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { focusWithKeyboard, retryKeyboard } from '../lib/imeFocus';
import {
  attachmentUrl,
  listChats,
  setHidden,
  verifyPin,
  type ChatSummary,
} from '../lib/chatService';
import { AuroraBackground, KeyboardSafe } from '../components/ui';
import { isOfflineError, retryAfterSec } from '../lib/onboarding';
import { initialOf } from '../lib/format';
import { createPinAttemptTracker } from '../services/security/pinAttempts';
import { tint } from '../lib/tintColor';
import { holdAppSwitcherBlur } from '../lib/screenGuard';

const MAX_ATTEMPTS = 5;
// How long the app may be away (a file picker, a quick app switch) before a
// hidden chat open above this screen is closed on return. ponytail: a fixed
// grace, not the user's Auto Screen Lock timer — the hidden chats keep their
// own, shorter, limit. A picker left open longer than this still closes the
// chat; skipping only while a picker is open would need chat.tsx to report it.
const HIDDEN_CHAT_GRACE_MS = 60_000;
type Router = ReturnType<typeof useRouter>;

// Persisted wrong-PIN streak for this gate. Its own key: this gate checks the
// account MPIN on the server, so its failures must not throttle the Device PIN.
// The tracker decays a streak after 15 quiet minutes and backs off between tries.
// ponytail: the server limit on /user/pin/verify (423 + retryAfter) is written
// but not deployed; until it is, this client counter is the only throttle, and
// clearing app storage resets it. Keep it after the deploy as the first line.
const HIDDEN_PIN_FAIL_KEY = 'vc_hidden_chats_pin_fail';
const pinAttempts = createPinAttemptTracker({
  get: () => AsyncStorage.getItem(HIDDEN_PIN_FAIL_KEY),
  set: (_k, v) => AsyncStorage.setItem(HIDDEN_PIN_FAIL_KEY, v),
  del: () => AsyncStorage.removeItem(HIDDEN_PIN_FAIL_KEY),
});

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function HiddenChatsScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const [stage, setStage] = useState<'pin' | 'list'>('pin');

  // Re-lock when the app goes to the background, so the list is never left
  // open for whoever picks the phone up next.
  //
  // A hidden chat opened from the list (or anything pushed above it) is closed
  // too — but only after a real trip away, not on every background event.
  // Attaching a file starts the system photo/document picker, which on Android
  // is another activity and backgrounds the app; Face ID and system alerts pass
  // through iOS 'inactive'. Closing the chat on those dropped the user at the
  // PIN gate and lost the draft and the picked file. So: 'background' only,
  // and the chat is closed on return when the app was away longer than
  // HIDDEN_CHAT_GRACE_MS. While anything here is open, the iOS app-switcher
  // snapshot is blurred instead (Android's FLAG_SECURE blanks its thumbnail).
  const awaySince = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'background') {
        awaySince.current = Date.now();
        setStage('pin');
      } else if (st === 'active' && awaySince.current !== null) {
        const away = Date.now() - awaySince.current;
        awaySince.current = null;
        if (away >= HIDDEN_CHAT_GRACE_MS && !navigation.isFocused()) router.dismissTo('/hidden-chats');
      }
    });
    return () => sub.remove();
  }, [navigation, router]);
  useEffect(() => (stage === 'list' ? holdAppSwitcherBlur() : undefined), [stage]);

  if (stage === 'pin') {
    return <PinGate router={router} onPass={() => setStage('list')} />;
  }
  return <HiddenList router={router} />;
}

// What the gate says when verifying did not get a yes/no answer. A 423 is the
// server's own attempt limit (R4BE C1): name the real wait, so the user stops
// rather than spending more tries against a lock.
function gateError(e: any): string {
  if (e?.status === 423) {
    const secs = retryAfterSec(e);
    if (!secs) return 'Too many attempts. Wait a few minutes, then try again.';
    const mins = Math.ceil(secs / 60);
    return secs < 60
      ? `Too many attempts. Try again in ${secs} s.`
      : `Too many attempts. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`;
  }
  if (isOfflineError(e)) return "You're offline. Check your connection and try again.";
  return 'Your PIN could not be checked. Try again.';
}

function PinGate({
  router, onPass,
}: { router: Router; onPass: () => void }) {
  const S = useS();
  const { colors } = useTheme();
  const [pin,       setPin]       = useState('');
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  // Synchronous twin of `busy`: a second Enter in the same frame would spend
  // a second attempt.
  const busyRef = useRef(false);

  // A single timed focus() is one IME request and no second chance: if Android
  // refuses it (cold deep-link, window not focused yet) the input is left
  // focused with no keyboard, and tapping cannot recover because focus() on an
  // already-focused input is a no-op. Device-observed on the Redmi via the
  // identical gate in encrypted-notes. See lib/imeFocus.
  useEffect(() => focusWithKeyboard(inputRef, 200), []);

  const submit = useCallback(async () => {
    if (busyRef.current) return;
    if (!/^\d{4,8}$/.test(pin)) {
      setError('PIN must be 4–8 digits');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      // An unreadable counter throws into the catch below: fail closed.
      const waitMs = await pinAttempts.getBackoffMs();
      if (waitMs > 0) {
        setPin('');
        setError(`Too many attempts. Try again in ${Math.ceil(waitMs / 1000)} s.`);
        return;
      }
      const ok = await verifyPin(pin);
      if (ok) {
        await pinAttempts.recordSuccess().catch(() => { /* streak decays on its own */ });
        onPass();
        return;
      }
      const next = await pinAttempts.recordFailure();
      setPin('');
      if (next >= MAX_ATTEMPTS) {
        Alert.alert(
          'Too many attempts',
          'Returning to chats. Try again later.',
          [{ text: 'OK', onPress: () => router.back() }],
        );
      } else {
        setError(`Incorrect PIN. ${MAX_ATTEMPTS - next} attempts left.`);
      }
    } catch (e: any) {
      setPin('');
      setError(gateError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [pin, onPass, router]);

  return (
    // KeyboardSafe: the centred PIN field would sit under the keyboard on small screens.
    <KeyboardSafe style={[S.screen, S.center, { paddingHorizontal: 32 }]}>
      <AuroraBackground />
      <Text style={S.gateIcon} accessible={false}>🔒</Text>
      <Text style={S.gateTitle} accessibilityRole="header">Enter your PIN</Text>
      <Text style={S.gateSub}>Hidden chats are protected by your app PIN (the same MPIN you use to sign in).</Text>

      <TextInput
        ref={inputRef}
        onPressIn={() => retryKeyboard(inputRef)}
        accessibilityLabel="PIN"
        style={S.pinInput}
        value={pin}
        onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))}
        placeholder="••••••"
        placeholderTextColor={colors.textDim}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={8}
        onSubmitEditing={submit}
        editable={!busy}
      />

      {error && <Text style={S.errorTxt} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>}

      <View style={S.gateBtnRow}>
        <TouchableOpacity accessibilityRole="button" onPress={() => router.back()} style={S.gateCancel} activeOpacity={0.7}>
          <Text style={S.gateCancelTxt}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={submit}
          disabled={busy || pin.length < 4}
          accessibilityRole="button"
          accessibilityLabel="Unlock"
          accessibilityState={{ disabled: busy || pin.length < 4, busy }}
          style={[S.gateUnlock, (busy || pin.length < 4) && S.gateUnlockOff]}
          activeOpacity={0.85}
        >
          {busy ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={S.gateUnlockTxt}>Unlock</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardSafe>
  );
}

function HiddenList({ router }: { router: Router }) {
  const S = useS();
  const { colors } = useTheme();
  const [rows,       setRows]       = useState<ChatSummary[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const authHeader = useAuthHeader();
  const [error,      setError]      = useState<string | null>(null);
  // Async results land only while the list is mounted (a background re-lock
  // unmounts it mid-load).
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // Chat ids with an Unhide in flight, so a second tap does not send it twice.
  const unhiding = useRef(new Set<string>());

  const load = useCallback(async () => {
    try {
      const list = await listChats({ includeHidden: true });
      if (!alive.current) return;
      // The server returns hidden rows only for includeHidden=1; filter anyway
      // so an older server can never mix the regular list in here.
      setRows(list.filter(c => c.hidden));
      setError(null);
    } catch (e: any) {
      if (alive.current) setError(isOfflineError(e) ? "You're offline. Check your connection and try again." : 'The hidden chats could not be loaded. Try again.');
    }
  }, []);

  useEffect(() => {
    (async () => { setLoading(true); await load(); if (alive.current) setLoading(false); })();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (alive.current) setRefreshing(false);
  }, [load]);

  const onOpen = useCallback((id: string) => {
    router.push({ pathname: '/chat', params: { id } });
  }, [router]);

  const onUnhide = useCallback((c: ChatSummary) => {
    Alert.alert(
      'Unhide this chat?',
      'It will appear in your main chats list again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Unhide', onPress: async () => {
            if (unhiding.current.has(c.id)) return;
            unhiding.current.add(c.id);
            try {
              await setHidden(c.id, false);
              if (alive.current) setRows(prev => prev.filter(r => r.id !== c.id));
            } catch (e: any) {
              Alert.alert('Could not unhide the chat', isOfflineError(e) ? "You're offline. Check your connection and try again." : 'It is still hidden. Try again.');
            } finally {
              unhiding.current.delete(c.id);
            }
          }
        },
      ],
    );
  }, []);

  const renderItem = useCallback(({ item: c }: { item: ChatSummary }) => {
    const title = c.type === 'direct'
      ? (c.peerName || c.name || 'Direct chat')
      : (c.name || 'Group chat');
    const photoId = c.type === 'direct' ? c.peerPhotoURL : c.photoURL;
    return (
      <TouchableOpacity
        style={S.row}
        accessibilityRole="button"
        accessibilityLabel={c.unreadCount > 0 ? `${title}, ${c.unreadCount} unread` : title}
        accessibilityHint="Opens the chat. Long-press or use actions to unhide."
        accessibilityActions={[{ name: 'unhide', label: 'Unhide chat' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'unhide') onUnhide(c); }}
        onPress={() => onOpen(c.id)}
        onLongPress={() => onUnhide(c)}
        delayLongPress={300}
        activeOpacity={0.7}
      >
        <View style={[S.avatar, c.type === 'group' && S.avatarGroup]}>
          {photoId && authHeader ? (
            <Image
              source={{ uri: attachmentUrl(photoId), headers: { Authorization: authHeader } }}
              style={S.avatarImg}
            />
          ) : (
            <Text style={[S.avatarTxt, c.type === 'group' && S.avatarTxtGroup]}>{initialOf(title, '#')}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={S.rowName} numberOfLines={1}>{title}</Text>
          <Text style={S.rowSub} numberOfLines={1}>
            {c.unreadCount > 0 ? `${c.unreadCount} unread · ` : ''}
            long-press to unhide
          </Text>
        </View>
      </TouchableOpacity>
    );
  }, [S, authHeader, onOpen, onUnhide]);

  if (loading) {
    return (
      <View style={[S.screen, S.center]}>
        <AuroraBackground />
        <ActivityIndicator color={colors.primary} size="large" accessibilityLabel="Loading hidden chats" />
      </View>
    );
  }

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} hitSlop={10} style={S.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Hidden chats</Text>
      </View>

      {error && rows.length > 0 && (
        <Text style={S.errorTxt} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>
      )}

      {rows.length === 0 && error ? (
        // A failed load is not "Nothing hidden".
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>{"Couldn't load hidden chats"}</Text>
          <Text style={S.emptySub} accessibilityRole="alert">{error}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ busy: refreshing }}
            onPress={onRefresh}
            disabled={refreshing}
            style={S.retryBtn}
          >
            {refreshing
              ? <ActivityIndicator color={colors.onPrimary} />
              : <Text style={S.gateUnlockTxt}>Try again</Text>}
          </TouchableOpacity>
        </View>
      ) : rows.length === 0 ? (
        <View style={[S.center, { flex: 1, paddingHorizontal: 32 }]}>
          <Text style={S.emptyTitle}>Nothing hidden</Text>
          <Text style={S.emptySub}>
            Open any chat → ⋮ menu → Hide chat to move it here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(c) => c.id}
          refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingBottom: 32 }}
          renderItem={renderItem}
        />
      )}
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:       { justifyContent: 'center', alignItems: 'center' },

  // PIN gate
  gateIcon:     { fontSize: 48, marginBottom: 16 },
  gateTitle:    { color: c.text, fontSize: 22, fontWeight: '800', marginBottom: 6 },
  gateSub:      { color: c.textDim, fontSize: 13, textAlign: 'center', marginBottom: 24 },
  pinInput:     { color: c.text, fontSize: 28, letterSpacing: 10, textAlign: 'center', backgroundColor: c.glassSoft, borderColor: c.glassStroke, borderWidth: 1, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 14, width: '100%', maxWidth: 280 },
  errorTxt:     { color: c.danger, paddingHorizontal: 16, paddingTop: 12, fontSize: 12, textAlign: 'center' },
  gateBtnRow:   { flexDirection: 'row', gap: 12, marginTop: 24, width: '100%', maxWidth: 280 },
  gateCancel:   { flex: 1, padding: 14, minHeight: 48, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center' },
  gateCancelTxt: { color: c.text, fontWeight: '700' },
  gateUnlock:    { flex: 1, padding: 14, minHeight: 48, justifyContent: 'center', borderRadius: 12, backgroundColor: c.primary, alignItems: 'center' },
  gateUnlockOff: { backgroundColor: c.surfaceSolid },
  gateUnlockTxt: { color: c.onPrimary, fontWeight: '700' },
  retryBtn:      { marginTop: 20, minHeight: 44, minWidth: 140, paddingHorizontal: 20, borderRadius: 12, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },

  // List
  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  backBtn:      { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title:        { color: c.text, fontSize: 22, fontWeight: '800' },
  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },

  row:          { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  avatar:       { width: 52, height: 52, borderRadius: 26, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  // onPrimary is specified against primary only; white on the dark theme's
  // bright green was ~2.3:1. Groups get the success ink on a success tint.
  avatarGroup:  { backgroundColor: tint(c.success, 0.2) },
  avatarImg:    { width: '100%', height: '100%' },
  avatarTxt:    { color: c.onPrimary, fontSize: 20, fontWeight: '700' },
  avatarTxtGroup: { color: c.success },
  rowName:      { color: c.text, fontSize: 16, fontWeight: '600' },
  rowSub:       { color: c.textDim, fontSize: 12, marginTop: 4 },
});
