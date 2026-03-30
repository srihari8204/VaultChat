/**
 * app/app-lock-chats.tsx
 * Per-Chat App Lock — lock individual chats with biometric/PIN.
 */

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
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

const C = {
  bg: '#FFFFFF',
  card: '#F9FAFB',
  cardAlt: '#111D32',
  accent: '#4A9FFF',
  cyan: '#4A9FFF',
  green: '#10B981',
  red: '#EF4444',
  orange: '#F59E0B',
  text: '#FFFFFF',
  textDim: 'rgba(255,255,255,0.5)',
  textFaint: 'rgba(255,255,255,0.22)',
  border: 'rgba(74,159,255,0.15)',
};

const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 44;
const STORAGE_KEY = 'vc_locked_chats';

type LockMethod = 'biometric' | 'pin' | 'both';
type AutoLockTimer = 0 | 60 | 300; // 0=immediately, 60=1min, 300=5min

interface LockedChat {
  chatId: string;
  chatName: string;
  locked: boolean;
  lockMethod: LockMethod;
  autoLockTimer: AutoLockTimer;
  pin?: string;
}

interface ChatItem {
  id: string;
  name: string;
  avatar?: string;
  lastMessage?: string;
}

// Demo chats for display
const DEMO_CHATS: ChatItem[] = [
  { id: 'c1', name: 'Alice', lastMessage: 'See you tomorrow!' },
  { id: 'c2', name: 'Bob', lastMessage: 'Got the files, thanks' },
  { id: 'c3', name: 'Team Vault', lastMessage: 'Meeting at 3pm' },
  { id: 'c4', name: 'Mom', lastMessage: 'Call me when you can' },
  { id: 'c5', name: 'Dave', lastMessage: 'Check this out' },
  { id: 'c6', name: 'Work Group', lastMessage: 'Deadline extended' },
];

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

export default function AppLockChatsScreen() {
  const router = useRouter();

  const [lockedChats, setLockedChats] = useState<Record<string, LockedChat>>({});
  const [configChat, setConfigChat] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [, setHasBiometric] = useState(false);
  const [configMethod, setConfigMethod] = useState<LockMethod>('biometric');
  const [configTimer, setConfigTimer] = useState<AutoLockTimer>(0);

  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    loadSettings();
    checkBiometric();
  }, [fadeIn]);

  const checkBiometric = async () => {
    if (Platform.OS === 'web') { setHasBiometric(false); return; }
    try {
      const compatible = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setHasBiometric(compatible && enrolled);
    } catch {
      setHasBiometric(false);
    }
  };

  const loadSettings = async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) setLockedChats(JSON.parse(raw));
    } catch {}
  };

  const saveSettings = async (data: Record<string, LockedChat>) => {
    setLockedChats(data);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  };

  const toggleLock = async (chat: ChatItem) => {
    const existing = lockedChats[chat.id];
    if (existing?.locked) {
      // Verify before unlocking
      const success = await verifyAuth(existing);
      if (!success) return;
      const updated = { ...lockedChats };
      delete updated[chat.id];
      await saveSettings(updated);
    } else {
      // Enable lock — show config
      const ex = lockedChats[chat.id];
      setConfigMethod(ex?.lockMethod || 'biometric');
      setConfigTimer(ex?.autoLockTimer || 0);
      setConfigChat(chat.id);
    }
  };

  const verifyAuth = async (config: LockedChat): Promise<boolean> => {
    if (Platform.OS === 'web') return true;
    if (config.lockMethod === 'biometric' || config.lockMethod === 'both') {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Verify to unlock chat',
        fallbackLabel: 'Use PIN',
      });
      if (!result.success) return false;
    }
    return true;
  };

  const confirmLockSetup = async (chatId: string, method: LockMethod, timer: AutoLockTimer, pin?: string) => {
    if ((method === 'pin' || method === 'both') && (!pin || pin.length < 4)) {
      Alert.alert('Invalid PIN', 'PIN must be at least 4 digits.');
      return;
    }

    const chat = DEMO_CHATS.find(c => c.id === chatId);
    const entry: LockedChat = {
      chatId,
      chatName: chat?.name || 'Chat',
      locked: true,
      lockMethod: method,
      autoLockTimer: timer,
      pin: pin || undefined,
    };

    const updated = { ...lockedChats, [chatId]: entry };
    await saveSettings(updated);
    setConfigChat(null);
    setPinInput('');
  };

  // ── Config modal for a chat ──
  const renderConfigPanel = () => {
    if (!configChat) return null;
    const chat = DEMO_CHATS.find(c => c.id === configChat);
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
                <Ionicons name={opt.icon as any} size={16} color={method === opt.value ? C.accent : C.textDim} />
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
                placeholderTextColor={C.textFaint}
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
                colors={[C.accent, '#2B7FE0']}
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
              <Ionicons name="lock-closed" size={10} color={C.orange} />
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
                color={C.accent}
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
          thumbColor={isLocked ? C.accent : '#9CA3AF'}
        />
      </View>
    );
  };

  const lockedCount = Object.values(lockedChats).filter(c => c.locked).length;

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient colors={[C.bg, '#F9FAFB', C.bg]} style={StyleSheet.absoluteFill} />

      <Animated.View style={{ flex: 1, opacity: fadeIn }}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
            <Ionicons name="arrow-back" size={24} color={C.text} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Per-Chat Lock</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Summary */}
        <View style={s.summary}>
          <View style={s.summaryIcon}>
            <Ionicons name="lock-closed" size={24} color={C.accent} />
          </View>
          <View>
            <Text style={s.summaryTitle}>{lockedCount} Chat{lockedCount !== 1 ? 's' : ''} Locked</Text>
            <Text style={s.summaryHint}>Locked chats require verification to open</Text>
          </View>
        </View>

        {/* Chat list */}
        <FlatList
          data={DEMO_CHATS}
          keyExtractor={c => c.id}
          renderItem={renderChatItem}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
        />
      </Animated.View>

      {configChat && renderConfigPanel()}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: TOP + 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  backBtn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.text },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 14,
    backgroundColor: C.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
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
  summaryTitle: { fontSize: 16, fontWeight: '700', color: C.text },
  summaryHint: { fontSize: 12, color: C.textDim, marginTop: 2 },

  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.card,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 6,
  },
  chatAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.cardAlt,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  chatAvatarText: { fontSize: 18, fontWeight: '700', color: C.accent },
  lockBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: C.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  chatInfo: { flex: 1, marginRight: 8 },
  chatName: { fontSize: 15, fontWeight: '600', color: C.text },
  chatPreview: { fontSize: 12, color: C.textDim, marginTop: 2 },
  lockMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  lockMetaText: { fontSize: 10, color: C.accent, marginLeft: 4, fontWeight: '600' },

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
    backgroundColor: C.card,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: C.border,
  },
  configTitle: { fontSize: 18, fontWeight: '700', color: C.text, marginBottom: 20, textAlign: 'center' },
  configLabel: { fontSize: 13, color: C.textDim, marginTop: 16, marginBottom: 8, fontWeight: '600' },

  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  chipActive: { backgroundColor: 'rgba(74,159,255,0.15)', borderColor: C.accent },
  chipText: { fontSize: 13, color: C.textDim, fontWeight: '600' },
  chipTextActive: { color: C.accent },

  pinInput: {
    backgroundColor: C.cardAlt,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: C.text,
    fontSize: 18,
    textAlign: 'center',
    letterSpacing: 8,
    borderWidth: 1,
    borderColor: C.border,
  },

  configActions: { flexDirection: 'row', marginTop: 24, gap: 12 },
  cancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  cancelBtnText: { fontSize: 14, color: C.textDim, fontWeight: '600' },
  confirmBtn: { flex: 2, borderRadius: 10, overflow: 'hidden' },
  confirmBtnGrad: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
  },
  confirmBtnText: { fontSize: 14, fontWeight: '700', color: '#FFF' },
});
