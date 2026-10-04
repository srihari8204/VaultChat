// components/chat/MediaBubbles.tsx — the attachment bodies of a message
// bubble: document card/row, voice note, photo and video. Moved out of
// components/chat/MessageBubble.tsx (1,800+ lines); MessageBubble decides
// which one to draw and passes everything in.
//
// `actionRef` (file and voice): the bubble is ONE accessible element, so a
// screen reader cannot reach the open/play control nested inside it. The
// bubble offers those as accessibility actions instead and calls the handler
// this component registers here.

import { Audio, ResizeMode, Video } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, Alert, Platform, Text, TouchableOpacity, View } from 'react-native';
// expo-image for every bubble thumbnail: memory+disk cache and recyclingKey, so
// an inverted virtualized list stops re-decoding on each mount and recycled rows
// don't flash the previous row's image.
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { viewerRouteFor } from '../../lib/docOpen';
import { exportToGalleryInBackground } from '../../lib/galleryExport';
import { useTheme } from '../../lib/theme';
import { shouldAutoDownloadNow } from '../../lib/mediaPrefs';
import { ProgressRing } from '../../components/ProgressRing';
import { getMedia, copyToCache } from '../../lib/mediaStore';
import { thumbDataUri } from '../../lib/thumbnails';
import { useConnectionState } from '../../lib/socket';
import { useS, ON_MEDIA_SCRIM } from './chatStyles';
import type { FillInks } from '../../lib/bubbleFillInk';
import { formatBytes, formatRecDuration } from './chatFormat';
import { chatActionErrorText } from './chatErrorText';

/** Where a nested control registers its handler for the bubble's a11y action. */
export type BubbleActionRef = MutableRefObject<(() => void) | null>;

// ─── File bubble (documents) ─────────────────────────────────
// Tap to download (FileSystem) and open with the OS share sheet
// (Sharing.shareAsync). The /uploads route is auth-gated so we pass
// the Bearer header on the download request.
export function FileBubble({
  attachmentId, filename, mime, size, authHeader, resolvedUri, isMine, thumb, pages, encrypted, actionRef, fillInk,
}: {
  attachmentId: string;
  filename:     string;
  mime:         string;
  size:         number;
  pages?:       number;   // PDF page count, counted by the sender
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
  thumb?:       string;   // PDF first-page preview (base64 jpeg)
  encrypted?:   boolean;  // meta.encrypted — see mediaStore.MediaKeyMissingError
  actionRef?:   BubbleActionRef;
  /** Inks for your bubble's custom colour (lib/bubbleFillInk); null on the theme fill. */
  fillInk?:     FillInks | null;
}) {
  const S = useS();
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const fileRouter = useRouter();
  // The data URI is a ~KB string built from base64; build it once per thumb,
  // not once per render.
  const thumbUri = useMemo(() => (thumb ? thumbDataUri(thumb) : null), [thumb]);

  // "1 page · 66 KB · PDF". Each part is dropped when it is not known, so a
  // non-PDF still reads exactly as it always did.
  const isPdf = /pdf/i.test(mime) || /[.]pdf$/i.test(filename);
  const subtitle = [
    pages ? `${pages} page${pages === 1 ? '' : 's'}` : null,
    formatBytes(size),
    isPdf ? 'PDF' : null,
  ].filter(Boolean).join(' · ');

  const onOpen = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Persistent local copy (downloaded once). Survives "Clear cache" AND the
      // server's post-delivery purge. Encrypted files arrive decrypted via
      // resolvedUri; everything else resolves through the persistent media store.
      // resolvedUri is the RENDER source and may legitimately be a REMOTE url
      // (attachmentUrl + auth headers, used by <Image>). Handing that to the
      // file layer below fails with "ENOENT ... https://…", because a URL is
      // not a path. Only take it when it is genuinely local; otherwise go
      // through getMedia, which downloads with the Authorization header and
      // returns a file:// path.
      const cached = resolvedUri?.uri;
      const localUri = cached && /^(file:\/\/|\/)/.test(cached)
        ? cached
        : await getMedia(attachmentId, { kind: 'file', isMine, mime, filename, encrypted });
      // Copy into the app cache so the OS FileProvider can hand the file to
      // another app (the provider is configured over the cache dir).
      const openUri = await copyToCache(localUri, filename || `file-${attachmentId}`);

      // Open IN-APP first, rather than throwing the file straight at the OS.
      //
      // This tap used to go directly to the system chooser, which meant the
      // in-app viewers were unreachable from a chat: an archive could only be
      // browsed from the Shelf, and text/code could only be read in another
      // app. Route by type instead, and let those screens hand off to the OS
      // when the device really is the better renderer (PDF, Office).
      // The two extension lists that used to sit here were one of THREE copies
      // of the same routing table (the others were in app/media-gallery.tsx and
      // app/media-viewer.tsx, and neither agreed with this one — .tsv and .ini
      // were missing here, and the gallery had no table at all). lib/docOpen.ts
      // is now the single copy, asserted by docOpen.selftest.ts.
      const route = viewerRouteFor(filename, mime);
      if (route === '/archive-viewer') {
        fileRouter.push({ pathname: '/archive-viewer', params: { uri: openUri, filename } });
        return;
      }
      if (route === '/file-viewer') {
        fileRouter.push({
          pathname: '/file-viewer',
          params: { uri: openUri, filename, mimeType: mime || '' },
        });
        return;
      }

      if (Platform.OS === 'android') {
        // WhatsApp-style: hand the file to the system "Open with" chooser so apps
        // that can VIEW this type open it (ACTION_VIEW), instead of a share sheet.
        try {
          const contentUri = await FileSystem.getContentUriAsync(openUri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
            type: mime || undefined,
          });
        } catch {
          // No app can open this type → offer to share/save instead.
          try {
            if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(openUri, { mimeType: mime, dialogTitle: filename });
            else Alert.alert('Can’t open file', 'No app on this device can open this file type.');
          } catch { Alert.alert('Can’t open file', 'No app on this device can open this file type.'); }
        }
      } else if (await Sharing.isAvailableAsync()) {
        // iOS has no ACTION_VIEW; its share/open-in sheet is the equivalent.
        await Sharing.shareAsync(openUri, { mimeType: mime, dialogTitle: filename });
      }
    } catch (e: unknown) {
      Alert.alert('Could not open file', chatActionErrorText(e, 'Try again'));
    } finally {
      setBusy(false);
    }
  }, [attachmentId, filename, mime, resolvedUri, busy, isMine, encrypted, fileRouter]);
  if (actionRef) actionRef.current = onOpen;
  const a11y = `Open ${filename}${subtitle ? `, ${subtitle}` : ''}`;

  // PDF with a page-1 preview → WhatsApp-style document card (preview on top,
  // filename row below). Other files → the plain icon + name row.
  if (thumbUri) {
    return (
      <TouchableOpacity style={S.fileCard} onPress={onOpen} activeOpacity={0.85} disabled={busy}
        accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ busy, disabled: busy }}>
        {/* data: URI — already in memory, nothing to fetch, so memory cache only. */}
        <ExpoImage source={{ uri: thumbUri }} style={S.filePreview} contentFit="cover" cachePolicy="memory" recyclingKey={attachmentId} />
        <View style={S.fileCardRow}>
          <View style={[S.fileIcon, isMine ? S.fileIconMine : S.fileIconTheirs]}>
            {busy ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Ionicons name="document-text" size={20} color={colors.onPrimary} />}
          </View>
          <View style={S.fileMeta}>
            <Text style={[S.fileName, isMine && S.fileNameMine, fillInk && { color: fillInk.text }]} numberOfLines={1}>{filename}</Text>
            <Text style={[S.fileSize, isMine && S.fileSizeMine, fillInk && { color: fillInk.meta }]}>{subtitle}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity style={S.fileRow} onPress={onOpen} activeOpacity={0.7} disabled={busy}
      accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ busy, disabled: busy }}>
      <View style={[S.fileIcon, isMine ? S.fileIconMine : S.fileIconTheirs]}>
        {busy ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Ionicons name="document-text" size={22} color={colors.onPrimary} />}
      </View>
      <View style={S.fileMeta}>
        <Text style={[S.fileName, isMine && S.fileNameMine, fillInk && { color: fillInk.text }]} numberOfLines={1}>{filename}</Text>
        <Text style={[S.fileSize, isMine && S.fileSizeMine, fillInk && { color: fillInk.meta }]}>{subtitle}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Audio bubble (voice messages) ───────────────────────────
// Tap to play / pause. Shows progress + remaining time. Streams the
// auth-gated /uploads endpoint with a Bearer header. Mono speaker icon
// stays bold while playing, otherwise dim.
export function AudioBubble({
  attachmentId, durationMs, waveform, resolvedUri, isMine, mime, encrypted, actionRef, fillInk,
}: {
  attachmentId: string;
  durationMs:   number;
  waveform?:    number[];
  authHeader:   string | null;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine:       boolean;
  mime?:        string;
  encrypted?:   boolean;  // meta.encrypted — see mediaStore.MediaKeyMissingError
  actionRef?:   BubbleActionRef;
  /** Inks for your bubble's custom colour (lib/bubbleFillInk); null on the theme fill. */
  fillInk?:     FillInks | null;
}) {
  const S = useS();
  const { colors } = useTheme();
  const [playing,  setPlaying]  = useState(false);
  const [position, setPosition] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Stop+unload when the bubble unmounts
  useEffect(() => {
    return () => {
      const s = soundRef.current;
      soundRef.current = null;
      if (s) { s.stopAsync().catch(() => {}); s.unloadAsync().catch(() => {}); }
    };
  }, []);

  const togglePlay = useCallback(async () => {
    try {
      if (playing) {
        await soundRef.current?.pauseAsync();
        setPlaying(false);
        return;
      }
      if (!soundRef.current) {
        // Play from the PERSISTENT local copy (download once). Survives "Clear
        // cache" and the server's post-delivery purge. Encrypted notes already
        // arrive as a local decrypted file via resolvedUri.
        let src: { uri: string } | null = resolvedUri ? { uri: resolvedUri.uri } : null;
        if (!src) { try { src = { uri: await getMedia(attachmentId, { kind: 'voice', isMine, mime, encrypted }) }; } catch { return; } }
        const { sound } = await Audio.Sound.createAsync(
          src,
          { shouldPlay: true, progressUpdateIntervalMillis: 150 },
          (status: any) => {
            if (!status?.isLoaded) return;
            setPosition(status.positionMillis || 0);
            if (status.didJustFinish) {
              setPlaying(false);
              setPosition(0);
              soundRef.current?.setPositionAsync(0).catch(() => {});
            }
          },
        );
        soundRef.current = sound;
        setPlaying(true);
      } else {
        await soundRef.current.playAsync();
        setPlaying(true);
      }
    } catch (e: unknown) {
      Alert.alert('Playback failed', chatActionErrorText(e, 'Try again'));
    }
  }, [attachmentId, resolvedUri, playing, isMine, mime, encrypted]);
  if (actionRef) actionRef.current = togglePlay;

  const totalSec = Math.max(1, Math.round(durationMs / 1000));
  const playedSec = Math.min(totalSec, Math.round(position / 1000));
  const remaining = totalSec - playedSec;
  const pct = totalSec ? Math.min(1, position / Math.max(1, durationMs)) : 0;

  return (
    <View style={S.audioRow}>
      <TouchableOpacity
        style={[S.audioPlayBtn, isMine ? S.audioPlayBtnMine : S.audioPlayBtnTheirs]}
        onPress={togglePlay}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}
      >
        <Ionicons name={playing ? 'pause' : 'play'} size={19} color={colors.onPrimary} style={playing ? undefined : { marginLeft: 2 }} />
      </TouchableOpacity>
      <View style={S.audioMeter}>
        {waveform && waveform.length > 0 ? (
          // Telegram-style bars. Each bar height is amplitude*MAX. Bars
          // up to playback position are filled; the rest are dimmed.
          <View style={S.waveBars}>
            {waveform.map((amp, i) => {
              const barPct = (i + 0.5) / waveform.length;
              const played = barPct <= pct;
              return (
                <View
                  key={i}
                  style={[
                    S.waveBar,
                    { height: Math.max(3, Math.min(1, amp) * 24) },
                    isMine
                      ? (played ? S.waveBarPlayedMine : S.waveBarUnplayedMine)
                      : (played ? S.waveBarPlayedTheirs : S.waveBarUnplayedTheirs),
                    fillInk && { backgroundColor: played ? fillInk.text : fillInk.track },
                  ]}
                />
              );
            })}
          </View>
        ) : (
          <View style={S.audioTrack}>
            <View style={[S.audioFill, { width: `${pct * 100}%` }, isMine && S.audioFillMine, fillInk && { backgroundColor: fillInk.text }]} />
          </View>
        )}
        <Text style={[S.audioTime, isMine && S.audioTimeMine, fillInk && { color: fillInk.meta }]}>
          {playing
            ? `${formatRecDuration(position)} / ${formatRecDuration(durationMs)}`
            : `🎙️ ${formatRecDuration(durationMs)}${remaining > 0 ? '' : ''}`}
        </Text>
      </View>
    </View>
  );
}

// ─── Image bubble ────────────────────────────────────────────
// Renders an image from the PERSISTENT on-device media folder (downloaded once
// via getAttachmentLocalUri). Survives "Clear cache" AND the server's
// post-delivery purge — only an uninstall removes it, like WhatsApp's media
// folder. Encrypted media arrives as an already-decrypted local file.
// Retry a failed media download the moment the network comes back (WhatsApp
// auto-download-on-reconnect). Fires only on an OFFLINE/CONNECTING → ONLINE edge.
function useRetryOnReconnect(eligible: boolean, retry: () => void) {
  const conn = useConnectionState();
  const prev = useRef(conn);
  useEffect(() => {
    if (prev.current !== 'ONLINE' && conn === 'ONLINE' && eligible) retry();
    prev.current = conn;
  }, [conn, eligible, retry]);
}

export function ImageAttachment({ attachmentId, resolvedUri, isMine, mime, thumb, encrypted, viewOnce, onError }: {
  attachmentId: string;
  resolvedUri?: { uri: string; headers?: Record<string, string> } | null;
  isMine?: boolean;
  mime?: string;
  thumb?: string;   // base64 JPEG shown instantly while the full image loads
  encrypted?: boolean;  // meta.encrypted — lets a missing key be reported as such
  /** Passed explicitly so a view-once photo can never reach the camera roll. */
  viewOnce?: boolean;
  onError?: () => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  const [uri, setUri] = useState<string | null>(resolvedUri?.uri ?? null);
  const [needTap, setNeedTap] = useState(false);    // gated by auto-download policy
  const [progress, setProgress] = useState<number | null>(null); // null=idle, 0-1=downloading
  // The bytes exist but this install has no key for them (typically: the media
  // predates a reinstall, which destroys both the per-file keys and the E2EE
  // identity). Distinct from a failed download — retrying can never fix it.
  const [keyMissing, setKeyMissing] = useState(false);
  // Built once per thumb instead of once per render (it is a ~KB base64 string).
  const thumbUri = useMemo(() => (thumb ? thumbDataUri(thumb) : null), [thumb]);
  // onError is an inline arrow from the bubble (new every render). Read it
  // through a ref so `download` stays stable and the load effect below can
  // depend on it without re-running — and re-downloading — on every render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Publish to the device gallery once the bytes are a real local file. Only
  // file:// — a remote URL is not ours to copy, and the export itself refuses
  // view-once media and honours the user's setting.
  useEffect(() => {
    if (uri && uri.startsWith('file://')) {
      exportToGalleryInBackground(uri, { kind: 'image', viewOnce, attachmentId });
    }
  }, [uri, viewOnce, attachmentId]);
  const download = useCallback(() => {
    setNeedTap(false);
    setProgress(0);
    getMedia(attachmentId, { kind: 'image', isMine, mime, encrypted, onProgress: setProgress })
      .then(u => { setUri(u || null); setProgress(null); })
      .catch((e: any) => {
        setProgress(null);
        if (e?.code === 'MEDIA_KEY_MISSING') { setKeyMissing(true); return; }
        onErrorRef.current?.();
      });
  }, [attachmentId, isMine, mime, encrypted]);
  useEffect(() => {
    if (resolvedUri?.uri) { setUri(resolvedUri.uri); return; }
    let cancel = false;
    (async () => {
      // Already cached? render instantly (no gating). Own media is always local.
      const local = await getMedia(attachmentId, { kind: 'image', isMine, mime, encrypted, cacheOnly: true }).catch(() => '');
      if (cancel) return;
      if (local) { setUri(local); return; }
      // Not cached → honor the media auto-download policy.
      const ok = !!isMine || await shouldAutoDownloadNow();
      if (cancel) return;
      if (ok) download();
      else setNeedTap(true);
    })();
    return () => { cancel = true; };
  }, [attachmentId, resolvedUri?.uri, isMine, mime, encrypted, download]);
  // Auto-download failed offline → retry as soon as we're back online. Never for
  // a missing key: the network was never the problem.
  useRetryOnReconnect(!uri && !keyMissing && progress == null && !needTap && !resolvedUri?.uri, download);
  if (!uri) {
    // No key on this device → say so, instead of showing a broken image (and
    // instead of writing ciphertext into the media folder under a .jpg name).
    if (keyMissing) {
      return (
        <View style={[S.attachedImage, S.imageError]}>
          <Ionicons name="lock-closed-outline" size={26} color={colors.textDim} />
          <Text style={S.mediaUnavailableTxt}>Not available on this device</Text>
        </View>
      );
    }
    // Downloading → blurred thumb + determinate progress ring.
    if (progress != null) {
      return (
        <View style={S.attachedImage}>
          {thumbUri ? <ExpoImage source={{ uri: thumbUri }} style={S.attachedImage} contentFit="cover" blurRadius={2} cachePolicy="memory" recyclingKey={attachmentId} /> : <View style={[S.attachedImage, S.imageError]} />}
          <View style={S.dlOverlay}><ProgressRing progress={progress} /></View>
        </View>
      );
    }
    // Auto-download skipped by policy → tap-to-download over the blurred thumb.
    if (needTap) {
      return (
        <TouchableOpacity activeOpacity={0.85} onPress={download} style={S.attachedImage}
          accessibilityRole="button" accessibilityLabel="Download photo">
          {thumbUri ? <ExpoImage source={{ uri: thumbUri }} style={S.attachedImage} contentFit="cover" blurRadius={3} cachePolicy="memory" recyclingKey={attachmentId} /> : <View style={[S.attachedImage, S.imageError]} />}
          <View style={S.dlOverlay}>
            <Ionicons name="arrow-down-circle" size={40} color={ON_MEDIA_SCRIM} />
            <Text style={S.dlOverlayTxt}>Download</Text>
          </View>
        </TouchableOpacity>
      );
    }
    // Instant low-res preview from the embedded thumbnail while the full image
    // downloads (WhatsApp-style progressive load).
    if (thumbUri) return <ExpoImage source={{ uri: thumbUri }} style={S.attachedImage} contentFit="cover" cachePolicy="memory" recyclingKey={attachmentId} />;
    return <View style={[S.attachedImage, S.imageError]}><ActivityIndicator color={colors.primary} /></View>;
  }
  return <ExpoImage source={{ uri }} style={S.attachedImage} contentFit="cover" cachePolicy="memory-disk" recyclingKey={attachmentId} onError={onError} />;
}

// ─── Video bubble ────────────────────────────────────────────
// Inline player using expo-av's <Video>. Tap = native controls, no
// autoplay. Streams the auth-gated /uploads endpoint via the Bearer
// header. onLoadError surfaces 410-Gone (view-once consumed) so the
// MessageBubble can flip to a "Viewed" tombstone without an extra
// HEAD round-trip.
export function VideoBubble({
  attachmentId, durationMs, authHeader, resolvedUri, onErrorOnce, isNote, onOpen, isMine, mime, thumb, encrypted, viewOnce,
}: {
  attachmentId:  string;
  durationMs:    number;
  authHeader:    string | null;
  resolvedUri?:  { uri: string; headers?: Record<string, string> } | null;
  onErrorOnce?:  () => void;
  isNote?:       boolean;   // round "video note" vs rectangular video
  onOpen?:       () => void; // open full-screen player
  isMine?:       boolean;
  mime?:         string;
  thumb?:        string;    // base64 JPEG poster (instant, no download)
  encrypted?:    boolean;   // meta.encrypted — see mediaStore.MediaKeyMissingError
  /** Passed explicitly so a view-once video can never reach the camera roll. */
  viewOnce?:     boolean;
}) {
  const S = useS();
  // WhatsApp-style: do NOT mount a <Video> (ExoPlayer) at rest — each instance
  // buffers the file in memory, and many bubbles at once OOM'd the app. We show
  // a lightweight placeholder + play button. Regular videos open the full-screen
  // player on tap (one player at a time). Video notes lazily download then play
  // inline in the round bubble — so at most ONE <Video> is ever alive.
  const [playing, setPlaying] = useState(false);
  const [noteUri, setNoteUri] = useState<string | null>(resolvedUri?.uri ?? null);
  // Same rule as the image bubble: publish only real local files, never a
  // view-once video, and only when the user's setting allows it.
  useEffect(() => {
    if (noteUri && noteUri.startsWith('file://')) {
      exportToGalleryInBackground(noteUri, { kind: 'video', viewOnce, attachmentId });
    }
  }, [noteUri, viewOnce, attachmentId]);
  const [busy, setBusy] = useState(false);
  // Built once per thumb instead of once per render (it is a ~KB base64 string).
  const thumbUri = useMemo(() => (thumb ? thumbDataUri(thumb) : null), [thumb]);

  const onTap = useCallback(async () => {
    if (!isNote) { onOpen?.(); return; }
    if (playing) { setPlaying(false); return; }
    let uri = noteUri;
    if (!uri) {
      setBusy(true);
      try { uri = resolvedUri?.uri ?? await getMedia(attachmentId, { kind: 'video', isMine, mime, encrypted }); setNoteUri(uri); }
      catch { onErrorOnce?.(); setBusy(false); return; }
      setBusy(false);
    }
    setPlaying(true);
  }, [isNote, playing, noteUri, resolvedUri?.uri, attachmentId, onOpen, onErrorOnce, isMine, mime, encrypted]);

  const showingVideo = isNote && playing && !!noteUri;
  return (
    <TouchableOpacity
      style={isNote ? S.videoNoteWrap : S.videoWrap}
      activeOpacity={0.9}
      onPress={onTap}
      accessibilityRole="button"
      accessibilityLabel={`${showingVideo ? 'Stop' : 'Play'} ${isNote ? 'video note' : 'video'}${durationMs > 0 ? `, ${formatRecDuration(durationMs)}` : ''}`}
      accessibilityState={{ busy }}
    >
      {showingVideo ? (
        <Video
          source={{ uri: noteUri! }}
          style={S.videoNoteView}
          useNativeControls={false}
          resizeMode={ResizeMode.COVER}
          isLooping={false}
          shouldPlay
          onPlaybackStatusUpdate={(st: any) => { if (st?.didJustFinish) setPlaying(false); }}
          onError={() => { setPlaying(false); onErrorOnce?.(); }}
        />
      ) : thumbUri ? (
        <ExpoImage source={{ uri: thumbUri }} style={isNote ? S.videoNoteView : S.videoView} contentFit="cover" cachePolicy="memory" recyclingKey={attachmentId} />
      ) : (
        <View style={[isNote ? S.videoNoteView : S.videoView, S.videoPlaceholder]}>
          {/* The plate is always dark (videoPlaceholder), so the glyph is a fixed dim white. */}
          <Ionicons name="videocam" size={34} color="rgba(255,255,255,0.4)" />
        </View>
      )}
      {!showingVideo && (
        <View style={S.videoPlayOverlay} pointerEvents="none">
          <View style={S.videoPlayBtn}>
            {busy ? <ActivityIndicator color={ON_MEDIA_SCRIM} /> : <Ionicons name="play" size={26} color={ON_MEDIA_SCRIM} style={{ marginLeft: 3 }} />}
          </View>
        </View>
      )}
      {durationMs > 0 && !showingVideo && (
        <Text style={[S.videoDuration, isNote && S.videoNoteDuration]}>{formatRecDuration(durationMs)}</Text>
      )}
    </TouchableOpacity>
  );
}
