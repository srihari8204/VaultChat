// lib/galleryExport.ts — publish chat media into the device's own gallery.
//
// WHY THIS DID NOT EXIST
//
// mediaStore keeps every photo and video inside the app sandbox
// (<documentDirectory>/VaultChat/Media/...). That is deliberate and it is why
// storeSentCopy carries this note:
//
//   "No RNFS.scanFile: publishing chat media into the system gallery index is a
//    separate consent decision from receiving it ... The user exports
//    deliberately via 'Save to gallery'."
//
// The reasoning holds — a sandbox file is invisible to MediaStore, so nothing
// leaks by accident — but the "Save to gallery" it points at was never built.
// The result was media that exists on the device and cannot be seen from the
// Gallery app at all, which is not the behaviour people expect from a
// messenger.
//
// WHAT THIS DOES
//
// Copies a decrypted local file into the system gallery under a "crazzychat"
// album, the way WhatsApp groups its media. It is a COPY: the sandbox original
// stays put, so retention, revoke and purgeLocalCopies keep working on it.
//
// WHAT IT DELIBERATELY REFUSES
//
//   * view-once media — the whole point is that it does not persist. Exporting
//     one to the camera roll would defeat the feature silently, so the caller
//     must pass viewOnce and this refuses on it. Callers that cannot prove a
//     message is NOT view-once should not call this.
//   * anything that is not an image or a video — documents and voice notes have
//     no place in a photo gallery.
//   * everything, when the user has turned the setting off.
//
// The export is idempotent per attachment: re-opening a photo does not add a
// second copy to the camera roll.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as MediaLibrary from 'expo-media-library';

const PREF_KEY = 'vc_save_media_to_gallery';
const DONE_KEY = 'vc_gallery_exported_v1';
const ALBUM = 'crazzychat';

let prefCached: boolean | null = null;
let doneCached: Set<string> | null = null;

/**
 * Is auto-export on? Defaults to TRUE for parity with the messengers people
 * compare this to — a photo you were sent shows up in your gallery. The toggle
 * exists because that is a real privacy trade: anything exported is readable by
 * every app with media permission, and is no longer covered by this app's own
 * lock, retention or revoke.
 */
export async function getSaveToGallery(): Promise<boolean> {
  if (prefCached !== null) return prefCached;
  try {
    const v = await AsyncStorage.getItem(PREF_KEY);
    prefCached = v === null ? true : v === '1';
  } catch {
    prefCached = true;
  }
  return prefCached;
}

export async function setSaveToGallery(on: boolean): Promise<void> {
  prefCached = on;
  try { await AsyncStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* pref is best-effort */ }
}

async function exportedSet(): Promise<Set<string>> {
  if (doneCached) return doneCached;
  try {
    const raw = await AsyncStorage.getItem(DONE_KEY);
    doneCached = new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    doneCached = new Set<string>();
  }
  return doneCached;
}

async function markExported(id: string): Promise<void> {
  const set = await exportedSet();
  set.add(id);
  // Bound the ledger. 5000 ids is far more than a gallery review ever needs and
  // keeps the AsyncStorage row small; the cost of forgetting an old one is a
  // duplicate in the camera roll, not a correctness bug.
  const ids = [...set].slice(-5000);
  doneCached = new Set(ids);
  try { await AsyncStorage.setItem(DONE_KEY, JSON.stringify(ids)); } catch { /* best-effort */ }
}

export interface ExportOpts {
  kind: string;
  /** MUST be passed by any caller that can see a view-once message. */
  viewOnce?: boolean;
  /** Used to make the export idempotent. Without it every open re-copies. */
  attachmentId?: string;
}

/**
 * Copy one local media file into the device gallery.
 *
 * Returns true only when an asset was actually created. Never throws: a device
 * that refuses the permission, or an OEM gallery that rejects the file, must
 * not break rendering the message.
 */
export async function exportToGallery(localUri: string, opts: ExportOpts): Promise<boolean> {
  try {
    if (opts.viewOnce) return false;
    if (opts.kind !== 'image' && opts.kind !== 'video') return false;
    if (!localUri) return false;
    if (!(await getSaveToGallery())) return false;

    if (opts.attachmentId) {
      const set = await exportedSet();
      if (set.has(opts.attachmentId)) return false;
    }

    const uri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;

    // WRITE-ONLY on purpose.
    //
    // Another Expo plugin caps READ_MEDIA_IMAGES at maxSdkVersion=33 (on 34+ it
    // uses the system Photo Picker instead), so on a modern device that
    // permission is never granted and a full-access request cannot succeed.
    // Verified on Android 16 / API 36. We only ever ADD our own file, which
    // needs no read access at all — so ask for write only, and treat a refusal
    // as "try the write-only API anyway" rather than giving up.
    let granted = false;
    try {
      let perm = await MediaLibrary.getPermissionsAsync(true);
      if (!perm.granted && perm.canAskAgain) perm = await MediaLibrary.requestPermissionsAsync(true);
      granted = perm.granted;
    } catch { /* permission API unavailable — fall through to the save attempt */ }

    // Preferred: a real asset we can file into a "crazzychat" album, the way
    // WhatsApp groups its media. Needs enough access to manage albums.
    if (granted) {
      try {
        const asset = await MediaLibrary.createAssetAsync(uri);
        try {
          const album = await MediaLibrary.getAlbumAsync(ALBUM);
          if (album) await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
          else await MediaLibrary.createAlbumAsync(ALBUM, asset, false);
        } catch { /* saved; album grouping is cosmetic */ }
        if (opts.attachmentId) await markExported(opts.attachmentId);
        return true;
      } catch { /* fall through to the write-only path */ }
    }

    // Fallback: hand the file to the OS media store. Lands in the camera roll
    // with no album, which is still the outcome that matters.
    await MediaLibrary.saveToLibraryAsync(uri);
    if (opts.attachmentId) await markExported(opts.attachmentId);
    return true;
  } catch {
    return false;
  }
}

/** Fire-and-forget wrapper for render paths that must not await an export. */
export function exportToGalleryInBackground(localUri: string, opts: ExportOpts): void {
  exportToGallery(localUri, opts).catch(() => { /* already swallowed */ });
}

export default { exportToGallery, exportToGalleryInBackground, getSaveToGallery, setSaveToGallery };
