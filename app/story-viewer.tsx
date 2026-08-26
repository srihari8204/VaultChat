// app/story-viewer.tsx — Fullscreen story viewer (Phase 3a MVP).
//
// Receives ?userId in route params, fetches the active-story bucket for
// that author from /stories/feed, then renders one story at a time with:
//   * A top progress bar per story (auto-advances every IMAGE_MS / VIDEO_MS)
//   * Tap-left  → previous story
//   * Tap-right → next story (or close if at the last)
//   * Long-press → pause auto-advance (release to resume)
//   * Author + relative time at top-left
//   * Caption overlay at bottom
//   * For my own stories: a 👁️ button → /stories/:id/views (viewer list)
//
// View tracking: as each story flips active, we POST /stories/:id/viewed
// (server is idempotent + treats author-as-viewer as no-op).

import { Ionicons } from '@expo/vector-icons';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ResizeMode, Video } from 'expo-av';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { getAccessToken } from '../lib/api';
import {
  attachmentUrl,
  deleteStory,
  getStoryKey,
  listStoriesFeed,
  listStoryViews,
  markStoryViewed,
  type StoryFeedEntry,
  type StoryViewer,
} from '../lib/chatService';
import { getDecryptedAttachmentUri, getAttachmentLocalUri } from '../lib/mediaAttachments';
import { putMediaKey, getMediaKey } from '../lib/mediaKeyStore';
import { unwrapStoryKey } from '../lib/storyKeys';

const IMAGE_DURATION_MS = 5_000;
const VIDEO_DURATION_MS = 15_000;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

function StoryViewerScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { userId, userName } = useLocalSearchParams<{ userId?: string; userName?: string }>();

  const [entry,      setEntry]      = useState<StoryFeedEntry | null>(null);
  const [index,      setIndex]      = useState(0);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [paused,     setPaused]     = useState(false);
  const [loaded,     setLoaded]     = useState(false);   // media actually rendered?
  const [error,      setError]      = useState<string | null>(null);

  // Progress bar animation per active story. Re-runs on `index` change.
  const progress = useRef(new Animated.Value(0)).current;

  // ── Initial load ──────────────────────────────────────────
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [feed, tok] = await Promise.all([listStoriesFeed(), getAccessToken()]);
        if (cancel) return;
        const match = feed.find(e => e.userId === userId);
        if (!match) {
          setError('No active stories from this user');
          return;
        }
        // Start at the first unseen story (matches Instagram/WhatsApp UX);
        // if all seen, start at 0.
        const firstUnseen = match.stories.findIndex(s => !s.seen);
        setIndex(firstUnseen >= 0 ? firstUnseen : 0);
        setEntry(match);
        setAuthHeader(tok ? `Bearer ${tok}` : null);
      } catch (e: any) {
        if (!cancel) setError(e?.message ?? 'Failed to load');
      }
    })();
    return () => { cancel = true; };
  }, [userId]);

  const current = entry?.stories[index] ?? null;

  // W7: resolve the renderable media source for the active story. Encrypted
  // stories fetch this viewer's wrapped key, unwrap it to the content key, and
  // decrypt the media to a local file. Plaintext stories use the auth'd URL.
  const [mediaSrc, setMediaSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);
  useEffect(() => {
    let cancel = false;
    setMediaSrc(null);
    if (!current) return;
    if (current.mediaType === 'text') return;   // text status has no attachment
    (async () => {
      if (current.encrypted) {
        try {
          // Fast path: we already hold the content key locally (our OWN story, or
          // a previously-unwrapped one) → decrypt directly, no wrapped-key fetch.
          const haveKey = await getMediaKey(current.attachmentId).catch(() => null);
          if (!haveKey) {
            const wrapped = await getStoryKey(current.id);
            if (!wrapped || !entry) return;                     // not in audience → leave blank
            const mk = await unwrapStoryKey(entry.userId, wrapped);
            if (!mk) return;
            await putMediaKey(current.attachmentId, mk);        // feed the standard media-decrypt path
          }
          const r = await getDecryptedAttachmentUri(current.attachmentId);
          if (!cancel) setMediaSrc(r);
        } catch { /* leave blank on failure */ }
      } else {
        // Both images AND video: download to a local file (self-authenticated)
        // and render file:// — reliable. The old image path used a raw remote
        // URL gated on authHeader, which left a black screen when the token was
        // slow or the Image's onLoad never fired.
        try {
          const uri = await getAttachmentLocalUri(current.attachmentId);
          if (!cancel) setMediaSrc({ uri });
        } catch { if (!cancel) setLoaded(true); /* let the timer advance past a failed story */ }
      }
    })();
    return () => { cancel = true; };
  }, [current?.id, current?.encrypted, current?.attachmentId, entry?.userId, authHeader]);

  // Reset the "loaded" gate whenever the current story changes. Text stories
  // have no media to wait for, so they're ready immediately.
  useEffect(() => {
    setLoaded(current?.mediaType === 'text');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Safety: if the media stalls (slow network), don't sit on a blank screen
  // forever — treat it as loaded after a max wait so the timer can run/advance.
  useEffect(() => {
    if (!current || loaded) return;
    const t = setTimeout(() => setLoaded(true), 12000);
    return () => clearTimeout(t);
  }, [current?.id, loaded]);

  // ── Per-story side effects: mark viewed, run progress, auto-advance.
  // The progress timer only starts once the media has actually loaded, so the
  // bar no longer empties out over a blank screen while the image/video loads.
  useEffect(() => {
    if (!current || paused || !loaded) return;

    // Best-effort mark-viewed; server is idempotent. Do NOT mark a media story
    // viewed if its media never actually resolved (decrypt/download failed) —
    // otherwise a blank story gets silently marked seen and can't be retried.
    if (!current.seen && (current.mediaType === 'text' || mediaSrc)) {
      markStoryViewed(current.id).catch(() => {});
    }

    progress.setValue(0);
    const anim = Animated.timing(progress, {
      toValue:  1,
      duration: current.mediaType === 'video' ? VIDEO_DURATION_MS : IMAGE_DURATION_MS,
      useNativeDriver: false,
    });
    anim.start(({ finished }) => {
      if (finished) advance(+1);
    });
    return () => anim.stop();
  // intentional: re-runs when *index* changes, on pause/resume, once loaded, or
  // when the media source resolves (so mark-viewed sees a non-null mediaSrc).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, paused, loaded, mediaSrc]);

  const close = useCallback(() => router.back(), [router]);

  const advance = useCallback((step: 1 | -1) => {
    if (!entry) return;
    const next = index + step;
    if (next < 0) return;               // already at first; ignore back-tap
    if (next >= entry.stories.length) { close(); return; }
    setIndex(next);
  }, [entry, index, close]);

  // Tap-zones: left third = back, right two-thirds = forward.
  const onTapZone = useCallback((side: 'left' | 'right') => {
    advance(side === 'left' ? -1 : +1);
  }, [advance]);

  // Author bar: show "👁️ N views" for my own stories, tap → viewer list.
  const isMyStory = entry?.isMine && current;
  const [viewers,     setViewers]     = useState<StoryViewer[] | null>(null);
  const [viewersOpen, setViewersOpen] = useState(false);
  const openViewers = useCallback(async () => {
    if (!current) return;
    setPaused(true);
    setViewersOpen(true);
    try {
      const v = await listStoryViews(current.id);
      setViewers(v);
    } catch (e: any) {
      Alert.alert('Could not load viewers', e?.message ?? 'Try again');
    }
  }, [current]);
  const closeViewers = useCallback(() => {
    setViewersOpen(false);
    setViewers(null);
    setPaused(false);
  }, []);

  const onDelete = useCallback(() => {
    if (!current) return;
    Alert.alert(
      'Delete this story?',
      'It will be removed immediately for everyone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: async () => {
            try {
              await deleteStory(current.id);
              // Local remove + advance, or close if it was the only one
              const next = entry!.stories.filter(s => s.id !== current.id);
              if (next.length === 0) { close(); return; }
              setEntry({ ...entry!, stories: next });
              setIndex(Math.min(index, next.length - 1));
            } catch (e: any) {
              Alert.alert('Delete failed', e?.message ?? 'Try again');
            }
          }
        },
      ],
    );
  }, [current, entry, index, close]);

  const progressW = useMemo(() => progress.interpolate({
    inputRange: [0, 1], outputRange: ['0%', '100%'],
  }), [progress]);

  if (error) {
    return (
      <View style={[S.screen, S.center]}>
        <StatusBar barStyle="light-content" />
        <Text style={S.errorTxt}>{error}</Text>
        <TouchableOpacity onPress={close} style={S.closeBtn}>
          <Text style={S.closeBtnTxt}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!entry || !current) {
    return (
      <View style={[S.screen, S.center]}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      {/* Text status — full-bleed colored card with centered text (WhatsApp). */}
      {current?.mediaType === 'text' && (
        <View style={[S.media, { backgroundColor: (current as any).bgColor || '#0B0B10', alignItems: 'center', justifyContent: 'center', padding: 32 }]}>
          <Text style={{ color: '#fff', fontSize: 28, fontWeight: '700', textAlign: 'center' }}>{(current as any).text || ''}</Text>
        </View>
      )}

      {/* Media — full-bleed. Plaintext: authed URL; encrypted: decrypted local file. */}
      {mediaSrc && current?.mediaType !== 'text' && (
        current?.mediaType === 'video' ? (
          <Video
            source={mediaSrc as any}
            style={S.media}
            resizeMode={ResizeMode.CONTAIN}
            shouldPlay={!paused && loaded}
            isLooping={false}
            useNativeControls={false}
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(true)}
          />
        ) : (
          <Image
            source={mediaSrc}
            style={S.media}
            resizeMode="contain"
            onLoad={() => setLoaded(true)}
            onError={() => setLoaded(true)}
          />
        )
      )}

      {/* Spinner while the media (or its decrypt/download) is still loading. */}
      {current?.mediaType !== 'text' && !loaded && (
        <View style={[S.media, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}

      {/* Tap zones (under everything visible) */}
      <Pressable
        style={[S.tapZone, S.tapLeft]}
        onPress={() => onTapZone('left')}
        onLongPress={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
      />
      <Pressable
        style={[S.tapZone, S.tapRight]}
        onPress={() => onTapZone('right')}
        onLongPress={() => setPaused(true)}
        onPressOut={() => setPaused(false)}
      />

      {/* Top: per-story progress bars + author + close */}
      <View style={S.topBar} pointerEvents="box-none">
        <View style={S.progressRow} pointerEvents="none">
          {entry.stories.map((s, i) => (
            <View key={s.id} style={S.progressTrack}>
              <Animated.View
                style={[
                  S.progressFill,
                  i < index  && { width: '100%' },
                  i === index && { width: progressW },
                  i > index  && { width: '0%' },
                ]}
              />
            </View>
          ))}
        </View>
        <View style={S.authorRow}>
          <Text style={S.authorName} numberOfLines={1}>
            {userName || entry.name || entry.email || ''}
          </Text>
          <Text style={S.authorTime}>{formatAgo(current.createdAt)}</Text>
          <View style={{ flex: 1 }} />
          {isMyStory && (
            <TouchableOpacity onPress={openViewers} hitSlop={8} style={S.iconBtn}>
              <Ionicons name="eye-outline" size={20} color={colors.text} />
            </TouchableOpacity>
          )}
          {isMyStory && (
            <TouchableOpacity onPress={onDelete} hitSlop={8} style={S.iconBtn}>
              <Ionicons name="trash-outline" size={20} color="#FCA5A5" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={close} hitSlop={8} style={S.iconBtn}>
            <Ionicons name="close" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Bottom: caption */}
      {current.caption && (
        <View style={S.captionBar} pointerEvents="none">
          <Text style={S.captionTxt} numberOfLines={3}>{current.caption}</Text>
        </View>
      )}

      {/* Viewers sheet */}
      {viewersOpen && (
        <Pressable style={S.viewersBackdrop} onPress={closeViewers}>
          <Pressable style={S.viewersSheet} onPress={(e) => e.stopPropagation()}>
            <Text style={S.viewersTitle}>
              {viewers ? `${viewers.length} ${viewers.length === 1 ? 'viewer' : 'viewers'}` : 'Loading…'}
            </Text>
            {viewers === null ? (
              <ActivityIndicator color="#fff" style={{ marginTop: 24 }} />
            ) : viewers.length === 0 ? (
              <Text style={S.viewersEmpty}>No one has viewed this yet.</Text>
            ) : viewers.map(v => (
              <View key={v.userId} style={S.viewerRow}>
                <View style={S.viewerAvatar}>
                  {v.photoURL && authHeader ? (
                    <Image
                      source={{ uri: attachmentUrl(v.photoURL), headers: { Authorization: authHeader } }}
                      style={S.viewerAvatarImg}
                    />
                  ) : (
                    <Text style={S.viewerAvatarTxt}>
                      {(v.name ?? v.email ?? '?').trim()[0].toUpperCase()}
                    </Text>
                  )}
                </View>
                <Text style={S.viewerName} numberOfLines={1}>
                  {v.name ?? v.email ?? v.userId.slice(0, 8)}
                </Text>
                <Text style={S.viewerWhen}>{formatAgo(v.viewedAt)}</Text>
              </View>
            ))}
          </Pressable>
        </Pressable>
      )}
    </View>
  );
}

function formatAgo(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)    return 'just now';
    if (diff < 3600_000)  return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
    return `${Math.floor(diff / 86400_000)}d`;
  } catch { return ''; }
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:        { flex: 1, backgroundColor: c.bg },
  center:        { justifyContent: 'center', alignItems: 'center' },

  media:         { ...StyleSheet.absoluteFillObject },

  tapZone:       { position: 'absolute', top: 0, bottom: 0, width: '40%' },
  tapLeft:       { left: 0 },
  tapRight:      { right: 0, width: '60%' },

  topBar:        { position: 'absolute', top: 56, left: 12, right: 12, gap: 8 },
  progressRow:   { flexDirection: 'row', gap: 3 },
  progressTrack: { flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 1, overflow: 'hidden' },
  progressFill:  { height: 2, backgroundColor: '#fff', borderRadius: 1 },
  authorRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  authorName:    { color: c.text, fontSize: 15, fontWeight: '700' },
  authorTime:    { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  iconBtn:       { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  iconBtnTxt:    { color: c.text, fontSize: 18 },

  captionBar:    { position: 'absolute', left: 16, right: 16, bottom: 40, backgroundColor: 'rgba(0,0,0,0.55)', padding: 12, borderRadius: 12 },
  captionTxt:    { color: c.text, fontSize: 14, lineHeight: 20 },

  errorTxt:      { color: c.text, fontSize: 14, marginBottom: 16 },
  closeBtn:      { backgroundColor: '#fff', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20 },
  closeBtnTxt:   { color: '#000', fontWeight: '700' },

  viewersBackdrop:  { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  viewersSheet:     { backgroundColor: '#161A22', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 32, maxHeight: '70%' },
  viewersTitle:     { color: c.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
  viewersEmpty:     { color: c.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  viewerRow:        { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  viewerAvatar:     { width: 36, height: 36, borderRadius: 18, backgroundColor: '#6C63FF', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  viewerAvatarImg:  { width: '100%', height: '100%' },
  viewerAvatarTxt:  { color: c.text, fontWeight: '700' },
  viewerName:       { color: c.text, fontSize: 14, flex: 1 },
  viewerWhen:       { color: c.textDim, fontSize: 11 },
});

// A render fault in a viewer used to take the WHOLE app down: these screens
// render untrusted, arbitrary media (a truncated video, a malformed PDF, an
// office file with a codec this device lacks) and none of them were wrapped.
// The boundary turns that crash into a dismissable screen with the chat intact.
export default function StoryViewerScreenBoundary() {
  return (
    <ErrorBoundary screen="StoryViewerScreen" fallbackTitle="Story Viewer Error" fallbackMessage="This story could not be displayed.">
      <StoryViewerScreen />
    </ErrorBoundary>
  );
}
