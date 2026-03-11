import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

export interface DestructionLog {
  timestamp: number;
  itemsDestroyed: number;
  certificate: string;
  reason: 'manual' | 'panic' | 'breach' | 'timeout' | 'failedlogin';
}

export interface ShieldStatus {
  isArmed: boolean;
  autoDestructEnabled: boolean;
  autoDestructMinutes: number;
  panicWordEnabled: boolean;
  panicWord: string;
  failedLoginLimit: number;
  lastActivity: number;
  destructionLog: DestructionLog[];
}

const SHIELD_KEY = 'vaultchat_shield_status';
const DESTRUCTION_LOG_KEY = 'vaultchat_destruction_log';
const SECURE_STORE_KEYS = ['vaultchat_private_key','vaultchat_face_key','vaultchat_session','vaultchat_master_key'];
const ASYNC_STORAGE_KEYS = ['vaultchat_vault_id','vaultchat_enrolled_faces','vaultchat_messages','vaultchat_contacts','vaultchat_settings','vaultchat_chats'];

export const executeMemoryShield = async (reason: 'manual' | 'panic' | 'breach' | 'timeout' | 'failedlogin'): Promise<DestructionLog> => {
  let itemsDestroyed = 0;
  for (const key of SECURE_STORE_KEYS) { try { await SecureStore.deleteItemAsync(key); itemsDestroyed++; } catch (e) {} }
  for (const key of ASYNC_STORAGE_KEYS) { try { await AsyncStorage.removeItem(key); itemsDestroyed++; } catch (e) {} }
  try { await AsyncStorage.clear(); itemsDestroyed += 5; } catch (e) {}
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, reason + Date.now().toString());
  const log: DestructionLog = { timestamp: Date.now(), itemsDestroyed, certificate: hash, reason };
  try {
    const existing = await AsyncStorage.getItem(DESTRUCTION_LOG_KEY);
    const logs = existing ? JSON.parse(existing) : [];
    logs.push(log);
    await AsyncStorage.setItem(DESTRUCTION_LOG_KEY, JSON.stringify(logs.slice(-5)));
  } catch (e) {}
  return log;
};

export const loadShieldStatus = async (): Promise<ShieldStatus> => {
  try { const data = await AsyncStorage.getItem(SHIELD_KEY); if (data) return JSON.parse(data); } catch (e) {}
  return { isArmed: true, autoDestructEnabled: false, autoDestructMinutes: 60, panicWordEnabled: false, panicWord: '', failedLoginLimit: 3, lastActivity: Date.now(), destructionLog: [] };
};

export const saveShieldStatus = async (status: ShieldStatus): Promise<void> => {
  await AsyncStorage.setItem(SHIELD_KEY, JSON.stringify(status));
};

export const loadDestructionLogs = async (): Promise<DestructionLog[]> => {
  try { const data = await AsyncStorage.getItem(DESTRUCTION_LOG_KEY); return data ? JSON.parse(data) : []; } catch (e) { return []; }
};

export const updateActivity = async (): Promise<void> => {
  const status = await loadShieldStatus();
  status.lastActivity = Date.now();
  await saveShieldStatus(status);
};

export const reasonLabels: Record<string, string> = {
  manual: 'Manual Trigger',
  panic: 'Panic Word',
  breach: 'Breach Detected',
  timeout: 'Auto-Destruct Timeout',
  failedlogin: 'Failed Login Limit',
};
