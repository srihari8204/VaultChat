/**
 * app/app-lock-chats.tsx
 * Per-Chat App Lock — lock individual chats with biometric/PIN.
 */

import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState , useMemo} from 'react';
import {
  Alert,
  Animated,
  FlatList,
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
  getAllLocks, setChatLock, removeChatLock, verifyBiometric, verifyPin, hasBiometric,
  type LockedChat, type LockMethod, type AutoLockTimer,
} from '../lib/chatLock';
import { AppText as Text, AuroraBackground } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';
import { initialOf } from '../lib/format';


// Was: StatusBar.currentHeight on Android, a hardcoded 44 elsewhere, read ONCE
// at module scope. Three defects in one line (2026-09-18): currentHeight omits
// the display cutout on some OEM skins; the ?? 0 fallback draws the header
// UNDER the notch, and edgeToEdge is on at every API level here; and a module
// read freezes whichever value it got at launch, so it never follows a rotation
// or a fold. HEADER_TOP is the live binding and already carries the gap, so the
// old "+ 8" goes with it. makeStyles is a factory re-run per layout generation,
// so reading it here is read-at-render, not a frozen capture.

interface ChatItem {
  id: string;
  name: string;
  avatar?: string;
  lastMessage?: string;
}

const AUTO_LOCK_OPTIONS: { label: string; value: AutoLockTimer }[] = [
  { label: 'Immediately', value: 0 },
  { label: 'After 1 min', value: 60 },
  { label: 'After 5 min', value: 300 },
];

const LOCK_METHOD_OPTIONS: { label: string; value: LockMethod; icon: string }[] = [
  { label: 'Biometric', value: 'biometric', icon: 'finger-print' },
  { label: 'PIN', value: 'pin', icon: 'keypad' },
  { label: 'Both', value: 'both', icon: 'shield-checkmark' },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function AppLockChatsScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();

  const [chats, setChats] = useState<ChatItem[]>([]);
  const [lockedChats, setLockedChats] = useState<Record<string, LockedChat>>({});
  // The lock table could not be READ - distinct from "nothing is locked".
  const [loadErr, setLoadErr] = useState(false);
  // Promise-based PIN prompt, the same shape app/chat-export.tsx uses for the
  // same job: a lock cannot be removed on a fingerprint alone when its owner
  // chose a PIN (2026-09-17).
  const [unlockPrompt, setUnlockPrompt] = useState<LockedChat | null>(null);
  const [unlockPin, setUnlockPin] = useState('');
  const [unlockErr, setUnlockErr] = useState(false);
  const unlockResolve = useRef<((ok: boolean) => void) | null>(null);
  const askUnlockPin = (lock: LockedChat) => new Promise<boolean>((resolve) => {
    unlockResolve.current = resolve;
    setUnlockPin(''); setUnlockErr(false); setUnlockPrompt(lock);
  });
  const closeUnlock = (ok: boolean) => {
    setUnlockPrompt(null); setUnlockPin(''); setUnlockErr(false);
    unlockResolve.current?.(ok); unlockResolve.current = null;
  };
  const submitUnlockPin = () => {
    if (unlockPrompt && verifyPin(unlockPrompt, unlockPin)) closeUnlock(true);
    else setUnlockErr(true);
  };
  const [configChat, setConfigChat] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [bioAvailable, setBioAvailable] = useState(false);
  const [configMethod, setConfigMethod] = useState<LockMethod>('biometric');
  const [configTimer, setConfigTimer] = useState<AutoLockTimer>(0);

  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    (async () => {
      setBioAvailable(await hasBiometric());
      // An empty list here reads as "no chats are locked", which is exactly the
      // wrong thing to show when the table could not be read - the user would
      // believe their locks had vanished. Surface the failure instead.
      try { setLockedChats(await getAllLocks()); setLoadErr(false); }
      catch { setLoadErr(true); }
      try {
        const list = await listChats();
        setChats(list.map(c => ({ id: c.id, name: c.name || c.peerName || 'Chat' })));
      } catch {}
    })();
  }, [fadeIn]);

  const reloadLocks = async () => {
    try { setLockedChats(await getAllLocks()); setLoadErr(false); }
    catch { setLoadErr(true); }
  };

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
      await removeChatLock(chat.id);
      await reloadLocks();
    } else {
      const ex = lockedChats[chat.id];
      setConfigMethod(ex?.lockMethod || (bioAvailable ? 'biometric' : 'pin'));
      setConfigTimer(ex?.autoLockTimer || 0);
      setConfigChat(chat.id);
    }
  };

  const confirmLockSetup = async (chatId: string, method: LockMethod, timer: AutoLockTimer, pin?: string) => {
    if ((method === 'pin' || method === 'both') && (!pin || pin.length < 4)) {
      Alert.alert('Invalid PIN', 'PIN must be at least 4 digits.');
      return;
    }
    const chat = chats.find(c => c.id === chatId);
    await setChatLock(chatId, chat?.name || 'Chat', method, timer, pin);
    await reloadLocks();
    setConfigChat(null);
    setPinInput('');
  };

  // ── Config modal for a chat ──
  const renderConfigPanel = () => {
    if (!configChat) return null;
    const chat = chats.find(c => c.id === configChat);
    const method = configMethod;
    const setMethod = setConfigMethod;
    const timer = configTimer;
    const setTimer = setConfigTimer;

    return (
      <View style={s.overlay}>
        <View style={s.configPanel}>
          <Text style={s.configTitle}>Lock &quot;{chat?.name}&quot;</Text>

          <Text style={s.configLabel}>Lock Method</Text>
          <View style={s.chipRow}>
            {/* A METHOD YOU CANNOT SATISFY IS A CHAT YOU LOSE (2026-09-17).
                Hardening the unlock gate removed the old bioAvailable ? verify : true
                fall-through, which was the ONLY way to drop a lock you could not meet.
                With it gone, picking "Biometric" on a device with nothing enrolled - or
                on web, where hasBiometric() is always false - made the chat permanently
                unreadable AND the lock permanently undeletable, in three taps.
                The honest fix is upstream: do not offer a factor this device cannot
                produce. PIN is always offerable, so there is always a way in. */}
            {LOCK_METHOD_OPTIONS.filter(opt => bioAvailable || opt.value === 'pin').map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[s.chip, method === opt.value && s.chipActive]}
                onPress={() => setMethod(opt.value)}
              >
                <Ionicons name={opt.icon as any} size={16} color={method === opt.value ? colors.accent : colors.textDim} />
                <Text style={[s.chipText, method === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {(method === 'pin' || method === 'both') && (
            <>
              <Text style={s.configLabel}>Set PIN (4+ digits)</Text>
              <TextInput
                style={s.pinInput}
                value={pinInput}
                onChangeText={setPinInput}
                keyboardType="number-pad"
                secureTextEntry
                maxLength={8}
                placeholderTextColor={colors.textFaint}
                placeholder="Enter PIN"
              />
            </>
          )}

          <Text style={s.configLabel}>Auto-Lock After</Text>
          <View style={s.chipRow}>
            {AUTO_LOCK_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[s.chip, timer === opt.value && s.chipActive]}
                onPress={() => setTimer(opt.value)}
              >
                <Text style={[s.chipText, timer === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={s.configActions}>
            <TouchableOpacity
              style={s.cancelBtn}
              onPress={() => { setConfigChat(null); setPinInput(''); }}
            >
              <Text style={s.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.confirmBtn}
              onPress={() => confirmLockSetup(configChat, method, timer, pinInput)}
            >
              <LinearGradient
                colors={[colors.accent, '#2B7FE0']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={s.confirmBtnGrad}
              >
                <Ionicons name="lock-closed" size={16} color="#FFF" style={{ marginRight: 6 }} />
                <Text style={s.confirmBtnText}>Enable Lock</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  const renderChatItem = ({ item }: { item: ChatItem }) => {
    const config = lockedChats[item.id];
    const isLocked = !!config?.locked;

    return (
      <View style={s.chatRow}>
        <View style={s.chatAvatar}>
          <Text style={s.chatAvatarText}>{initialOf(item.name)}</Text>
          {isLocked && (
            <View style={s.lockBadge}>
              <Ionicons name="lock-closed" size={10} color={'#F59E0B'} />
            </View>
          )}
        </View>

        <View style={s.chatInfo}>
          <Text numberOfLines={1} style={s.chatName}>{item.name}</Text>
          <Text style={s.chatPreview}>
            {isLocked ? '\uD83D\uDD12 Chat locked' : item.lastMessage || 'No messages'}
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

        <Switch
          value={isLocked}
          onValueChange={() => toggleLock(item)}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor={isLocked ? colors.accent : '#9CA3AF'}
        />
      </View>
    );
  };

  const lockedCount = Object.values(lockedChats).filter(c => c.locked).length;

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
          <Text style={s.headerTitle}>Per-Chat Lock</Text>
          <View style={{ width: 40 }} />
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
          <Text style={{ color: colors.danger, textAlign: 'center', marginHorizontal: 20, marginBottom: 12 }}>
            Your chat lock settings could not be read, so the list below may be incomplete. Existing locks are still in force.
          </Text>
        )}
        <FlatList
          data={chats}
          keyExtractor={c => c.id}
          renderItem={renderChatItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
          ListEmptyComponent={<Text style={{ color: colors.textDim, textAlign: 'center', marginTop: 40 }}>No chats yet</Text>}
        />
      </Animated.View>

      {configChat && renderConfigPanel()}
      {/* Verify the PIN before a PIN-protected lock can be REMOVED. Reuses the
          config panel styles, so it inherits the same responsive behaviour and
          theme tokens rather than introducing a second dialog design. */}
      {unlockPrompt && (
        <View style={s.overlay}>
          <View style={s.configPanel}>
            <Text style={s.configTitle}>Enter this chat&apos;s PIN</Text>
            <Text style={s.configLabel}>
              {unlockPrompt.lockMethod === 'both'
                ? 'Biometrics verified. The PIN is the second factor you chose.'
                : 'Removing this lock needs the PIN that set it.'}
            </Text>
            <TextInput
              style={s.pinInput}
              value={unlockPin}
              onChangeText={(t) => { setUnlockPin(t); setUnlockErr(false); }}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
              placeholder="Enter PIN"
              placeholderTextColor={colors.textFaint}
              onSubmitEditing={submitUnlockPin}
            />
            {unlockErr && <Text style={[s.configLabel, { color: colors.danger }]}>Incorrect PIN.</Text>}
            <View style={s.chipRow}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => closeUnlock(false)} accessibilityRole="button" accessibilityLabel="Cancel">
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.confirmBtn} onPress={submitUnlockPin} accessibilityRole="button" accessibilityLabel="Confirm PIN and remove the lock">
                <Text style={s.confirmBtnText}>Remove lock</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
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
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
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

  // Config overlay
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  configPanel: {
    width: '100%',
    backgroundColor: c.glass,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },
  configTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 20, textAlign: 'center' },
  configLabel: { fontSize: 13, color: c.textDim, marginTop: 16, marginBottom: 8, fontWeight: '600' },

  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: c.surfaceSolid,
    borderWidth: 1,
    borderColor: c.glassStroke,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipActive: { backgroundColor: c.glass, borderColor: c.accent },
  chipText: { fontSize: 13, color: c.textDim, fontWeight: '600' },
  chipTextActive: { color: c.accent },

  pinInput: {
    backgroundColor: c.surfaceSolid,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: c.text,
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 8,
    borderWidth: 1,
    borderColor: c.glassStroke,
  },

  configActions: { flexDirection: 'row', marginTop: 24, gap: 12 },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.glassStroke,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 14, color: c.textDim, fontWeight: '600' },
  confirmBtn: { flex: 2, borderRadius: 10, overflow: 'hidden' },
  confirmBtnGrad: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
  },
  confirmBtnText: { fontSize: 14, fontWeight: '700', color: '#FFF' },
});
