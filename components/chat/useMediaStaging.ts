// components/chat/useMediaStaging.ts — media waiting in the caption preview:
// gallery multi-pick, items handed back by /camera, /video-notes and
// /image-editor, per-item caption/view-once edits, and the final send through
// the media outbox. Moved out of app/chat.tsx unchanged; the staged list is
// local to it and the preview (MediaCaptionPreview) draws it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import type { Router } from 'expo-router';
import { permissionDenied } from '../../lib/permissionDenied';
import type { MediaType } from '../../lib/sendMedia';
import type { PendingItem } from './MediaCaptionPreview';

type Enqueue = (
  type: MediaType,
  file: { uri: string; filename: string; mime: string },
  opts?: { caption?: string; viewOnce?: boolean; metaExtra?: Record<string, any> },
) => Promise<void>;

export function useMediaStaging({ sending, enqueueMediaOptimistic, params, router }: {
  sending: boolean;
  enqueueMediaOptimistic: Enqueue;
  params: { capturedUri?: string; capturedType?: string; capturedViewOnce?: string; capturedName?: string };
  router: Router;
}) {
  // Media staged for sending, shown in a caption-preview before it goes out.
  // Every send path (gallery pick, camera, video note, edited photo) routes
  // through here so the user can add a caption (WhatsApp-style).
  // Staged media awaiting send — supports WhatsApp-style multi-select. Each
  // item carries its own caption + view-once; currentIdx is the one on screen.
  const [pendingItems, setPendingItems] = useState<PendingItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  // ── Attach photo / video (with optional view-once) ────────
  // One unified picker. kind='images' → photo upload, type='image' message.
  //                    kind='videos' → video upload, type='video' message.
  // viewOnce=true sets a flag on the upload AND on the message meta so the
  // receiving bubble can render the "Tap to view once" UI and the server
  // can 410 the bytes after first non-owner view.
  const onPickMedia = useCallback(async (
    kind: 'images' | 'videos',
    opts: { viewOnce?: boolean } = {},
  ) => {
    if (sending) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      permissionDenied('Permission needed', `Allow ${kind === 'videos' ? 'video' : 'photo'} library access to attach.`, perm.canAskAgain);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: [kind],
      quality:    kind === 'videos' ? 1 : 0.7,
      allowsEditing: false,
      allowsMultipleSelection: true,   // WhatsApp-style multi-select
      selectionLimit: 10,
      orderedSelection: true,
      videoMaxDuration: 60, // hard cap to keep upload size sane on free plan
    });
    if (result.canceled || !result.assets?.length) return;
    const isVideo = kind === 'videos';
    const stamp = Date.now();
    // One id shared by everything picked in this single action, so the timeline
    // can render them as ONE album instead of N stacked bubbles. Purely a
    // presentation grouping: each pick is still its own message, with its own
    // id, its own ciphertext and its own delivery state, so nothing about
    // sending, retrying or receipts changes. Only set for a genuine multi-pick.
    const albumId = result.assets.length > 1 ? `alb-${stamp}` : null;
    // Stage all picks for the multi-image caption preview.
    const items = result.assets.map((asset, i) => {
      const filename = asset.fileName ||
        (isVideo ? `video-${stamp}-${i}.mp4` : `photo-${stamp}-${i}.jpg`);
      const mime = asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg');
      const metaExtra: any = { width: asset.width, height: asset.height };
      if (isVideo && asset.duration) metaExtra.durationMs = asset.duration;
      if (albumId) { metaExtra.albumId = albumId; metaExtra.albumIndex = i; }
      return {
        uri: asset.uri, mediaType: (isVideo ? 'video' : 'image') as 'image' | 'video',
        filename, mime, viewOnce: !!opts.viewOnce, metaExtra, caption: '',
      };
    });
    setPendingItems(items);
    setCurrentIdx(0);
  }, [sending]);

  const confirmSendPendingMedia = useCallback(async () => {
    if (pendingItems.length === 0) return;
    const items = pendingItems;
    setPendingItems([]);
    setCurrentIdx(0);
    // enqueueMedia now THROWS when the outbox write does not land, instead of
    // reporting success for a row that was never saved. Unguarded, that throw
    // would surface as an unhandled rejection — the user would see the picker
    // close and nothing else, which is the same silence the throw exists to
    // replace. Same shape as the file-pick handler below.
    //
    // Per item, not around the loop: one item failing to save must not silently
    // drop the ones after it.
    for (const pm of items) {
      try {
        await enqueueMediaOptimistic(pm.mediaType, { uri: pm.uri, filename: pm.filename, mime: pm.mime },
          { caption: pm.caption.trim() || undefined, viewOnce: pm.viewOnce, metaExtra: pm.metaExtra });
      } catch (e: any) {
        Alert.alert('Could not send', e?.message ?? 'Try again');
      }
    }
  }, [pendingItems, enqueueMediaOptimistic]);

  // Helpers for the multi-item preview.
  const updateCurrentItem = useCallback((patch: Partial<{ caption: string; viewOnce: boolean }>) => {
    setPendingItems(prev => prev.map((it, i) => i === currentIdx ? { ...it, ...patch } : it));
  }, [currentIdx]);
  const removePendingAt = useCallback((idx: number) => {
    setPendingItems(prev => {
      const next = prev.filter((_, i) => i !== idx);
      setCurrentIdx(ci => Math.max(0, Math.min(ci - (idx <= ci ? 1 : 0), next.length - 1)));
      return next;
    });
  }, []);
  const addMorePhotos = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: true, selectionLimit: 10, orderedSelection: true,
    });
    if (result.canceled || !result.assets?.length) return;
    const stamp = Date.now();
    const more = result.assets.map((asset, i) => ({
      uri: asset.uri, mediaType: 'image' as const,
      filename: asset.fileName || `photo-${stamp}-${i}.jpg`,
      mime: asset.mimeType || 'image/jpeg', viewOnce: false,
      metaExtra: { width: asset.width, height: asset.height } as Record<string, any>, caption: '',
    }));
    setPendingItems(prev => [...prev, ...more]);
  }, []);

  // ── Consume media captured by /camera, /video-notes, /image-editor ──
  // Those screens return here (router.dismissTo) with capturedUri + capturedType.
  // Send it exactly once, then clear the params so a re-render or Back never
  // re-sends the same file.
  const consumedCaptureRef = useRef<string | null>(null);
  useEffect(() => {
    const uri = params.capturedUri || '';
    if (!uri || consumedCaptureRef.current === uri) return;
    consumedCaptureRef.current = uri;
    const rawType = params.capturedType || 'image';
    const isVideo = rawType === 'video' || rawType === 'video-note';
    // SCAN mode returns one assembled PDF, not an image.
    const isFile = rawType === 'file';
    // View-once marks image/video bytes on send — a document has none to mark.
    const viewOnce = !isFile && params.capturedViewOnce === '1';
    // Clear immediately so navigating back into the chat doesn't re-stage.
    router.setParams({ capturedUri: '', capturedType: '', capturedViewOnce: '', capturedName: '' });
    const filename = isFile
      ? (params.capturedName || `Scan-${Date.now()}.pdf`)
      : isVideo
        ? `${rawType === 'video-note' ? 'note' : 'video'}-${Date.now()}.mp4`
        : `photo-${Date.now()}.jpg`;
    const mime = isFile ? 'application/pdf' : isVideo ? 'video/mp4' : 'image/jpeg';
    const metaExtra: Record<string, any> = rawType === 'video-note' ? { videoNote: true } : {};
    // Stage in the caption preview (same as a gallery pick).
    setPendingItems([{ uri, mediaType: isFile ? 'file' : isVideo ? 'video' : 'image', filename, mime, viewOnce, metaExtra, caption: '' }]);
    setCurrentIdx(0);
  }, [params.capturedUri, params.capturedType, params.capturedViewOnce, params.capturedName, router]);

  return {
    pendingItems, setPendingItems, currentIdx, setCurrentIdx,
    onPickMedia, confirmSendPendingMedia, updateCurrentItem, removePendingAt, addMorePhotos,
  };
}
