// Per-chat message drafts (feature 66). Unsent composer text is auto-saved
// locally and restored when the chat reopens; a "Draft:" preview shows in the
// chat list. Stored in AsyncStorage with a small index so the list can render
// previews without scanning every key.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = (chatId: string) => `vc_draft_${chatId}`;
const INDEX = 'vc_draft_index';

async function readIndex(): Promise<string[]> {
  try { const raw = await AsyncStorage.getItem(INDEX); const a = raw ? JSON.parse(raw) : []; return Array.isArray(a) ? a : []; }
  catch { return []; }
}
async function writeIndex(ids: string[]): Promise<void> {
  try { await AsyncStorage.setItem(INDEX, JSON.stringify([...new Set(ids)])); } catch {}
}

export async function saveDraft(chatId: string, text: string): Promise<void> {
  if (!text || !text.trim()) { await clearDraft(chatId); return; }
  try {
    await AsyncStorage.setItem(KEY(chatId), text);
    const idx = await readIndex();
    if (!idx.includes(chatId)) await writeIndex([...idx, chatId]);
  } catch {}
}

export async function getDraft(chatId: string): Promise<string> {
  try { return (await AsyncStorage.getItem(KEY(chatId))) ?? ''; } catch { return ''; }
}

export async function clearDraft(chatId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY(chatId));
    const idx = await readIndex();
    if (idx.includes(chatId)) await writeIndex(idx.filter(id => id !== chatId));
  } catch {}
}

/** Map of chatId → draft text for all chats that currently have a draft. */
export async function getDraftMap(): Promise<Record<string, string>> {
  const idx = await readIndex();
  const out: Record<string, string> = {};
  await Promise.all(idx.map(async (id) => {
    const d = await AsyncStorage.getItem(KEY(id));
    if (d && d.trim()) out[id] = d; else out[id] = '';
  }));
  return out;
}

export default { saveDraft, getDraft, clearDraft, getDraftMap };
