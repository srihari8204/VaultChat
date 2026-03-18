// services/mediaService.ts
// Upload images, videos, audio, files to Firebase Storage

import storage from '@react-native-firebase/storage';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface UploadResult {
  downloadURL: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  size?: number;
}

// Upload any local file URI to Firebase Storage
// Returns the public download URL
export async function uploadMedia(
  localUri: string,
  chatId: string,
  type: MediaType,
  filename?: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  const ext  = localUri.split('.').pop()?.toLowerCase() ?? 'bin';
  const name = filename ?? `${type}_${Date.now()}.${ext}`;
  const path = `chats/${chatId}/${type}s/${name}`;
  const ref  = storage().ref(path);

  const task = ref.putFile(localUri);

  if (onProgress) {
    task.on('state_changed', snap => {
      const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
      onProgress(Math.round(pct));
    });
  }

  await task;
  const downloadURL = await ref.getDownloadURL();

  const mimeMap: Record<MediaType, string> = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/m4a',
    file:  'application/octet-stream',
  };

  return { downloadURL, storagePath: path, filename: name, mimeType: mimeMap[type] };
}

// Delete a file from Firebase Storage by its storagePath
export async function deleteMedia(storagePath: string): Promise<void> {
  try {
    await storage().ref(storagePath).delete();
  } catch { /* ignore if already deleted */ }
}