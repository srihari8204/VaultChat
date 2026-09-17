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
import { initialOf } from '../lib/format';
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
import { unwrapStoryKey, unwrapPayload } from '../lib/storyKeys';
import GateChallenge from '../components/status/GateChallenge';
import { peekStoryFeed, putStoryFeed } from '../lib/storyFeedCache';
import { unlockKeyWithAnswer } from '../lib/status/gateKey';
import { puzzleFrameUri } from '../lib/status/puzzleFrame';

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
      // PAINT FROM THE CACHE FIRST, THEN REVALIDATE.
      //
      // The list screen fetched this feed to draw the row that was just
      // tapped. Re-fetching it here put a full round trip (~1s against prod)
      // in front of every open, before the wrapped key or the media could even
      // be requested — and those are two more round trips behind it.
      //
      // Safe because nothing here is an access decision: the media still needs
      // its wrapped key from the server, and a gate is still enforced by that
      // key. The worst a stale entry does is show a story that has since been
      // deleted, which the revalidation below corrects.
      const seed = await peekStoryFeed();
      if (cancel) return;
      const apply = (feed: StoryFeedEntry[], first: boolean) => {
        const match = feed.find(e => e.userId === userId);
        if (!match) {
          // Only the authoritative answer may declare there is nothing here.
          // A cache miss just means "wait for the network".
          if (!first) setError('No active stories from this user');
          return;
        }
        setEntry(prev => {
          // Do not let the revalidation reshuffle a story someone is already
          // looking at; only adopt it if the set actually changed.
          if (prev && prev.stories.length === match.stories.length
              && prev.stories.every((s, i) => s.id === match.stories[i].id)) return prev;
          return match;
        });
        if (first) {
          // Start at the first unseen story (matches Instagram/WhatsApp UX);
          // if all seen, start at 0. Only on the FIRST apply — moving the
          // index under a viewer mid-read would be worse than a stale one.
          const firstUnseen = match.stories.findIndex(s => !s.seen);
          setIndex(firstUnseen >= 0 ? firstUnseen : 0);
        }
      };
      if (seed) apply(seed, true);

      try {
        const [feed, tok] = await Promise.all([listStoriesFeed(), getAccessToken()]);
        if (cancel) return;
        putStoryFeed(feed);
        apply(feed, !seed);
        setAuthHeader(tok ? `Bearer ${tok}` : null);
      } catch (e: any) {
        // With a cached entry already on screen there is something to look at,
        // so a failed revalidation must not replace it with an error.
        if (!cancel && !seed) setError(e?.message ?? 'Failed to load');
      }
    })();
    return () => { cancel = true; };
  }, [userId]);

  const current = entry?.stories[index] ?? null;

  // Which story ids this viewer has already cleared, for this session only.
  // Deliberately NOT persisted: a puzzle re-solved on the next open costs a few
  // taps, whereas a persisted "cleared" flag would be a second, weaker copy of
  // an access decision that the key already makes correctly.
  const [lockedEnvelope, setLockedEnvelope] = useState<string | null>(null);
  // A still for the puzzle. For a video this is an extracted frame, so the
  // board is not asked to cut up something that cannot be drawn.
  const [puzzleUri, setPuzzleUri] = useState<string | null>(null);
  // Whether the frame attempt has FINISHED. Distinct from `puzzleUri === null`,
  // which cannot tell "still decrypting" from "no frame possible" — and the
  // gate falls back to a plain Open button on the latter. Without this the
  // fallback is shown during every decrypt, so a fast tap skips the puzzle.
  const [puzzleTried, setPuzzleTried] = useState(false);
  const [passed, setPassed] = useState<Set<string>>(new Set());
  const clear = useCallback((id: string) => setPassed(p => new Set(p).add(id)), []);

  // The poster is never challenged: they hold the raw key locally from posting,
  // so their own status opens straight away.
  const gated = !!current && !!current.gateKind && !entry?.isMine && !passed.has(current.id);

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
            if (current.gateKind === 'question') {
              // The wrapped payload here is the ANSWER-LOCKED envelope, not the
              // key — so it cannot be turned into media until the viewer
              // answers. Stash it and let GateChallenge do the unlocking.
              const raw = await unwrapPayload(entry.userId, wrapped);
              if (!raw) return;
              if (!cancel) setLockedEnvelope(raw);
              return;                                           // nothing to render yet
            }
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
    // `gated` is a dependency because clearing the gate is what makes the media
    // fetchable: a correct answer calls putMediaKey and this effect must run
    // AGAIN to pick the key up. Without it the story unlocks and then shows
    // nothing — the worst possible outcome for someone who answered correctly.
  }, [current?.id, current?.encrypted, current?.attachmentId, entry?.userId, authHeader, gated]);

  // Extract the puzzle still only when a puzzle is actually pending. Doing it
  // for every story would pay a decode on clips nobody is asked to solve.
  useEffect(() => {
    let cancel = false;
    setPuzzleUri(null);
    setPuzzleTried(false);
    if (!gated || !current || current.gateKind !== 'puzzle') return;
    if (!mediaSrc?.uri) {
      // Media is still decrypting. Stay PENDING rather than falling through to
      // the Open button — but not forever: if the key never arrives (not in the
      // audience) bound the wait, matching the 12s media-stall timer below, so
      // the viewer gets a way out instead of an endless spinner.
      const t = setTimeout(() => { if (!cancel) setPuzzleTried(true); }, 12000);
      return () => { cancel = true; clearTimeout(t); };
    }
    (async () => {
      const uri = await puzzleFrameUri(mediaSrc.uri, current.mediaType);
      if (!cancel) { setPuzzleUri(uri); setPuzzleTried(true); }
    })();
    return () => { cancel = true; };
  }, [gated, current?.id, current?.gateKind, current?.mediaType, mediaSrc?.uri]);

  // ── Prefetch ONE story ahead ────────────────────────────────────────
  //
  // Advancing costs the same two round trips the first open does — the
  // wrapped key, then the media — and pays them only once the person has
  // already tapped, so the wait is fully visible. Fetching the next story
  // while the current one is on screen moves that cost into time that is
  // already being spent looking at something.
  //
  // Deliberately ONE ahead, not all: a poster may have ten statuses and most
  // viewers stop after the first few. Downloading all of them would spend a
  // viewer's mobile data on media they will never open.
  //
  // Starts only once the CURRENT story has rendered (`loaded`), so the
  // prefetch never competes for bandwidth with the thing being waited on.
  useEffect(() => {
    if (!entry || !loaded) return;
    const next = entry.stories[index + 1];
    if (!next || next.mediaType === 'text' || !next.attachmentId) return;
    // A question gate's payload is the answer-locked envelope, not a usable
    // key — there is nothing to warm, and fetching it would neither help nor
    // weaken the lock.
    if (next.gateKind === 'question') return;

    let cancel = false;
    (async () => {
      try {
        if (!(await getMediaKey(next.attachmentId).catch(() => null))) {
          const wrapped = await getStoryKey(next.id);
          if (cancel || !wrapped) return;
          const mk = await unwrapStoryKey(entry.userId, wrapped);
          if (cancel || !mk) return;
          await putMediaKey(next.attachmentId, mk);
        }
        if (cancel) return;
        await getAttachmentLocalUri(next.attachmentId);   // downloads + decrypts into the media cache
      } catch { /* best effort: a failed prefetch just means the normal path pays for it */ }
    })();
    return () => { cancel = true; };
  }, [entry?.userId, entry?.stories.length, index, loaded]);

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
    // `gated` stops the clock. The media-stall safety timer sets `loaded` even
    // though nothing rendered, so without this the progress bar runs down and
    // advance(+1) walks off a puzzle the viewer is halfway through solving.
    if (!current || paused || !loaded || gated) return;

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
  }, [current?.id, paused, loaded, mediaSrc, gated]);

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
      // statusbar-exempt: a story is full-bleed media on #000 at every theme, so light glyphs are correct here regardless of the palette.
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

  // THE GATE COVERS THE MEDIA, NOT THE WHOLE VIEWER.
  //
  // It used to be an early `return <GateChallenge/>`, which replaced
  // everything — including the progress segments that say how many stories
  // this person posted, and the taps that move between them. One gated story
  // therefore hid every OTHER story behind it: a poster with three statuses
  // looked like a poster with one, and there was no way through but to solve
  // it or leave.
  //
  // The security property is unchanged and load-bearing: while `gated`, the
  // media is NOT rendered at all (see the `!gated &&` guards below), so
  // nothing is decrypted and drawn underneath for a screenshot to catch. Only
  // the chrome — progress bars, author, close — is allowed above it.
  return (
    <View style={S.screen}>
      <StatusBar barStyle="light-content" />

      {/* Text status — full-bleed colored card with centered text (WhatsApp). */}
      {!gated && current?.mediaType === 'text' && (
        <View style={[S.media, { backgroundColor: (current as any).bgColor || '#0B0B10', alignItems: 'center', justifyContent: 'center', padding: 32 }]}>
          <Text style={{ color: '#fff', fontSize: 28, fontWeight: '700', textAlign: 'center' }}>{(current as any).text || ''}</Text>
        </View>
      )}

      {/* Media — full-bleed. Plaintext: authed URL; encrypted: decrypted local file. */}
      {!gated && mediaSrc && current?.mediaType !== 'text' && (
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
      {!gated && current?.mediaType !== 'text' && !loaded && (
        <View style={[S.media, { alignItems: 'center', justifyContent: 'center' }]} pointerEvents="none">
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}

      {/* The gate, in place of the media. Sits BELOW the top bar in z-order so
          the progress segments and close button stay reachable. */}
      {gated && current && (
        <View style={S.gateLayer}>
          <GateChallenge
            kind={current.gateKind as 'puzzle' | 'question'}
            grid={current.gateGrid ?? undefined}
            previewUri={puzzleUri ?? undefined}
            previewPending={current.gateKind === 'puzzle' && !puzzleUri && !puzzleTried}
            prompt={current.gatePrompt ?? undefined}
            accent={colors.primary}
            onDismiss={close}
            onSolved={() => clear(current.id)}
            onAnswer={async (ans) => {
              if (!lockedEnvelope || !current.gateSalt) return false;
              let locked: any;
              try { locked = JSON.parse(lockedEnvelope); } catch { return false; }
              const mk = await unlockKeyWithAnswer(
                { salt: locked.salt ?? current.gateSalt, envelope: locked.envelope },
                ans,
              );
              if (!mk) return false;   // a wrong answer and a tampered envelope look identical, by design
              await putMediaKey(current.attachmentId, mk);
              return true;
            }}
          />
        </View>
      )}

      {/* Tap zones (under everything visible). Withheld while gated: they would
          swallow the taps the puzzle board needs to receive. */}
      {!gated && (
        <>
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
        </>
      )}

      {/* Top: per-story progress bars + author + close */}
      <View style={S.topBar} pointerEvents="box-none">
        {/* One segment per story — this is what tells a viewer the person
            posted more than one. The segments are TAPPABLE because while a
            story is gated the tap zones are withheld, and without this a
            locked story would be a dead end with no route to the others. */}
        <View style={S.progressRow} pointerEvents="box-none">
          {entry.stories.map((s, i) => (
            <Pressable
              key={s.id}
              style={S.progressTrack}
              onPress={() => setIndex(i)}
              hitSlop={{ top: 12, bottom: 12, left: 2, right: 2 }}
            >
              <Animated.View
                style={[
                  S.progressFill,
                  i < index  && { width: '100%' },
                  i === index && { width: progressW },
                  i > index  && { width: '0%' },
                ]}
              />
            </Pressable>
          ))}
        </View>
        <View style={S.authorRow}>
          <Text style={S.authorName} numberOfLines={1}>
            {userName || entry.name || entry.email || ''}
          </Text>
          <Text style={S.authorTime}>{formatAgo(current.createdAt)}</Text>
          <View style={{ flex: 1 }} />
          {isMyStory && (
            <TouchableOpacity onPress={openViewers} hitSlop={8} style={S.iconBtn} accessibilityLabel="Who has seen this">
              <Ionicons name="eye-outline" size={20} color={colors.text} />
            </TouchableOpacity>
          )}
          {isMyStory && (
            <TouchableOpacity onPress={onDelete} hitSlop={8} style={S.iconBtn} accessibilityLabel="Delete status">
              <Ionicons name="trash-outline" size={20} color="#FCA5A5" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={close} hitSlop={8} style={S.iconBtn} accessibilityLabel="Close">
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
                      {initialOf(v.name, v.email)}
                    </Text>
                  )}
                </View>
                <Text style={S.viewerName} numberOfLines={1}>
                  {v.name || v.email || v.userId.slice(0, 8)}
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

  // Full-bleed, but BELOW topBar in z-order (declared earlier in the tree), so
  // the progress segments and close button stay reachable over a locked story.
  gateLayer:     { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
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
