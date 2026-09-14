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

// WHAT THIS DOES NOT DO — Android 13+ clipboard preview.
//
// Since Android 13 the system shows a floating preview of whatever was just
// copied, and an app suppresses the text in it by putting
// ClipDescription.EXTRA_IS_SENSITIVE (`android.content.extra.IS_SENSITIVE`) in
// the ClipData's extras. So a VaultChat message copied here is still previewed
// on screen for a couple of seconds regardless of the auto-clear below.
//
// It is not fixed here because it CANNOT be from JS: expo-clipboard's
// setStringAsync takes exactly one option, `inputFormat`
// (node_modules/expo-clipboard/build/Clipboard.types.d.ts), and the word
// "sensitive" does not appear anywhere in the package. Reaching the flag means
// a native module or an expo-config-plugin patch calling
// `clip.description.extras = PersistableBundle().apply {
//     putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }`
// before setPrimaryClip — a native change plus a rebuild, not a line here.
// Writing a `sensitive: true` option that expo-clipboard drops on the floor
// would be one more control that lies, which is the thing being audited.
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
