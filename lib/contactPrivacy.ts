
// lib/contactPrivacy.ts
// Privacy rules — context-aware (WhatsApp-style + correct)
//
// KEY FIX: Two contexts with DIFFERENT rules:
//
// CONTEXT: 'browse'  — you looking at contact/chat list
//   Saved   → full name, full photo, status, online, last seen
//   Unsaved → grey circle, no name, no status (their privacy)
//
// CONTEXT: 'request' — they messaged YOU (incoming request)
//   Saved   → full name, full photo (normal chat)
//   Unsaved → SHOW their crazzychat photo + name so YOU can decide
//              You need to see who it is to accept/decline
//
// This matches exactly how WhatsApp works:
//   Message request → shows sender's name + photo
//   You don't know them → their info is visible so you can recognise

import { VaultContact } from './contactSync';

export type PrivacyContext = 'browse' | 'request';

export type VisibleProfile = {
  displayName:     string;
  showPhoto:       boolean;
  photoUri?:       string;
  showStatus:      boolean;
  status?:         string;
  showOnline:      boolean;
  online?:         boolean;
  showLastSeen:    boolean;
  lastSeen?:       number;
  showReadReceipt: boolean;
  isMessageReq:    boolean;
  canViewProfile:  boolean;
};

export function getVisibleProfile(
  contact:   VaultContact | null,
  isSaved:   boolean,
  context:   PrivacyContext = 'browse'
): VisibleProfile {

  // ── Person not on crazzychat ────────────────────────────────
  if (!contact || !contact.isOnVault) {
    return {
      displayName:     isSaved ? contact?.name || 'Unknown' : 'crazzychat User',
      showPhoto:       false,
      showStatus:      false,
      showOnline:      false,
      showLastSeen:    false,
      showReadReceipt: false,
      isMessageReq:    false,
      canViewProfile:  false,
    };
  }

  // ── Saved in your phone contacts ──────────────────────────
  if (isSaved) {
    return {
      // Always use YOUR saved name — not their crazzychat name
      displayName:     contact.name,
      showPhoto:       true,
      photoUri:        contact.vaultAvatar || contact.avatar,
      showStatus:      true,
      status:          contact.status,
      showOnline:      true,
      online:          contact.online,
      showLastSeen:    true,
      lastSeen:        contact.lastSeen,
      showReadReceipt: true,
      isMessageReq:    false,
      canViewProfile:  true,
    };
  }

  // ── NOT saved — but they sent YOU a message (request context)
  // Show their photo + crazzychat name so you can recognise them
  if (context === 'request') {
    return {
      displayName:     contact.vaultName || contact.vaultId.slice(0, 12),
      showPhoto:       true,                  // ✅ SHOW so you can recognise
      photoUri:        contact.vaultAvatar,   // ✅ their crazzychat photo
      showStatus:      false,                 // still hidden (their privacy)
      showOnline:      false,                 // still hidden
      showLastSeen:    false,                 // still hidden
      showReadReceipt: false,                 // no receipts until accepted
      isMessageReq:    true,
      canViewProfile:  false,                 // limited profile view
    };
  }

  // ── NOT saved — browse context (you browsing contacts/chat list)
  // Their info is hidden — they haven't reached out to you
  return {
    displayName:     'Unknown',              // no name reveal
    showPhoto:       false,                  // grey circle
    showStatus:      false,
    showOnline:      false,
    showLastSeen:    false,
    showReadReceipt: false,
    isMessageReq:    false,
    canViewProfile:  false,
  };
}

export function formatLastSeen(ts?: number): string {
  if (!ts) return '';
  const diff  = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  === 1) return 'yesterday';
  if (days  < 7)  return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function isSavedContact(vaultId: string, contacts: VaultContact[]): boolean {
  return contacts.some(c => c.vaultId === vaultId && c.isSaved);
}
