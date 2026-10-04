// components/vault/pickVaultFile.ts — app/vault.tsx's file pickers (moved out
// of the screen file; behaviour unchanged). Photos and videos come from the
// gallery after its permission (a refusal offers Settings when Android no
// longer asks, lib/permissionDenied); documents and voice notes come from the
// document picker, copied to the cache. Every picker runs inside the screen's
// `withSystemUi`, so going to it does not re-lock the vault.

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { permissionDenied } from '../../lib/permissionDenied';

export interface PickedVaultFile { uri: string; name: string; size: number; mimeType: string }

/** The file the user picked, or null when they cancelled or refused access. */
export async function pickVaultFile(
  kind: 'photo' | 'video' | 'document',
  withSystemUi: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<PickedVaultFile | null> {
  if (kind === 'document') {
    const result = await withSystemUi(() => DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true }));
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return null;
    return { uri: asset.uri, name: asset.name, size: asset.size || 0, mimeType: asset.mimeType || 'application/octet-stream' };
  }
  const photo = kind === 'photo';
  const { status, canAskAgain } = await withSystemUi(() => ImagePicker.requestMediaLibraryPermissionsAsync());
  if (status !== 'granted') {
    permissionDenied('Photo access needed', `Allow gallery access to move a ${kind} into the vault.`, canAskAgain);
    return null;
  }
  const result = await withSystemUi(() => ImagePicker.launchImageLibraryAsync(photo
    ? { mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85 }
    : { mediaTypes: ImagePicker.MediaTypeOptions.Videos }));
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  return {
    uri: asset.uri,
    name: asset.fileName || (photo ? `photo_${Date.now()}.jpg` : `video_${Date.now()}.mp4`),
    size: asset.fileSize || 0,
    mimeType: asset.mimeType || (photo ? 'image/jpeg' : 'video/mp4'),
  };
}
