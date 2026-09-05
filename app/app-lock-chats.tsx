/**
 * app/app-lock-chats.tsx
 * Per-Chat App Lock — lock individual chats with biometric/PIN.
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState , useMemo} from 'react';
import {
  Alert,
  Animated,
  FlatList,
  Platform,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { listChats } from '../lib/chatService';
import {
  getAllLocks, setChatLock, removeChatLock, verifyBiometric, hasBiometric,
  type LockedChat, type LockMethod, type AutoLockTimer,
} from '../lib/chatLock';
import { AuroraBackground } from '../components/ui';


const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;

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
      setLockedChats(await getAllLocks());
      try {
        const list = await listChats();
        setChats(list.map(c => ({ id: c.id, name: c.name || c.peerName || 'Chat' })));
      } catch {}
    })();
  }, [fadeIn]);

  const reloadLocks = async () => setLockedChats(await getAllLocks());

  const toggleLock = async (chat: ChatItem) => {
    const existing = lockedChats[chat.id];
    if (existing?.locked) {
      // Verify before unlocking. Biometric is required when the device has it
      // enrolled; PIN-only locks are still enforced at the chat gate on open.
      const ok = bioAvailable ? await verifyBiometric('Verify to unlock this chat') : true;
      if (!ok) return;
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
            {LOCK_METHOD_OPTIONS.map(opt => (
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
          <Text style={s.chatAvatarText}>{item.name.charAt(0)}</Text>
          {isLocked && (
            <View style={s.lockBadge}>
              <Ionicons name="lock-closed" size={10} color={'#F59E0B'} />
            </View>
          )}
        </View>

        <View style={s.chatInfo}>
          <Text style={s.chatName}>{item.name}</Text>
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
          trackColor={{ false: '#D1D5DB', true: 'rgba(74,159,255,0.4)' }}
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
      <LinearGradient colors={[colors.bg, '#F9FAFB', colors.bg]} style={StyleSheet.absoluteFill} />

      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
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
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP + 8,
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
    backgroundColor: c.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
  },
  summaryIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(74,159,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  summaryTitle: { fontSize: 16, fontWeight: '700', color: c.text },
  summaryHint: { fontSize: 12, color: c.textDim, marginTop: 2 },

  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.card,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    marginBottom: 6,
  },
  chatAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#111D32',
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
    backgroundColor: c.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
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
    backgroundColor: c.card,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: c.border,
  },
  configTitle: { fontSize: 18, fontWeight: '700', color: c.text, marginBottom: 20, textAlign: 'center' },
  configLabel: { fontSize: 13, color: c.textDim, marginTop: 16, marginBottom: 8, fontWeight: '600' },

  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#111D32',
    borderWidth: 1,
    borderColor: c.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipActive: { backgroundColor: 'rgba(74,159,255,0.15)', borderColor: c.accent },
  chipText: { fontSize: 13, color: c.textDim, fontWeight: '600' },
  chipTextActive: { color: c.accent },

  pinInput: {
    backgroundColor: '#111D32',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: c.text,
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 8,
    borderWidth: 1,
    borderColor: c.border,
  },

  configActions: { flexDirection: 'row', marginTop: 24, gap: 12 },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: c.border,
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
