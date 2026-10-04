/**
 * app/app-lock-chats.tsx
 * Per-Chat App Lock — lock individual chats with biometric/PIN.
 *
 * Entry from a chat: router.push({ pathname: '/app-lock-chats',
 *   params: { chatId, chatName } }) opens the lock setup for that chat
 * directly (or just the list, highlighting nothing, if it is already locked).
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState , useMemo} from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Modal,
  StyleSheet,
  Switch,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { listChats } from '../lib/chatService';
import {
  getAllLocks, setChatLock, removeChatLock, verifyBiometric, verifyPin, hasBiometric, pinRetryAfterMs,
  type LockedChat, type LockMethod, type AutoLockTimer,
} from '../lib/chatLock';
import {
  AUTO_LOCK_OPTIONS, LOCK_METHOD_OPTIONS, LockConfigModal, digitsOnly, useLockDialogStyles, type LockDraft,
} from '../components/chattools/LockConfigModal';
import { AppText as Text, AuroraBackground, KeyboardSafe } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';
import { initialOf } from '../lib/format';


interface ChatItem {
  id: string;
  name: string;
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const RowGap = () => <View style={{ height: 2 }} />;

export default function AppLockChatsScreen() {
  const { colors } = useTheme();
  const s = useS();
  const d = useLockDialogStyles();
  const router = useRouter();
  // Optional: opened from a chat to lock THAT chat.
  const params = useLocalSearchParams<{ chatId?: string; chatName?: string }>();

  const [chats, setChats] = useState<ChatItem[]>([]);
  const [chatsState, setChatsState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [lockedChats, setLockedChats] = useState<Record<string, LockedChat>>({});
  // The lock table could not be READ - distinct from "nothing is locked".
  const [loadErr, setLoadErr] = useState(false);
  // Promise-based PIN prompt, the same shape app/chat-export.tsx uses for the
  // same job: a lock cannot be removed on a fingerprint alone when its owner
  // chose a PIN (2026-09-17).
  const [unlockPrompt, setUnlockPrompt] = useState<LockedChat | null>(null);
  const [unlockPin, setUnlockPin] = useState('');
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const unlockResolve = useRef<((ok: boolean) => void) | null>(null);
  const askUnlockPin = (lock: LockedChat) => new Promise<boolean>((resolve) => {
    unlockResolve.current = resolve;
    setUnlockPin(''); setUnlockErr(null); setUnlockPrompt(lock);
  });
  const closeUnlock = (ok: boolean) => {
    setUnlockPrompt(null); setUnlockPin(''); setUnlockErr(null);
    unlockResolve.current?.(ok); unlockResolve.current = null;
  };
  const submitUnlockPin = () => {
    if (unlockPrompt && verifyPin(unlockPrompt, unlockPin)) { closeUnlock(true); return; }
    // verifyPin refuses without checking while a backoff runs — say which.
    const wait = unlockPrompt ? pinRetryAfterMs(unlockPrompt) : 0;
    setUnlockPin('');
    setUnlockErr(wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` : 'Incorrect PIN.');
  };
  const [configChat, setConfigChat] = useState<string | null>(null);
  // The setup dialog's fields. The PIN is typed twice: a typo in the only PIN
  // that can remove the lock would leave the chat locked behind a PIN nobody knows.
  const [draft, setDraft] = useState<LockDraft>({ method: 'biometric', timer: 0, pin: '', pinConfirm: '' });
  const patchDraft = useCallback((p: Partial<LockDraft>) => setDraft(d => ({ ...d, ...p })), []);
  const setConfigMethod = useCallback((method: LockMethod) => patchDraft({ method }), [patchDraft]);
  const setConfigTimer = useCallback((timer: AutoLockTimer) => patchDraft({ timer }), [patchDraft]);
  const [saving, setSaving] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);

  const fadeIn = useRef(new Animated.Value(0)).current;
  // Async loads that finish after the screen closed must not set state.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const paramChatId = params.chatId ? String(params.chatId) : '';
  const paramChatName = params.chatName ? String(params.chatName) : '';
  const loadChats = useCallback(async () => {
    setChatsState('loading');
    let list: ChatItem[] = [];
    let ok = true;
    try {
      list = (await listChats()).map(c => ({ id: c.id, name: c.name || c.peerName || 'Chat' }));
    } catch {
      ok = false;
    }
    if (!mounted.current) return;
    setChatsState(ok ? 'ok' : 'error');
    // Opened from a chat: make sure that chat is listed even if the list
    // failed or has not synced it yet.
    if (paramChatId && !list.some(c => c.id === paramChatId)) list = [{ id: paramChatId, name: paramChatName || 'Chat' }, ...list];
    setChats(list);
  }, [paramChatId, paramChatName]);

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    (async () => {
      const bio = await hasBiometric();
      if (!mounted.current) return;
      setBioAvailable(bio);
      // An empty list here reads as "no chats are locked", which is exactly the
      // wrong thing to show when the table could not be read - the user would
      // believe their locks had vanished. Surface the failure instead.
      try {
        const locks = await getAllLocks();
        if (mounted.current) { setLockedChats(locks); setLoadErr(false); }
      } catch { if (mounted.current) setLoadErr(true); }
      await loadChats();
    })();
  }, [fadeIn, loadChats]);

  // Entry from a chat: go straight to setting up that chat's lock, once.
  const openedFor = useRef(false);
  useEffect(() => {
    const id = params.chatId ? String(params.chatId) : '';
    if (!id || openedFor.current || chatsState === 'loading' || loadErr) return;
    openedFor.current = true;
    if (!lockedChats[id]?.locked) {
      setConfigMethod(bioAvailable ? 'biometric' : 'pin');
      setConfigTimer(0);
      setConfigChat(id);
    }
  }, [params.chatId, chatsState, loadErr, lockedChats, bioAvailable, setConfigMethod, setConfigTimer]);

  const reloadLocks = async () => {
    try {
      const locks = await getAllLocks();
      if (mounted.current) { setLockedChats(locks); setLoadErr(false); }
    } catch { if (mounted.current) setLoadErr(true); }
  };

  // In-flight lock removal (see onToggle): which chat, for its row's busy cue.
  const togglingRef = useRef(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const toggling = togglingId !== null;

  const toggleLock = async (chat: ChatItem) => {
    const existing = lockedChats[chat.id];
    if (existing?.locked) {
      // REMOVING A LOCK MUST SATISFY THAT LOCK (2026-09-17).
      //
      // This was: bioAvailable ? await verifyBiometric(...) : true. Two holes,
      // and both DELETE the lock rather than merely opening the chat:
      //
      //   - On a device with no enrolled biometric, and on web where
      //     hasBiometric() is false, the ternary fell through to TRUE and the
      //     lock came off with no verification of any kind.
      //   - A chat locked with a PIN, or with BOTH, came off on a fingerprint
      //     alone. The PIN the user chose was never asked for.
      //
      // Verify against the lock OWN method, the same way the chat gate does.
      // The old note said PIN-only locks were still enforced at the chat gate;
      // true, and irrelevant once the lock itself has been deleted.
      if (existing.lockMethod === 'biometric' || existing.lockMethod === 'both') {
        if (!bioAvailable) {
          Alert.alert(
            'Biometrics unavailable',
            'This chat is locked with biometrics, and none are enrolled on this device. Enrol a fingerprint or face, then try again.',
          );
          return;
        }
        if (!(await verifyBiometric('Verify to unlock this chat'))) return;
      }
      if (existing.lockMethod === 'pin' || existing.lockMethod === 'both') {
        if (!(await askUnlockPin(existing))) return;
      }
      try {
        await removeChatLock(chat.id);
      } catch {
        Alert.alert('Lock not removed', 'The lock settings could not be saved. The chat is still locked — try again.');
      }
      await reloadLocks();
    } else {
      const ex = lockedChats[chat.id];
      setConfigMethod(ex?.lockMethod || (bioAvailable ? 'biometric' : 'pin'));
      setConfigTimer(ex?.autoLockTimer || 0);
      setConfigChat(chat.id);
    }
  };

  // The Switch goes through this: one removal at a time, so a second flip during
  // the biometric or PIN prompt cannot start a parallel removal.
  const onToggle = async (chat: ChatItem) => {
    if (!lockedChats[chat.id]?.locked) { await toggleLock(chat); return; }
    if (togglingRef.current) return;
    togglingRef.current = true;
    setTogglingId(chat.id);
    try { await toggleLock(chat); }
    finally { togglingRef.current = false; if (mounted.current) setTogglingId(null); }
  };

  const closeConfig = () => { setConfigChat(null); patchDraft({ pin: '', pinConfirm: '' }); };

  const confirmLockSetup = async (chatId: string, method: LockMethod, timer: AutoLockTimer, pin?: string) => {
    if (saving) return;
    const needsPin = method === 'pin' || method === 'both';
    if (needsPin && (!pin || !/^\d{4,8}$/.test(pin))) {
      Alert.alert('Invalid PIN', 'The PIN must be 4 to 8 digits.');
      return;
    }
    if (needsPin && pin !== draft.pinConfirm) {
      Alert.alert('PINs do not match', 'Type the same PIN in both boxes.');
      patchDraft({ pinConfirm: '' });
      return;
    }
    const chat = chats.find(c => c.id === chatId);
    setSaving(true);
    try {
      await setChatLock(chatId, chat?.name || 'Chat', method, timer, needsPin ? pin : undefined);
      closeConfig();
    } catch {
      Alert.alert('Lock not set', 'The lock settings could not be saved, so this chat is NOT locked. Try again.');
    } finally {
      setSaving(false);
      await reloadLocks();
    }
  };

  // The row reads the latest onToggle through a ref, so the memoised row
  // renderer does not change on every render.
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  const renderChatItem = useCallback(({ item }: { item: ChatItem }) => {
    const config = lockedChats[item.id];
    const isLocked = !!config?.locked;

    return (
      <View style={s.chatRow}>
        <View style={s.chatAvatar}>
          <Text style={s.chatAvatarText}>{initialOf(item.name)}</Text>
          {isLocked && (
            <View style={s.lockBadge}>
              <Ionicons name="lock-closed" size={10} color={colors.accentOn} />
            </View>
          )}
        </View>

        <View style={s.chatInfo}>
          <Text numberOfLines={1} style={s.chatName}>{item.name}</Text>
          <Text style={s.chatPreview}>
            {togglingId === item.id ? 'Removing lock…' : isLocked ? 'Chat locked' : 'Not locked'}
          </Text>
          {isLocked && config && (
            <View style={s.lockMeta}>
              <Ionicons
                name={config.lockMethod === 'biometric' ? 'finger-print' : config.lockMethod === 'pin' ? 'keypad' : 'shield-checkmark'}
                size={12}
                color={colors.accent}
              />
              <Text style={s.lockMetaText}>
                {LOCK_METHOD_OPTIONS.find(o => o.value === config.lockMethod)?.label}
                {' \u2022 '}
                {AUTO_LOCK_OPTIONS.find(o => o.value === config.autoLockTimer)?.label}
              </Text>
            </View>
          )}
        </View>

        {togglingId === item.id && (
          <ActivityIndicator size="small" color={colors.primary} style={s.rowBusy} accessibilityLabel={`Removing the lock on ${item.name}`} />
        )}
        <Switch
          value={isLocked}
          onValueChange={() => toggleRef.current(item)}
          disabled={toggling}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor={isLocked ? colors.accent : colors.textFaint}
          accessibilityLabel={`Lock ${item.name}`}
          accessibilityState={{ checked: isLocked, disabled: toggling }}
        />
      </View>
    );
  }, [s, colors, lockedChats, toggling, togglingId]);

  const lockedCount = Object.values(lockedChats).filter(c => c.locked).length;

  // A METHOD YOU CANNOT SATISFY IS A CHAT YOU LOSE (2026-09-17).
  // Hardening the unlock gate removed the old bioAvailable ? verify : true
  // fall-through, which was the ONLY way to drop a lock you could not meet.
  // With it gone, picking "Biometric" on a device with nothing enrolled - or
  // on web, where hasBiometric() is always false - made the chat permanently
  // unreadable AND the lock permanently undeletable, in three taps.
  // The honest fix is upstream: do not offer a factor this device cannot
  // produce. PIN is always offerable, so there is always a way in.
  const methodOptions = LOCK_METHOD_OPTIONS.filter(opt => bioAvailable || opt.value === 'pin');

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle} accessibilityRole="header">Per-Chat Lock</Text>
          <View style={{ width: 44 }} />
        </View>

        {/* Summary */}
        <View style={s.summary}>
          <View style={s.summaryIcon}>
            <Ionicons name="lock-closed" size={24} color={colors.accent} />
          </View>
          <View>
            <Text style={s.summaryTitle}>{lockedCount} Chat{lockedCount !== 1 ? 's' : ''} Locked</Text>
            <Text style={s.summaryHint}>Locked chats require verification to open</Text>
          </View>
        </View>

        {/* Chat list */}
        {/* An unreadable lock table must never render as an empty list: that reads
            as "none of your chats are locked", which is the opposite of what is
            known, and would invite the user to re-lock chats that are already
            locked. Say what actually happened (2026-09-17). */}
        {loadErr && (
          <Text style={s.loadErrTxt} accessibilityRole="alert">
            Your chat lock settings could not be read, so the list below may be incomplete. Existing locks are still in force.
          </Text>
        )}
        {chatsState === 'error' && (
          <TouchableOpacity onPress={loadChats} accessibilityRole="button" style={s.chatsErrBtn}>
            <Text style={s.chatsErrTxt}>
              Your chats could not be loaded. Tap to try again.
            </Text>
          </TouchableOpacity>
        )}
        <FlatList
          data={chats}
          keyExtractor={c => c.id}
          renderItem={renderChatItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={RowGap}
          ListEmptyComponent={chatsState === 'loading'
            ? <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
            : chatsState === 'ok'
              ? <Text style={s.emptyTxt}>No chats yet</Text>
              : null}
        />
      </Animated.View>

      {configChat && (
        <LockConfigModal
          chatName={chats.find(c => c.id === configChat)?.name ?? 'this chat'}
          methods={methodOptions}
          draft={draft}
          onChange={patchDraft}
          saving={saving}
          onCancel={closeConfig}
          onConfirm={() => confirmLockSetup(configChat, draft.method, draft.timer, draft.pin)}
        />
      )}
      {/* Verify the PIN before a PIN-protected lock can be REMOVED. Reuses the
          config panel styles, so it inherits the same responsive behaviour and
          theme tokens rather than introducing a second dialog design. */}
      {unlockPrompt && (
        <Modal visible transparent animationType="fade" onRequestClose={() => closeUnlock(false)}>
        <KeyboardSafe style={d.fill}>
        <View style={d.overlay}>
          <View style={d.configPanel}>
            <Text style={d.configTitle} accessibilityRole="header">Enter this chat&apos;s PIN</Text>
            <Text style={d.configLabel}>
              {unlockPrompt.lockMethod === 'both'
                ? 'Biometrics verified. The PIN is the second factor you chose.'
                : 'Removing this lock needs the PIN that set it.'}
            </Text>
            <TextInput
              style={d.pinInput}
              value={unlockPin}
              onChangeText={(t) => { setUnlockPin(digitsOnly(t)); setUnlockErr(null); }}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
              placeholder="Enter PIN"
              placeholderTextColor={colors.textFaint}
              onSubmitEditing={submitUnlockPin}
              accessibilityLabel="Chat PIN"
            />
            {!!unlockErr && (
              <Text style={[d.configLabel, d.errTxt]} accessibilityRole="alert" accessibilityLiveRegion="polite">{unlockErr}</Text>
            )}
            <View style={d.configActions}>
              <TouchableOpacity style={d.cancelBtn} onPress={() => closeUnlock(false)} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={d.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              {/* Was a confirmBtn with no background and #FFF text — invisible on
                  the light glass panel. Solid danger fill: this removes a lock. */}
              <TouchableOpacity style={d.removeBtn} onPress={submitUnlockPin} accessibilityRole="button" accessibilityLabel="Confirm PIN and remove the lock">
                <Text style={d.removeBtnText}>Remove lock</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
        </Modal>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: HEADER_TOP,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: c.text },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 14,
    backgroundColor: c.glass,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  summaryIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.glassSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  summaryTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  summaryHint: { fontSize: 12, color: c.textDim, marginTop: 2 },

  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.glass,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.glassStroke,
    marginBottom: 6,
  },
  chatAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: c.surfaceSolid,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  chatAvatarText: { fontSize: 18, fontWeight: '700', color: c.accent },
  lockBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: c.glass,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  chatInfo: { flex: 1, marginRight: 8 },
  chatName: { fontSize: 15, fontWeight: '600', color: c.text },
  chatPreview: { fontSize: 12, color: c.textDim, marginTop: 2 },
  lockMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  lockMetaText: { fontSize: 10, color: c.accent, marginLeft: 4, fontWeight: '600' },
  rowBusy: { marginRight: 8 },


  loadErrTxt: { color: c.danger, textAlign: 'center', marginHorizontal: 20, marginBottom: 12 },
  chatsErrBtn: { marginHorizontal: 20, marginBottom: 12, minHeight: 44, justifyContent: 'center' },
  chatsErrTxt: { color: c.danger, textAlign: 'center' },
  emptyTxt: { color: c.textDim, textAlign: 'center', marginTop: 40 },
});
