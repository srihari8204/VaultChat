// lib/clipboardSafe.ts
//
// Clipboard with auto-clear. After CLEAR_AFTER_MS the contents are wiped
// IF the clipboard still holds what we wrote. (We compare-and-wipe so we
// never clobber something the user manually copied in between.)
//
// Spec ask: "Clipboard auto-clear (30s)". Sensitive copy paths (decryption
// keys, vault passwords, OTPs) should call this instead of expo-clipboard
// directly. Plain chat-message copies also route through here so a phone
// left unattended doesn't keep the last message in the clipboard buffer.

import * as Clipboard from 'expo-clipboard';

const CLEAR_AFTER_MS = 30_000;

// Track the most-recent value we wrote and its timer. If a new write
// comes in before the old timer fires, the old timer is cancelled —
// only the most-recent value can trigger a wipe.
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingValue: string | null = null;

/**
 * Copy `text` to the clipboard and schedule a 30-second auto-clear.
 * The clear is a compare-and-wipe: if the clipboard contents have
 * changed in the meantime (user copied something else), we leave them
 * alone.
 */
export async function copyAndAutoClear(text: string): Promise<void> {
  if (text == null) return;
  await Clipboard.setStringAsync(text);

  if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  pendingValue = text;
  pendingTimer = setTimeout(async () => {
    pendingTimer = null;
    try {
      const current = await Clipboard.getStringAsync();
      if (current === pendingValue) {
        await Clipboard.setStringAsync('');
      }
    } catch { /* clipboard read can fail on some platforms — accept */ }
    pendingValue = null;
  }, CLEAR_AFTER_MS);
}
