// lib/ghostProtocol.ts — decoy account store (the "second account" in the W3
// duress/decoy split).
//
// The decoy is now a REAL, persistent local account — not the old hardcoded
// generators that reset on every reload. Believable starter chats are seeded
// ONCE into AsyncStorage; after that the decoy reads and writes its own store,
// so messages you type in duress mode persist and it behaves like a genuine
// (if mundane) messenger. Cryptographic separation from the real account is
// handled by services/security/duressVault.ts — which vault opens is decided by
// PIN-derived key, not by the flag below.

import AsyncStorage from '@react-native-async-storage/async-storage';

const GHOST_KEY      = 'vc_ghost_active';
const GHOST_WIPE_KEY = 'vc_ghost_wipe_done';
const SEEDED_KEY     = 'vc_decoy_seeded';
const CHATS_KEY      = 'vc_decoy_chats';
const msgsKey = (chatId: string) => `vc_decoy_msgs_${chatId}`;

export interface DecoyChat {
  id: string; name: string; avatar: string | null;
  lastMsg: string; time: string; unread: number; pinned: boolean; muted: boolean;
}
export interface DecoyMessage {
  id: string; text: string; sent: boolean; time: string; delivered?: boolean;
}

// ── Duress-mode flag (selection is cryptographic; this only drives UI state) ──
export async function isGhostMode(): Promise<boolean> {
  return (await AsyncStorage.getItem(GHOST_KEY)) === '1';
}
export async function activateGhost(): Promise<void> {
  await AsyncStorage.setItem(GHOST_KEY, '1');
}
export async function deactivateGhost(): Promise<void> {
  await AsyncStorage.removeItem(GHOST_KEY);
  await AsyncStorage.removeItem(GHOST_WIPE_KEY);
}
export async function markWipeDone(): Promise<void> {
  await AsyncStorage.setItem(GHOST_WIPE_KEY, '1');
}
export async function wasWipeDone(): Promise<boolean> {
  return (await AsyncStorage.getItem(GHOST_WIPE_KEY)) === '1';
}

// ── Seed content (believable starter account, written once) ──────────────────
function seedChats(): DecoyChat[] {
  return [
    { id: 'decoy_1', name: 'Mom',            avatar: null, lastMsg: 'Coming home for dinner tonight?',  time: '7:45 PM',   unread: 1, pinned: true,  muted: false },
    { id: 'decoy_2', name: 'Rahul',          avatar: null, lastMsg: 'Bro the match was insane yesterday', time: '11:30 AM', unread: 3, pinned: false, muted: false },
    { id: 'decoy_3', name: 'Work Group',     avatar: null, lastMsg: 'Priya: Meeting moved to 3pm',       time: '10:45 AM', unread: 0, pinned: false, muted: true  },
    { id: 'decoy_4', name: 'Sneha',          avatar: null, lastMsg: 'Thanks for the notes!',             time: '3:30 PM',  unread: 0, pinned: false, muted: false },
    { id: 'decoy_5', name: 'Amazon Delivery',avatar: null, lastMsg: 'Your order has been shipped',       time: 'Yesterday',unread: 0, pinned: false, muted: true  },
    { id: 'decoy_6', name: 'Dad',            avatar: null, lastMsg: 'Call me when free',                 time: 'Yesterday',unread: 0, pinned: false, muted: false },
    { id: 'decoy_7', name: 'College Friends',avatar: null, lastMsg: 'Amit: Reunion plan confirmed for March', time: 'Monday', unread: 0, pinned: false, muted: false },
    { id: 'decoy_8', name: 'Gym Trainer',    avatar: null, lastMsg: 'Rest day tomorrow, back to legs Thursday', time: 'Monday', unread: 0, pinned: false, muted: false },
  ];
}

function seedMessages(chatId: string): DecoyMessage[] {
  const convos: Record<string, DecoyMessage[]> = {
    decoy_1: [
      { id: '1', text: 'Hi beta, dinner at 8?', sent: false, time: '6:30 PM' },
      { id: '2', text: 'Yes mom, coming!', sent: true, time: '6:32 PM' },
      { id: '3', text: 'Should I bring anything?', sent: true, time: '6:32 PM' },
      { id: '4', text: 'Just come home safely', sent: false, time: '6:35 PM' },
      { id: '5', text: 'Coming home for dinner tonight?', sent: false, time: '7:45 PM' },
    ],
    decoy_2: [
      { id: '1', text: 'Did you watch the match?', sent: false, time: '10:00 AM' },
      { id: '2', text: 'Yes! That last over was crazy', sent: true, time: '10:05 AM' },
      { id: '3', text: 'Best innings this season', sent: true, time: '10:08 AM' },
      { id: '4', text: 'Bro the match was insane yesterday', sent: false, time: '11:30 AM' },
    ],
    decoy_3: [
      { id: '1', text: 'Team meeting at 2pm today', sent: false, time: '9:00 AM' },
      { id: '2', text: 'I will be there', sent: true, time: '9:15 AM' },
      { id: '3', text: 'Priya: Meeting moved to 3pm', sent: false, time: '10:45 AM' },
    ],
    decoy_4: [
      { id: '1', text: 'Hey can you share the physics notes?', sent: false, time: '3:00 PM' },
      { id: '2', text: 'Sure, sending now', sent: true, time: '3:05 PM' },
      { id: '3', text: 'Thanks for the notes!', sent: false, time: '3:30 PM' },
    ],
    decoy_5: [
      { id: '1', text: 'Your order #1247 has been confirmed', sent: false, time: 'Yesterday' },
      { id: '2', text: 'Your order has been shipped', sent: false, time: 'Yesterday' },
    ],
    decoy_6: [
      { id: '1', text: 'How are your studies going?', sent: false, time: 'Yesterday' },
      { id: '2', text: 'Good dad, preparing for exams', sent: true, time: 'Yesterday' },
      { id: '3', text: 'Call me when free', sent: false, time: 'Yesterday' },
    ],
    decoy_7: [
      { id: '1', text: 'Guys lets plan a reunion!', sent: false, time: 'Monday' },
      { id: '2', text: "I'm in!", sent: true, time: 'Monday' },
      { id: '3', text: 'Amit: Reunion plan confirmed for March', sent: false, time: 'Monday' },
    ],
    decoy_8: [
      { id: '1', text: 'Great session today', sent: false, time: 'Monday' },
      { id: '2', text: 'Thanks coach!', sent: true, time: 'Monday' },
      { id: '3', text: 'Rest day tomorrow, back to legs Thursday', sent: false, time: 'Monday' },
    ],
  };
  return convos[chatId] || [
    { id: '1', text: 'Hey!', sent: false, time: '12:00 PM' },
    { id: '2', text: 'Hi, how are you?', sent: true, time: '12:05 PM' },
  ];
}

async function ensureSeeded(): Promise<void> {
  if ((await AsyncStorage.getItem(SEEDED_KEY)) === '1') return;
  await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(seedChats()));
  await AsyncStorage.setItem(SEEDED_KEY, '1');
}

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function nowLabel(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Seed the decoy account if it has never been provisioned (call at duress setup). */
export async function seedDecoyAccount(): Promise<void> {
  await ensureSeeded();
}

/** The decoy chat list (persistent). */
export async function getDecoyChats(): Promise<DecoyChat[]> {
  await ensureSeeded();
  return safeParse<DecoyChat[]>(await AsyncStorage.getItem(CHATS_KEY), seedChats());
}

/** Messages for a decoy chat (persistent; seeds the thread on first open). */
export async function getDecoyMessages(chatId: string): Promise<DecoyMessage[]> {
  const raw = await AsyncStorage.getItem(msgsKey(chatId));
  if (raw) return safeParse<DecoyMessage[]>(raw, []);
  const seed = seedMessages(chatId);
  await AsyncStorage.setItem(msgsKey(chatId), JSON.stringify(seed));
  return seed;
}

/** Persist a sent decoy message and update the chat preview. Returns the message. */
export async function appendDecoyMessage(chatId: string, text: string): Promise<DecoyMessage> {
  const msg: DecoyMessage = { id: Date.now().toString(), text, sent: true, time: nowLabel(), delivered: false };
  const msgs = await getDecoyMessages(chatId);
  await AsyncStorage.setItem(msgsKey(chatId), JSON.stringify([...msgs, msg]));

  const chats = await getDecoyChats();
  const updated = chats.map((c) => (c.id === chatId ? { ...c, lastMsg: text, time: msg.time, unread: 0 } : c));
  await AsyncStorage.setItem(CHATS_KEY, JSON.stringify(updated));
  return msg;
}

/** Mark a decoy message delivered (persisted). */
export async function markDecoyDelivered(chatId: string, msgId: string): Promise<void> {
  const msgs = await getDecoyMessages(chatId);
  const next = msgs.map((m) => (m.id === msgId ? { ...m, delivered: true } : m));
  await AsyncStorage.setItem(msgsKey(chatId), JSON.stringify(next));
}
