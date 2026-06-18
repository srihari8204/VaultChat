// lib/gallerySave.ts — WhatsApp-style "Media visibility".
//
// Auto-saves received photos/videos into a browsable "VaultChat" album in the
// device gallery (visible in Gallery + file explorer under Pictures/VaultChat),
// so media is permanent and findable like WhatsApp's media folder — on top of
// the app's own persistent copy. Controlled by a setting (default ON).

import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ALBUM = 'VaultChat';
const SETTING_KEY = 'vc_save_to_gallery';

let _enabled: boolean | null = null;
const _savedThisSession = new Set<string>();   // de-dupe within a run

export async function isGallerySaveEnabled(): Promise<boolean> {
  if (_enabled !== null) return _enabled;
  try { const v = await AsyncStorage.getItem(SETTING_KEY); _enabled = v === null ? true : v === '1'; }
  catch { _enabled = true; }
  return _enabled;
}

export async function setGallerySaveEnabled(on: boolean): Promise<void> {
  _enabled = on;
  try { await AsyncStorage.setItem(SETTING_KEY, on ? '1' : '0'); } catch {}
}

/**
 * Save a local media file into the VaultChat gallery album. Best-effort and
 * idempotent per dedupeKey. `localUri` should be a file:// path (our persistent
 * media copy). The file is copied to a properly-named temp first so MediaStore
 * detects the type (our persistent files are extension-less).
 */
export async function saveToGallery(
  localUri: string,
  kind: 'image' | 'video',
  dedupeKey: string,
): Promise<void> {
  if (_savedThisSession.has(dedupeKey)) return;
  if (!(await isGallerySaveEnabled())) return;
  _savedThisSession.add(dedupeKey);                 // mark early so concurrent renders don't double-save
  try {
    const perm = await MediaLibrary.requestPermissionsAsync();
    if (!perm.granted) { _savedThisSession.delete(dedupeKey); return; }

    const ext = kind === 'video' ? 'mp4' : 'jpg';
    const tmp = (FileSystem as any).cacheDirectory + `gal_${dedupeKey}.${ext}`;
    await FileSystem.copyAsync({ from: localUri, to: tmp });

    const asset = await MediaLibrary.createAssetAsync(tmp);
    const album = await MediaLibrary.getAlbumAsync(ALBUM);
    if (album) await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
    else await MediaLibrary.createAlbumAsync(ALBUM, asset, false);

    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
  } catch {
    _savedThisSession.delete(dedupeKey);             // allow a retry next time
  }
}

export default {};
