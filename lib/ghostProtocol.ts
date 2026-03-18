// lib/ghostProtocol.ts — Ghost Protocol Engine
// Manages duress/decoy mode state and fake data generation
// ZERO indicators that duress mode is active

import AsyncStorage from '@react-native-async-storage/async-storage';

const GHOST_KEY = 'vc_ghost_active';
const GHOST_WIPE_KEY = 'vc_ghost_wipe_done';

// Check if Ghost Protocol (duress mode) is active
export async function isGhostMode(): Promise<boolean> {
  return (await AsyncStorage.getItem(GHOST_KEY)) === '1';
}

// Activate Ghost Protocol
export async function activateGhost(): Promise<void> {
  await AsyncStorage.setItem(GHOST_KEY, '1');
}

// Deactivate (only possible with real PIN re-entry)
export async function deactivateGhost(): Promise<void> {
  await AsyncStorage.removeItem(GHOST_KEY);
  await AsyncStorage.removeItem(GHOST_WIPE_KEY);
}

// Mark that background wipe was done
export async function markWipeDone(): Promise<void> {
  await AsyncStorage.setItem(GHOST_WIPE_KEY, '1');
}

export async function wasWipeDone(): Promise<boolean> {
  return (await AsyncStorage.getItem(GHOST_WIPE_KEY)) === '1';
}

// Generate realistic fake chat data
// These look like mundane everyday conversations — nothing suspicious
export function generateDecoyChats() {
  const now = Date.now();
  return [
    {
      id: 'decoy_1', name: 'Mom', avatar: null,
      lastMsg: 'Coming home for dinner tonight?',
      time: new Date(now - 180000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      unread: 1, pinned: true, muted: false,
    },
    {
      id: 'decoy_2', name: 'Rahul', avatar: null,
      lastMsg: 'Bro the match was insane yesterday',
      time: new Date(now - 3600000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      unread: 3, pinned: false, muted: false,
    },
    {
      id: 'decoy_3', name: 'Work Group', avatar: null,
      lastMsg: 'Priya: Meeting moved to 3pm',
      time: new Date(now - 7200000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      unread: 0, pinned: false, muted: true,
    },
    {
      id: 'decoy_4', name: 'Sneha', avatar: null,
      lastMsg: 'Thanks for the notes!',
      time: new Date(now - 14400000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      unread: 0, pinned: false, muted: false,
    },
    {
      id: 'decoy_5', name: 'Amazon Delivery', avatar: null,
      lastMsg: 'Your order has been shipped',
      time: 'Yesterday',
      unread: 0, pinned: false, muted: true,
    },
    {
      id: 'decoy_6', name: 'Dad', avatar: null,
      lastMsg: 'Call me when free',
      time: 'Yesterday',
      unread: 0, pinned: false, muted: false,
    },
    {
      id: 'decoy_7', name: 'College Friends', avatar: null,
      lastMsg: 'Amit: Reunion plan confirmed for March',
      time: 'Monday',
      unread: 0, pinned: false, muted: false,
    },
    {
      id: 'decoy_8', name: 'Gym Trainer', avatar: null,
      lastMsg: 'Rest day tomorrow, back to legs Thursday',
      time: 'Monday',
      unread: 0, pinned: false, muted: false,
    },
  ];
}

// Generate fake conversation messages for a decoy chat
export function generateDecoyMessages(chatId: string) {
  const now = Date.now();
  const convos: Record<string, any[]> = {
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
      { id: '3', text: 'Kohli played so well', sent: false, time: '10:06 AM' },
      { id: '4', text: 'Best innings this season', sent: true, time: '10:08 AM' },
      { id: '5', text: 'Bro the match was insane yesterday', sent: false, time: '11:30 AM' },
    ],
    decoy_3: [
      { id: '1', text: 'Team meeting at 2pm today', sent: false, time: '9:00 AM' },
      { id: '2', text: 'I will be there', sent: true, time: '9:15 AM' },
      { id: '3', text: 'Can someone share the agenda?', sent: false, time: '9:20 AM' },
      { id: '4', text: 'Priya: Meeting moved to 3pm', sent: false, time: '10:45 AM' },
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

// Fake call history
export function generateDecoyCallHistory() {
  return [
    { id: 'c1', name: 'Mom', type: 'incoming', callType: 'voice', time: 'Today, 6:30 PM', duration: '4:23' },
    { id: 'c2', name: 'Rahul', type: 'outgoing', callType: 'voice', time: 'Today, 2:15 PM', duration: '12:07' },
    { id: 'c3', name: 'Dad', type: 'missed', callType: 'voice', time: 'Yesterday, 9:00 PM', duration: '' },
    { id: 'c4', name: 'Sneha', type: 'incoming', callType: 'video', time: 'Yesterday, 4:00 PM', duration: '8:45' },
    { id: 'c5', name: 'Work - Priya', type: 'outgoing', callType: 'voice', time: 'Monday, 11:00 AM', duration: '3:12' },
  ];
}

// Fake contacts
export function generateDecoyContacts() {
  return [
    { id: 'dc1', name: 'Amit Sharma', status: 'Hey there!', online: false },
    { id: 'dc2', name: 'Dad', status: '', online: false },
    { id: 'dc3', name: 'Mom', status: 'Busy', online: true },
    { id: 'dc4', name: 'Priya (Work)', status: 'In a meeting', online: true },
    { id: 'dc5', name: 'Rahul', status: 'At the gym', online: false },
    { id: 'dc6', name: 'Sneha', status: 'Studying', online: false },
  ];
}
