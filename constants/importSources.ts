// constants/importSources.ts — the messengers Exit Kit can import a conversation
// from, and how each one is shown.
//
// One definition, because it is read from two places that must not drift: the
// Exit Kit source picker (app/import-chats.tsx) and the message bubble that marks
// where an imported message came from (components/chat/MessageBubble.tsx). If the
// picker offered a green WhatsApp row and the bubble drew a grey generic mark,
// the app would be telling the user two different things about the same message.
//
// Keyed by `meta.origin`, which is the marker every import writes and the only
// thing that distinguishes an imported message from a VaultChat-native one.

import type { Ionicons } from '@expo/vector-icons';

export type ImportOrigin = 'wa-import' | 'tg-import' | 'snap-import';

export interface ImportSource {
  origin: ImportOrigin;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** Brand tint, chosen to stay legible on BOTH the light and dark chat surface —
   *  Snapchat's actual #FFFC00 disappears on a white background, so it is darkened
   *  to a gold that still reads as Snapchat without vanishing. */
  tint: string;
  /** False until that parser ships. A source with no parser must not open a file
   *  picker: failing after the user has chosen a file is worse than "not yet". */
  ready: boolean;
  hint: string;
}

export const IMPORT_SOURCES: ImportSource[] = [
  { origin: 'wa-import',   label: 'WhatsApp', icon: 'logo-whatsapp', tint: '#25D366', ready: true,
    hint: 'Open the chat in WhatsApp → ⋮ → More → Export chat' },
  { origin: 'tg-import',   label: 'Telegram', icon: 'paper-plane',   tint: '#2AABEE', ready: false,
    hint: 'Desktop JSON exports' },
  { origin: 'snap-import', label: 'Snapchat', icon: 'logo-snapchat', tint: '#C99A00', ready: false,
    hint: 'Saved chats & Memories' },
];

/** Look up how to badge a message, by its `meta.origin`. Undefined for a
 *  VaultChat-native message, which is exactly the test the UI needs. */
export const IMPORT_SOURCE: Record<string, ImportSource> =
  Object.fromEntries(IMPORT_SOURCES.map(s => [s.origin, s]));

export default IMPORT_SOURCES;
