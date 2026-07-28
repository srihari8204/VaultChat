// lib/viewerPrefs.ts — per-chat "share my viewing status" toggle (feature #58).
//
// Local-only (AsyncStorage); never sent to any table. Default: groups ON,
// 1:1 OFF (viewing presence is more revealing in a 1:1). This gates whether
// THIS device emits its own presence — it never affects seeing others.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = (chatId: string) => `cv_share:${chatId}`;

export async function getShareViewing(chatId: string, _isGroup: boolean): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY(chatId));
    if (v === null) return true;          // default ON for both groups AND 1:1
    return v === '1';
  } catch { return true; }
}

export async function setShareViewing(chatId: string, on: boolean): Promise<void> {
  try { await AsyncStorage.setItem(KEY(chatId), on ? '1' : '0'); } catch {}
}

export default { getShareViewing, setShareViewing };
