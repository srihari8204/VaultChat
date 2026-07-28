// lib/mediaKeyStore.ts — local map of attachmentId → media key.
//
// The per-file key arrives inside the E2E message envelope. We stash it here
// keyed by attachmentId so ANY render site (chat bubble, media gallery,
// contact-info shared media, viewer) can decrypt the attachment later without
// re-reading the message. The key never leaves the device.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MediaKey } from './mediaCrypto';

const K = (attachmentId: string) => `vc_mk_${attachmentId}`;

export async function putMediaKey(attachmentId: string, mk: MediaKey): Promise<void> {
  try { await AsyncStorage.setItem(K(attachmentId), JSON.stringify(mk)); } catch {}
}

export async function getMediaKey(attachmentId: string): Promise<MediaKey | null> {
  try {
    const raw = await AsyncStorage.getItem(K(attachmentId));
    return raw ? (JSON.parse(raw) as MediaKey) : null;
  } catch { return null; }
}
