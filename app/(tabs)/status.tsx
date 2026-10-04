// app/(tabs)/status.tsx — Stories feed (Postgres, Phase 3a MVP).
//
// Layout:
//   ┌────────────────────────────────────────────────┐
//   │  Status                                  +     │  (header)
//   ├────────────────────────────────────────────────┤
//   │  ◉ My status      (or "Add to my story…")     │  always at top
//   ├────────────────────────────────────────────────┤
//   │  Recent updates                                │
//   │  ◉ Alice — 2h ago    (unseen — purple ring)   │
//   │  ◯ Bob   — 5h ago    (all seen — grey ring)   │
//   └────────────────────────────────────────────────┘
//
// Tap any row → /story-viewer with all of that author's active stories.
// Tap "Add to my story" → image picker → /uploads → POST /stories.
//
// Visibility / TTL / per-viewer tracking happens server-side. This screen
// just renders + posts.

import { useAuthHeader } from '../../hooks/useAuthHeader';
import { AppText as Text } from '../../components/ui/Text';
import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import * as ImagePicker from 'expo-image-picker';
import { compressForStatus } from '../../lib/media/compressMedia';
import { type GateDraft } from '../../components/status/GatePicker';
import TextStatusComposer from '../../components/status/TextStatusComposer';
import MediaStatusPreview, { type PreviewAsset } from '../../components/status/MediaStatusPreview';
import { puzzleFrameUri } from '../../lib/status/puzzleFrame';
import { putStoryFeed, FEED_CACHE_KEY } from '../../lib/storyFeedCache';
import { lockKeyWithAnswer } from '../../lib/status/gateKey';
import { wrapPayloadForViewers, wrapStoryKeyForViewers } from '../../lib/storyKeys';
import { isAcceptableAnswer } from '../../lib/status/gate';
import { type StoryGate as StoryGateOut, addStory, addEncryptedStory, getStoryAudience, attachmentUrl, listStoriesFeed, postTextStory, uploadAttachment, type StoryFeedEntry } from '../../lib/chatService';

import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { StoryRing } from '../../components/StoryRing';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { useVisionComfort } from '../../lib/visionComfort';
import { initialOf } from '../../lib/format';
import { getSocket } from '../../lib/socket';
import { STORY_E2EE, E2EE_ENABLED } from '../../constants/flags';
import { uploadEncryptedAttachment } from '../../lib/mediaAttachments';
import { putMediaKey } from '../../lib/mediaKeyStore';
import { AuroraBackground } from '../../components/ui';
import { permissionDenied } from '../../lib/permissionDenied';
import { userErrorText } from '../../lib/userErrorText';
import { TEXT_STORY_SWATCHES } from '../../constants/storyPalette';

/** The gate for an UNENCRYPTED story. A question gate is impossible here — with
 *  no content key to lock there is nothing for the answer to protect, so it
 *  would be a prompt with no lock behind it. Only the puzzle survives. */
function plainGate(g: GateDraft): StoryGateOut | undefined {
  return g.kind === 'puzzle' ? { kind: 'puzzle', grid: g.grid } : undefined;
}

// Text-status backgrounds are the story's own artwork (white text on top in
// every theme), not app chrome: fixed colours in constants/storyPalette.ts.
const TEXT_BG_DEFAULT = TEXT_STORY_SWATCHES[0].color;
const FEED_CACHE = FEED_CACHE_KEY;   // shared with the viewer; never re-declare the literal
// Status mutes are DEVICE-LOCAL (AsyncStorage only; there is no server field),
// so they do not follow the account to another phone. The mute dialog says so.
const MUTED_KEY  = 'vc_muted_status';
const RECENT_EMOJI_KEY = 'vc_recent_emojis';

function useS() {
  const { colors } = useTheme();
  const { metrics } = useVisionComfort();
  return useMemo(() => makeStyles(colors, metrics), [colors, metrics]);
}

export default function StatusScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [feed,       setFeed]       = useState<StoryFeedEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [posting,    setPosting]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const authHeader = useAuthHeader();
  // Text status (WhatsApp) compose
  const [textOpen,   setTextOpen]   = useState(false);
  const [storyText,  setStoryText]  = useState('');
  const [storyBg,    setStoryBg]    = useState<string>(TEXT_BG_DEFAULT);
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);
  const [previewAssets, setPreviewAssets] = useState<PreviewAsset[]>([]);   // picked media awaiting caption + post
  const [previewIdx, setPreviewIdx] = useState(0);
  // ONE gate for the whole batch, not per asset. Ten photos each behind their
  // own puzzle would be a chore, not a feature.
  const [gate, setGate] = useState<GateDraft>({ kind: 'none' });

  useEffect(() => { AsyncStorage.getItem(RECENT_EMOJI_KEY).then(v => { try { if (v) setRecentEmojis(JSON.parse(v)); } catch {} }).catch(() => {}); }, []);
  const addEmoji = useCallback((e: string) => {
    setStoryText(t => (t + e).slice(0, 700));
    setRecentEmojis(prev => {
      const next = [e, ...prev.filter(x => x !== e)].slice(0, 24);   // most-recent first, deduped
      AsyncStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const [muted,      setMuted]      = useState<Set<string>>(new Set());

  useEffect(() => { AsyncStorage.getItem(MUTED_KEY).then(v => { try { if (v) setMuted(new Set(JSON.parse(v))); } catch {} }).catch(() => {}); }, []);
  const toggleMute = useCallback((userId: string, name: string) => {
    const isMuted = muted.has(userId);
    Alert.alert(isMuted ? `Unmute ${name}?` : `Mute ${name}?`, isMuted ? 'Their updates move back to the top on this device.' : 'Their updates move to Muted updates on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: isMuted ? 'Unmute' : 'Mute', onPress: () => {
        setMuted(prev => { const n = new Set(prev); if (n.has(userId)) n.delete(userId); else n.add(userId); AsyncStorage.setItem(MUTED_KEY, JSON.stringify([...n])).catch(() => {}); return n; });
      } },
    ]);
  }, [muted]);

  // load() also runs from pull-to-refresh, the socket and after posting, any of
  // which can settle after the tab is gone; only the focus effect had a guard.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const f = await listStoriesFeed();
      putStoryFeed(f);   // offline cache AND the viewer's warm start — see lib/storyFeedCache.ts
      if (!alive.current) return;
      setFeed(f);
      setError(null);
    } catch (e: unknown) {
      if (alive.current) setError(userErrorText(e, 'Failed to load stories'));
    }
  }, []);

  // Re-fetch on focus, but paint the cached feed first so it opens instantly
  // and works offline (the fresh fetch then reconciles seen-state etc).
  useFocusEffect(useCallback(() => {
    let cancel = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(FEED_CACHE);
        if (raw && !cancel) { setFeed(JSON.parse(raw)); setLoading(false); }
      } catch {}
      await load();
      if (!cancel) setLoading(false);
    })();
    return () => { cancel = true; };
  }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (alive.current) setRefreshing(false);
  }, [load]);

  // Realtime: a contact posting a new status refreshes the feed live.
  useEffect(() => {
    let off: (() => void) | null = null; let cancel = false;
    (async () => {
      // Attach only after the cancel check (as chats.tsx does): attaching first
      // leaked a listener whenever the effect was torn down while getSocket()
      // was still pending, because `off` was never assigned for it.
      try {
        const s = await getSocket();
        if (cancel) return;
        const onPosted = () => load();
        s.on('story_posted', onPosted);
        off = () => s.off('story_posted', onPosted);
      } catch {}
    })();
    return () => { cancel = true; if (off) off(); };
  }, [load]);

  // ── Create a new story (photo or video) ───────────────────
  // The viewer plays video stories; the server already accepts mediaType:'video'.
  const onPostText = useCallback(async () => {
    const t = storyText.trim();
    if (!t || posting) return;
    setPosting(true);
    try {
      await postTextStory(t, storyBg);
      setTextOpen(false); setStoryText(''); setStoryBg(TEXT_BG_DEFAULT);
      await load();
    } catch (e: unknown) {
      Alert.alert('Could not post', userErrorText(e, 'Try again'));
    } finally { if (alive.current) setPosting(false); }
  }, [storyText, storyBg, posting, load]);

  // Pick one or more photos/videos → open the preview+caption editor (WhatsApp).
  const onAddStory = useCallback(async () => {
    if (posting) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      permissionDenied('Permission needed', 'Allow photo library access to post a story.', perm.canAskAgain);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.7,
      allowsMultipleSelection: true,
      selectionLimit: 10,
      videoMaxDuration: 30,
    });
    if (result.canceled || !result.assets?.length) return;
    const assets: PreviewAsset[] = result.assets.map((a, i) => {
      const isVideo = a.type === 'video';
      return {
        uri: a.uri,
        type: isVideo ? 'video' : 'image',
        filename: a.fileName || `story-${Date.now()}-${i}.${isVideo ? 'mp4' : 'jpg'}`,
        mime: a.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
        caption: '',
        // Carried so the compressor can bound the LONG edge without opening the
        // file. Absent (some providers omit them) -> left uncompressed rather
        // than resized on a guess.
        width: a.width,
        height: a.height,
      };
    });
    setPreviewIdx(0);
    setGate({ kind: 'none' });   // a previous batch's lock must never carry over
    setPreviewAssets(assets);   // opens the preview modal
    // A video cannot be drawn by <Image>: extract a still for the preview and
    // the filmstrip (the same 1s-then-0 extractor the puzzle gate uses). No
    // still is fine — the preview shows a video placeholder instead.
    for (const a of assets) {
      if (a.type !== 'video') continue;
      puzzleFrameUri(a.uri, 'video').then((poster) => {
        if (poster && alive.current) setPreviewAssets(prev => prev.map(p => (p.uri === a.uri ? { ...p, poster } : p)));
      }).catch(() => {});
    }
  }, [posting]);

  // Closing the composer or the preview throws away what was typed / picked:
  // ask first whenever there is something to lose.
  const closeTextComposer = useCallback(() => {
    if (!storyText.trim()) { setTextOpen(false); return; }
    Alert.alert('Discard status?', 'The text you typed will be lost.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { setTextOpen(false); setStoryText(''); } },
    ]);
  }, [storyText]);
  const closePreview = useCallback(() => {
    if (posting) return;
    if (!previewAssets.length) return;
    Alert.alert(
      previewAssets.length > 1 ? `Discard ${previewAssets.length} items?` : 'Discard this item?',
      'Nothing has been posted yet.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => setPreviewAssets([]) },
      ],
    );
  }, [posting, previewAssets.length]);

  const setPreviewCaption = useCallback((text: string) => {
    setPreviewAssets(prev => prev.map((a, i) => (i === previewIdx ? { ...a, caption: text } : a)));
  }, [previewIdx]);

  // Upload + post every previewed asset (each with its own caption).
  const postPreview = useCallback(async () => {
    if (posting || !previewAssets.length) return;
    // Refuse an unusable question BEFORE anything uploads. Posting first and
    // failing after would leave orphaned attachments and a status the poster
    // thinks went out.
    if (gate.kind === 'question') {
      if (!gate.prompt.trim()) { Alert.alert('Add a question', 'Viewers need something to answer.'); return; }
      if (!isAcceptableAnswer(gate.answer)) { Alert.alert('Add an answer', 'Too short to be a secret.'); return; }
      // With encryption off there is no content key to lock, so an answer would
      // guard nothing — a prompt with no lock behind it. Say so rather than
      // posting something that LOOKS private and is not.
      if (!(STORY_E2EE && E2EE_ENABLED)) {
        Alert.alert('Not available', 'A question lock needs encrypted status, which is off on this build. Use a puzzle, or post without a lock.');
        return;
      }
    }
    setPosting(true);
    let posted = 0;
    try {
      for (const a of previewAssets) {
        const cap = a.caption.trim() || undefined;
        // SHRINK BEFORE ANYTHING ELSE TOUCHES IT.
        //
        // Every byte here is paid for three times: uploaded, encrypted (the
        // whole file streams through AES-GCM in lib/mediaCrypto), then
        // downloaded by every viewer. The picker's `quality: 0.7` did none of
        // this — it does not resize, and Android often ignores it — so a 12 MP
        // photo went up at 4000x3000.
        //
        // compressForStatus returns the ORIGINAL uri whenever it should not or
        // cannot act: an already-small image, missing dimensions, no video
        // transcoder in this build, or any failure. So this line can only make
        // the upload smaller, never make the post fail.
        const uri = await compressForStatus(a);
        if (STORY_E2EE && E2EE_ENABLED) {
          const { attachmentId, mediaKey } = await uploadEncryptedAttachment(uri, a.filename, a.mime);
          // A QUESTION GATE LOCKS THE KEY ITSELF, and does it HERE — the answer
          // never leaves this function. The server stores the salt and the
          // wrapped envelope; it never sees the answer, so it cannot tell a
          // right guess from a wrong one, and neither can anyone reading the
          // database. A puzzle gate does none of this: it is a UI gate over a
          // key the viewer already receives.
          let gateOut: StoryGateOut | undefined;
          // Store MY OWN copy of the content key locally so I can always view my
          // own story, independent of whether the server audience includes me
          // (otherwise the poster sees a blank story — no wrapped key for self).
          // This is also why the poster is never asked their own question.
          await putMediaKey(attachmentId, mediaKey).catch(() => {});
          const viewerIds = await getStoryAudience();

          let keys;
          if (gate.kind === 'question') {
            // WRAP THE LOCKED ENVELOPE, NOT THE KEY. If the raw key were wrapped
            // per viewer as usual, anyone in the audience could unwrap their own
            // copy and decrypt WITHOUT ever answering — the "private" gate would
            // be decoration. Wrapping the answer-locked envelope makes the two
            // locks compose: the audience decides who may TRY, the answer
            // decides who succeeds. The answer itself never leaves this device.
            const locked = await lockKeyWithAnswer(mediaKey, gate.answer);
            gateOut = { kind: 'question', prompt: gate.prompt.trim(), salt: locked.salt };
            keys = await wrapPayloadForViewers(viewerIds, JSON.stringify(locked));
          } else {
            if (gate.kind === 'puzzle') gateOut = { kind: 'puzzle', grid: gate.grid };
            keys = await wrapStoryKeyForViewers(viewerIds, mediaKey);
          }
          await addEncryptedStory(attachmentId, a.type, keys, cap, gateOut);
        } else {
          // 'story' media lives until the STORY expires (24h), not on any
          // chat clock — see migration 100.
          const up = await uploadAttachment(uri, a.filename, a.mime, { purpose: 'story' });
          await addStory(up.id, a.type, cap, plainGate(gate));
        }
        // Drop each asset from the batch the moment it is posted, so Retry
        // after a mid-batch failure sends only what is left — never a repeat.
        posted++;
        setPreviewAssets(prev => prev.filter(p => p.uri !== a.uri));
      }
      setPreviewAssets([]); setPreviewIdx(0);
      await load();
    } catch (e: unknown) {
      setPreviewIdx(0);
      if (posted > 0) load();
      Alert.alert(
        'Could not post story',
        posted > 0
          ? `${posted} posted. ${userErrorText(e, 'The rest failed')} — tap Post to retry the remaining ones.`
          : userErrorText(e, 'Try again'),
      );
    } finally {
      if (alive.current) setPosting(false);
    }
    // `gate` MUST be here. It is read twice above — the question validation and
    // the gateOut that goes to the server — and it is the ONLY input that
    // changes without also changing previewAssets: the poster picks the lock
    // inside the preview modal, long after this callback was last rebuilt.
    // Omitting it froze gate at the {kind:'none'} set when the batch was
    // picked, so EVERY status posted ungated no matter what the poster chose,
    // and the picker was pure decoration. Verified against prod: a status
    // posted with the puzzle option visibly selected stored gate_kind NULL.
  }, [posting, previewAssets, gate, load]);

  // Split feed: my own bucket (which may not yet exist) + others.
  const { mine, others, mutedOthers } = useMemo(() => {
    const mine = feed.find(e => e.isMine) ?? null;
    const all = feed.filter(e => !e.isMine);
    return { mine, others: all.filter(e => !muted.has(e.userId)), mutedOthers: all.filter(e => muted.has(e.userId)) };
  }, [feed, muted]);

  const openViewer = useCallback((entry: StoryFeedEntry) => {
    router.push({
      pathname: '/story-viewer',
      params: {
        userId:   entry.userId,
        userName: entry.name || entry.email || '',
      },
    });
  }, [router]);

  const rowProps = { authHeader, onOpen: openViewer, onToggleMute: toggleMute };

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <AuroraBackground variant="status" />
      <View style={S.header}>
        <Text style={S.title} accessibilityRole="header">Status</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {/* Privacy is the only status option, so the icon goes straight there
              instead of through a one-item menu. */}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Status privacy" onPress={() => router.push('/status-privacy')} activeOpacity={0.7} style={S.headerBtn}>
            <Ionicons name="lock-closed-outline" size={20} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setTextOpen(true)} disabled={posting} activeOpacity={0.7} style={S.headerBtn} accessibilityRole="button" accessibilityLabel="Write a text status" accessibilityState={{ disabled: posting }}>
            <Ionicons name="create-outline" size={22} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onAddStory} disabled={posting} activeOpacity={0.7} style={S.headerBtn} accessibilityRole="button" accessibilityLabel="Add a photo or video status" accessibilityState={{ disabled: posting, busy: posting && !textOpen }}>
            {posting && !textOpen ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="camera-outline" size={22} color={colors.text} />}
          </TouchableOpacity>
        </View>
      </View>

      {/* Text status composer (WhatsApp) */}
      <TextStatusComposer
        visible={textOpen}
        text={storyText} onChangeText={setStoryText}
        bg={storyBg} onChangeBg={setStoryBg} swatches={TEXT_STORY_SWATCHES}
        recentEmojis={recentEmojis} onEmoji={addEmoji}
        posting={posting} onPost={onPostText} onClose={closeTextComposer}
      />

      {/* Media status preview + caption editor (WhatsApp). Supports multiple. */}
      <MediaStatusPreview
        assets={previewAssets} index={previewIdx} onIndex={setPreviewIdx}
        gate={gate} onGate={setGate} onCaption={setPreviewCaption}
        posting={posting} onPost={postPreview} onClose={closePreview}
      />

      {error && (
        <TouchableOpacity onPress={onRefresh} disabled={refreshing} accessibilityRole="button" accessibilityLabel={`${error}. Tap to retry`}>
          <Text style={S.errorTxt}>{error} · Tap to retry</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={others}
        keyExtractor={(e) => e.userId}
        contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE + 16 }}
        refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View>
            {/* "My status" — always shown. Tap = view it if there is one, else
                add one. Who viewed it is shown inside the viewer, so there is
                no separate long-press action here. */}
            <TouchableOpacity
              style={S.row}
              activeOpacity={0.7}
              onPress={() => mine ? openViewer(mine) : onAddStory()}
              accessibilityRole="button"
              accessibilityLabel={mine ? `My status, ${mine.stories.length} ${mine.stories.length === 1 ? 'update' : 'updates'}, ${formatRelative(mine.latestAt)}` : 'My status. Add a status update'}
              accessibilityHint={mine ? 'Opens your status' : 'Picks a photo or video'}
            >
              <View>
                {mine ? (
                  <StoryRing size={60} segments={mine.stories.map(s => s.seen)} color={colors.primary} seenColor={colors.textDim}>
                    {mine.photoURL && authHeader
                      ? <Image source={{ uri: attachmentUrl(mine.photoURL), headers: { Authorization: authHeader } }} style={S.avatarImg} />
                      : <View style={S.avatarFallback}><Ionicons name="person" size={26} color={colors.textDim} /></View>}
                  </StoryRing>
                ) : (
                  <View style={S.avatarFallback}><Ionicons name="person" size={28} color={colors.textDim} /></View>
                )}
                <View style={S.cameraBadge}><Ionicons name="camera" size={13} color={colors.onPrimary} /></View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName}>My status</Text>
                <Text style={S.rowSub}>
                  {mine ? `Tap to view · ${formatRelative(mine.latestAt)}` : 'Tap to add status update'}
                </Text>
              </View>
            </TouchableOpacity>

            {others.length > 0 && (
              <Text style={S.sectionLabel} accessibilityRole="header">RECENT UPDATES</Text>
            )}
          </View>
        }
        ListEmptyComponent={others.length === 0 && mutedOthers.length === 0 ? (
          <View style={[S.center, { paddingHorizontal: 32, paddingTop: 48 }]}>
            <Text style={S.emptyTitle}>{error ? 'Couldn’t load updates' : 'No updates yet'}</Text>
            <Text style={S.emptySub}>
              {error ? 'Pull down to try again.' : 'Stories from people you share chats with will appear here. They auto-expire after 24 hours.'}
            </Text>
          </View>
        ) : null}
        renderItem={({ item }) => <StatusRow item={item} isMuted={muted.has(item.userId)} {...rowProps} />}
        ListFooterComponent={mutedOthers.length > 0 ? (
          <View>
            <Text style={S.sectionLabel} accessibilityRole="header">MUTED UPDATES</Text>
            {mutedOthers.map(item => <StatusRow key={item.userId} item={item} isMuted {...rowProps} />)}
          </View>
        ) : null}
      />
    </View>
  );
}

// A status row (reused for recent + muted), with long-press to (un)mute.
// Hoisted and memoised: it used to be a function rebuilt on every render.
const StatusRow = memo(function StatusRow({ item, isMuted, authHeader, onOpen, onToggleMute }: {
  item: StoryFeedEntry; isMuted: boolean; authHeader: string | null;
  onOpen: (e: StoryFeedEntry) => void; onToggleMute: (userId: string, name: string) => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  const name = item.name || item.email || item.userId.slice(0, 8);
  const unseen = item.stories.filter(st => !st.seen).length;
  const muteName = item.name || item.email || 'this person';
  return (
    <TouchableOpacity style={S.row} onPress={() => onOpen(item)} onLongPress={() => onToggleMute(item.userId, muteName)} delayLongPress={350} activeOpacity={0.7}
      accessibilityRole="button"
      // The ring says seen/unseen by colour alone; the label says it in words.
      accessibilityLabel={`${name}, ${item.stories.length} ${item.stories.length === 1 ? 'update' : 'updates'}${unseen ? `, ${unseen} unseen` : ''}, ${formatRelative(item.latestAt)}`}
      accessibilityHint="Opens their status. Long-press to mute or unmute"
      accessibilityActions={[{ name: 'mute', label: isMuted ? 'Unmute' : 'Mute' }]}
      onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'mute') onToggleMute(item.userId, muteName); }}>
      <StoryRing size={60} segments={item.stories.map(s => s.seen)} color={colors.primary} seenColor={colors.textDim}>
        {item.photoURL && authHeader
          ? <Image source={{ uri: attachmentUrl(item.photoURL), headers: { Authorization: authHeader } }} style={S.avatarImg} />
          : <View style={S.avatarFallback}><Text style={S.avatarFallbackTxt}>{initialOf(item.name, item.email)}</Text></View>}
      </StoryRing>
      <View style={{ flex: 1 }}>
        <Text style={S.rowName}>{name}</Text>
        <Text style={S.rowSub}>{item.stories.length} {item.stories.length === 1 ? 'update' : 'updates'} · {formatRelative(item.latestAt)}</Text>
      </View>
    </TouchableOpacity>
  );
});

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)      return 'now';
    if (diff < 3600_000)    return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)   return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
  } catch { return ''; }
}


const makeStyles = (c: Palette, m: ReturnType<typeof useVisionComfort>['metrics']) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.bg },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 16, justifyContent: 'space-between' },
  title:        { flexShrink: 1, marginRight: 8, color: c.text, fontSize: 28, fontWeight: '800' },
  headerBtn:    { width: 44 * m.controlScale, height: 44 * m.controlScale, borderRadius: 22 * m.controlScale, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.glassStroke },

  errorTxt:     { color: c.danger, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },

  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },

  row:          { marginHorizontal: 12, marginVertical: 4, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, backgroundColor: c.glassSoft, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 * m.spacingScale },
  avatarImg:         { width: 54, height: 54, borderRadius: 27 },
  avatarFallback:    { width: 54, height: 54, borderRadius: 27, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  cameraBadge:       { position: 'absolute', right: -1, bottom: -1, width: 22, height: 22, borderRadius: 11, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.bg },
  avatarFallbackTxt: { color: c.text, fontSize: 20, fontWeight: '700' },

  rowName:      { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:       { color: c.textDim, fontSize: 12, marginTop: 2 },

  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
});
