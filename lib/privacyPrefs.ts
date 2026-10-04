// lib/privacyPrefs.ts — the two privacy controls that were previously fake or
// absent.
//
// 1. NOTIFICATION PREVIEW — how much an OS notification is allowed to say.
//    app/vault-features.tsx used to ship a "Hide message text in notification
//    tray" switch that was read by nothing and hid nothing (the push path is
//    content-free end to end: the server sends data-only FCM and the client
//    hardcodes body = 'New message'). That switch is deleted; this is the real
//    control, and lib/messageNotifications.ts actually reads it.
//
// 2. REMOTE LINK PREVIEWS — whether THIS device may ask our own server to
//    resolve a URL that arrived inside an end-to-end-encrypted message.
//    Sending is already right: lib/linkPreview.ts resolves at compose time and
//    ships a downsized preview inside the envelope, so the recipient contacts
//    nothing. The RECIPIENT-side fallback in components/LinkPreview.tsx did the
//    opposite — GET /link/preview?url=… handed the server a URL it was never
//    supposed to learn, with no way to turn it off. Now it is off by default.
//
// AsyncStorage is imported dynamically rather than at the top so this module —
// and in particular its pure defaults and notifContent() — can be loaded
// outside React Native. See lib/privacyPrefs.selftest.ts.

export type NotifPreview = 'name' | 'generic' | 'hidden';

/**
 * Name-only: the chat name in the title, no message text. This is what the app
 * already did, so the default changes nothing about how useful notifications
 * are — it just becomes a stated, switchable choice instead of an accident.
 *
 * There is deliberately no 'full' mode. "Full" means decrypted message text in
 * the tray, and this client cannot decrypt at notification time: the FCM push
 * carries no body at all, and the client-raised path (no-GMS devices) never
 * opens the ratchet in the background. Offering the option would be exactly the
 * lie the deleted hideChatPreview switch was.
 */
export const DEFAULT_NOTIF_PREVIEW: NotifPreview = 'name';

/**
 * OFF. A preview resolved here leaks a URL out of an E2EE message to the
 * server, and the user cannot see it happen. Messages sent by an up-to-date
 * client still show their card — the sender embedded it in the envelope — so
 * the visible cost is preview cards on old or foreign-client messages.
 */
export const DEFAULT_REMOTE_LINK_PREVIEWS = false;

export const NOTIF_PREVIEW_OPTIONS: { value: NotifPreview; title: string; desc: string }[] = [
  { value: 'name',    title: 'Sender name',  desc: 'Chat name, no message text' },
  { value: 'generic', title: 'Generic',      desc: 'Just “crazzychat — New message”' },
  { value: 'hidden',  title: 'No notification', desc: 'Nothing appears in the tray' },
];

/**
 * Pure. What a notification is allowed to say under `mode`.
 * `null` means raise nothing at all.
 */
export function notifContent(
  mode: NotifPreview,
  chatName: string,
): { title: string; body: string } | null {
  if (mode === 'hidden') return null;
  if (mode === 'generic') return { title: 'crazzychat', body: 'New message' };
  return { title: chatName || 'crazzychat', body: 'New message' };
}

// ── storage ──────────────────────────────────────────────────────────
const NOTIF_KEY = 'vc_notif_preview';
const LINK_KEY  = 'vc_remote_link_previews';

async function store() {
  return (await import('@react-native-async-storage/async-storage')).default;
}

let notifCached: NotifPreview = DEFAULT_NOTIF_PREVIEW;
let linkCached = DEFAULT_REMOTE_LINK_PREVIEWS;

export function getNotifPreviewCached(): NotifPreview { return notifCached; }
export function getRemoteLinkPreviewsCached(): boolean { return linkCached; }

export async function getNotifPreview(): Promise<NotifPreview> {
  try {
    const v = await (await store()).getItem(NOTIF_KEY);
    if (v === 'name' || v === 'generic' || v === 'hidden') { notifCached = v; return v; }
  } catch {}
  return notifCached;
}

export async function setNotifPreview(v: NotifPreview): Promise<void> {
  notifCached = v;
  try { await (await store()).setItem(NOTIF_KEY, v); } catch {}
  // Calendar reminders already booked keep the title they were booked with;
  // rewrite them now rather than on the next calendar visit. Dynamic import:
  // this module is loaded by the notification path and must stay light.
  if (v !== 'name') {
    import('./groups/taskReminders').then((m) => m.hideBookedEventReminderTitles()).catch(() => {});
  }
}

export async function getRemoteLinkPreviews(): Promise<boolean> {
  try {
    const v = await (await store()).getItem(LINK_KEY);
    if (v === '1' || v === '0') { linkCached = v === '1'; return linkCached; }
  } catch {}
  return linkCached;
}

export async function setRemoteLinkPreviews(on: boolean): Promise<void> {
  linkCached = on;
  try { await (await store()).setItem(LINK_KEY, on ? '1' : '0'); } catch {}
}

export default {};
