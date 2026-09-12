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

import { HEADER_TOP, TAB_BAR_SPACE } from '../../constants/layout';
import * as ImagePicker from 'expo-image-picker';
import { compressForStatus } from '../../lib/media/compressMedia';
import GatePicker, { type GateDraft } from '../../components/status/GatePicker';
import { putStoryFeed, FEED_CACHE_KEY } from '../../lib/storyFeedCache';
import { lockKeyWithAnswer } from '../../lib/status/gateKey';
import { wrapPayloadForViewers, wrapStoryKeyForViewers } from '../../lib/storyKeys';
import { isAcceptableAnswer } from '../../lib/status/gate';
import { type StoryGate as StoryGateOut, addStory, addEncryptedStory, getStoryAudience, attachmentUrl, listStoriesFeed, postTextStory, uploadAttachment, type StoryFeedEntry } from '../../lib/chatService';

/** The gate for an UNENCRYPTED story. A question gate is impossible here — with
 *  no content key to lock there is nothing for the answer to protect, so it
 *  would be a prompt with no lock behind it. Only the puzzle survives. */
function plainGate(g: GateDraft): StoryGateOut | undefined {
  return g.kind === 'puzzle' ? { kind: 'puzzle', grid: g.grid } : undefined;
}
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { StoryRing } from '../../components/StoryRing';
import { type Palette } from '../../constants/theme';
import { useTheme } from '../../lib/theme';
import { getAccessToken } from '../../lib/api';
import { getSocket } from '../../lib/socket';
import { STORY_E2EE, E2EE_ENABLED } from '../../constants/flags';
import { uploadEncryptedAttachment } from '../../lib/mediaAttachments';
import { putMediaKey } from '../../lib/mediaKeyStore';
import { AuroraBackground } from '../../components/ui';

const TEXT_BGS = ['#0B0B10', '#7E57C2', '#26A69A', '#EF5350', '#42A5F5', '#FFA726', '#5C6BC0'];
const QUICK_EMOJIS = ['😀','😂','🥰','😍','😎','🤔','😅','😭','😡','👍','🙏','👏','🔥','✨','🎉','❤️','💔','💯','🙌','😴','🥳','😇','🤩','😱','😬','🤗','😉','😏','🤨','😌','💪','👀','🌟','⚡','🌈','☀️','🌙','⭐','💜','💙'];
const FEED_CACHE = FEED_CACHE_KEY;   // shared with the viewer; never re-declare the literal
const MUTED_KEY  = 'vc_muted_status';
const RECENT_EMOJI_KEY = 'vc_recent_emojis';

type PreviewAsset = { uri: string; type: 'image' | 'video'; filename: string; mime: string; caption: string; width?: number; height?: number };

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
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
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  // Text status (WhatsApp) compose
  const [textOpen,   setTextOpen]   = useState(false);
  const [storyText,  setStoryText]  = useState('');
  const [storyBg,    setStoryBg]    = useState(TEXT_BGS[0]);
  const [emojiOpen,  setEmojiOpen]  = useState(false);
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);
  const [previewAssets, setPreviewAssets] = useState<PreviewAsset[]>([]);   // picked media awaiting caption + post
  const [previewIdx, setPreviewIdx] = useState(0);
  // ONE gate for the whole batch, not per asset. Ten photos each behind their
  // own puzzle would be a chore, not a feature.
  const [gate, setGate] = useState<GateDraft>({ kind: 'none' });

  useEffect(() => { AsyncStorage.getItem(RECENT_EMOJI_KEY).then(v => { try { if (v) setRecentEmojis(JSON.parse(v)); } catch {} }); }, []);
  const addEmoji = useCallback((e: string) => {
    setStoryText(t => (t + e).slice(0, 700));
    setRecentEmojis(prev => {
      const next = [e, ...prev.filter(x => x !== e)].slice(0, 24);   // most-recent first, deduped
      AsyncStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const [muted,      setMuted]      = useState<Set<string>>(new Set());

  useEffect(() => { AsyncStorage.getItem(MUTED_KEY).then(v => { try { if (v) setMuted(new Set(JSON.parse(v))); } catch {} }); }, []);
  const toggleMute = useCallback((userId: string, name: string) => {
    const isMuted = muted.has(userId);
    Alert.alert(isMuted ? `Unmute ${name}?` : `Mute ${name}?`, isMuted ? 'Their updates move back to the top.' : 'Their updates move to Muted updates.', [
      { text: 'Cancel', style: 'cancel' },
      { text: isMuted ? 'Unmute' : 'Mute', onPress: () => {
        setMuted(prev => { const n = new Set(prev); n.has(userId) ? n.delete(userId) : n.add(userId); AsyncStorage.setItem(MUTED_KEY, JSON.stringify([...n])).catch(() => {}); return n; });
      } },
    ]);
  }, [muted]);

  const load = useCallback(async () => {
    try {
      const [f, tok] = await Promise.all([listStoriesFeed(), getAccessToken()]);
      setFeed(f);
      setAuthHeader(tok ? `Bearer ${tok}` : null);
      setError(null);
      putStoryFeed(f);   // offline cache AND the viewer's warm start — see lib/storyFeedCache.ts
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load stories');
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
    setRefreshing(false);
  }, [load]);

  // Realtime: a contact posting a new status refreshes the feed live.
  useEffect(() => {
    let off: (() => void) | null = null; let cancel = false;
    (async () => {
      try { const s = await getSocket(); const onPosted = () => load(); s.on('story_posted', onPosted); if (!cancel) off = () => s.off('story_posted', onPosted); } catch {}
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
      setTextOpen(false); setStoryText(''); setStoryBg(TEXT_BGS[0]);
      await load();
    } catch (e: any) {
      Alert.alert('Could not post', e?.message ?? 'Try again');
    } finally { setPosting(false); }
  }, [storyText, storyBg, posting, load]);

  // Pick one or more photos/videos → open the preview+caption editor (WhatsApp).
  const onAddStory = useCallback(async () => {
    if (posting) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to post a story.');
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
  }, [posting]);

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
      }
      setPreviewAssets([]); setPreviewIdx(0);
      await load();
    } catch (e: any) {
      Alert.alert('Could not post story', e?.message ?? 'Try again');
    } finally {
      setPosting(false);
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
      pathname: '/story-viewer' as any,
      params: {
        userId:   entry.userId,
        userName: entry.name ?? entry.email ?? '',
      },
    });
  }, [router]);

  // A status row (reused for recent + muted), with long-press to (un)mute.
  const statusRow = useCallback((item: StoryFeedEntry) => (
    <TouchableOpacity style={S.row} onPress={() => openViewer(item)} onLongPress={() => toggleMute(item.userId, item.name ?? item.email ?? 'this person')} delayLongPress={350} activeOpacity={0.7}>
      <StoryRing size={60} segments={item.stories.map(s => s.seen)} color={colors.primary} seenColor={colors.textDim}>
        {item.photoURL && authHeader
          ? <Image source={{ uri: attachmentUrl(item.photoURL), headers: { Authorization: authHeader } }} style={S.avatarImg} />
          : <View style={S.avatarFallback}><Text style={S.avatarFallbackTxt}>{(item.name ?? item.email ?? '?').trim()[0].toUpperCase()}</Text></View>}
      </StoryRing>
      <View style={{ flex: 1 }}>
        <Text style={S.rowName} numberOfLines={1}>{item.name ?? item.email ?? item.userId.slice(0, 8)}</Text>
        <Text style={S.rowSub}>{item.stories.length} {item.stories.length === 1 ? 'update' : 'updates'} · {formatRelative(item.latestAt)}</Text>
      </View>
    </TouchableOpacity>
  ), [S, colors, authHeader, openViewer, toggleMute]);

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <AuroraBackground variant="status" />
      <View style={S.header}>
        <Text style={S.title}>Status</Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          <TouchableOpacity onPress={() => Alert.alert('Status', undefined, [
            { text: 'Status privacy', onPress: () => router.push('/status-privacy' as any) },
            { text: 'Cancel', style: 'cancel' },
          ])} activeOpacity={0.7} style={S.headerBtn}>
            <Ionicons name="ellipsis-vertical" size={20} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setTextOpen(true)} disabled={posting} activeOpacity={0.7} style={S.headerBtn}>
            <Ionicons name="create-outline" size={22} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={onAddStory} disabled={posting} activeOpacity={0.7} style={S.headerBtn}>
            {posting && !textOpen ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="camera-outline" size={22} color={colors.text} />}
          </TouchableOpacity>
        </View>
      </View>

      {/* Text status composer (WhatsApp) */}
      <Modal visible={textOpen} transparent={false} animationType="slide" onRequestClose={() => setTextOpen(false)}>
        <View style={[S.textCompose, { backgroundColor: storyBg }]}>
          <View style={S.textComposeBar}>
            <TouchableOpacity onPress={() => setTextOpen(false)} hitSlop={10}><Ionicons name="close" size={26} color="#fff" /></TouchableOpacity>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <TouchableOpacity onPress={() => setEmojiOpen(o => !o)} hitSlop={8}>
                <Ionicons name={emojiOpen ? 'happy' : 'happy-outline'} size={24} color="#fff" />
              </TouchableOpacity>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {TEXT_BGS.map(b => (
                  <TouchableOpacity key={b} onPress={() => setStoryBg(b)} style={[S.bgSwatch, { backgroundColor: b }, storyBg === b && S.bgSwatchOn]} />
                ))}
              </View>
            </View>
          </View>
          <TextInput
            style={S.textComposeInput}
            value={storyText}
            onChangeText={setStoryText}
            placeholder="Type a status"
            placeholderTextColor="rgba(255,255,255,0.6)"
            multiline
            autoFocus={!emojiOpen}
            maxLength={700}
            textAlign="center"
          />

          {/* Emoji picker — recently-used first (WhatsApp), then the full set. */}
          {emojiOpen && (
            <View style={S.emojiPanel}>
              <ScrollView contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
                {recentEmojis.length > 0 && (
                  <>
                    <Text style={S.emojiSection}>RECENTLY USED</Text>
                    <View style={S.emojiGrid}>
                      {recentEmojis.map(e => (
                        <TouchableOpacity key={`r-${e}`} onPress={() => addEmoji(e)} style={S.emojiBtn}>
                          <Text style={S.emojiTxt}>{e}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    <Text style={S.emojiSection}>ALL</Text>
                  </>
                )}
                <View style={S.emojiGrid}>
                  {QUICK_EMOJIS.map(e => (
                    <TouchableOpacity key={e} onPress={() => addEmoji(e)} style={S.emojiBtn}>
                      <Text style={S.emojiTxt}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>
          )}

          <TouchableOpacity style={[S.textPostBtn, (!storyText.trim() || posting) && { opacity: 0.5 }]} onPress={onPostText} disabled={!storyText.trim() || posting}>
            {posting ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={24} color="#fff" />}
          </TouchableOpacity>
        </View>
      </Modal>

      {/* Media status preview + caption editor (WhatsApp). Supports multiple. */}
      <Modal visible={previewAssets.length > 0} transparent={false} animationType="slide" onRequestClose={() => !posting && setPreviewAssets([])}>
        <View style={S.previewScreen}>
          <View style={S.previewBar}>
            <TouchableOpacity onPress={() => !posting && setPreviewAssets([])} hitSlop={10}>
              <Ionicons name="close" size={26} color="#fff" />
            </TouchableOpacity>
            {previewAssets.length > 1 && <Text style={S.previewCount}>{previewIdx + 1}/{previewAssets.length}</Text>}
            <View style={{ width: 26 }} />
          </View>

          <View style={S.previewMain}>
            {previewAssets[previewIdx] && (previewAssets[previewIdx].type === 'image'
              ? <Image source={{ uri: previewAssets[previewIdx].uri }} style={S.previewImg} resizeMode="contain" />
              : <View style={[S.previewImg, { alignItems: 'center', justifyContent: 'center' }]}>
                  <Image source={{ uri: previewAssets[previewIdx].uri }} style={S.previewImg} resizeMode="contain" />
                  <View style={S.previewPlay}><Ionicons name="play" size={34} color="#fff" /></View>
                </View>)}
          </View>

          {/* Filmstrip of all selected (tap to switch) */}
          {previewAssets.length > 1 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={S.filmstrip} contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}>
              {previewAssets.map((a, i) => (
                <TouchableOpacity key={i} onPress={() => setPreviewIdx(i)} style={[S.thumb, i === previewIdx && S.thumbOn]}>
                  <Image source={{ uri: a.uri }} style={S.thumbImg} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          <ScrollView style={S.gateArea} contentContainerStyle={{ padding: 12 }} keyboardShouldPersistTaps="handled">
            <GatePicker
              value={gate}
              onChange={setGate}
              accent={colors.primary}
              text="#fff"
              dim="rgba(255,255,255,0.6)"
              surface="rgba(255,255,255,0.08)"
            />
          </ScrollView>

          <View style={S.captionRow}>
            <TextInput
              style={S.captionInput}
              value={previewAssets[previewIdx]?.caption ?? ''}
              onChangeText={setPreviewCaption}
              placeholder="Add a caption…"
              placeholderTextColor="rgba(255,255,255,0.6)"
              multiline
              maxLength={200}
            />
            <TouchableOpacity style={[S.sendFab, posting && { opacity: 0.6 }]} onPress={postPreview} disabled={posting}>
              {posting ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={22} color="#fff" />}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {error && <Text style={S.errorTxt}>{error}</Text>}

      <FlatList
        data={others}
        keyExtractor={(e) => e.userId}
        contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE + 16 }}
        refreshControl={<RefreshControl tintColor={colors.primary} refreshing={refreshing} onRefresh={onRefresh} />}
        ListHeaderComponent={
          <View>
            {/* "My status" — always shown. Tap = add another to story, or
                view existing if there's one already. Long-press TODO:
                viewer list (delegated to viewer screen for now). */}
            <TouchableOpacity
              style={S.row}
              activeOpacity={0.7}
              onPress={() => mine ? openViewer(mine) : onAddStory()}
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
                <View style={S.cameraBadge}><Ionicons name="camera" size={13} color="#fff" /></View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName}>My status</Text>
                <Text style={S.rowSub} numberOfLines={1}>
                  {mine ? `Tap to view · ${formatRelative(mine.latestAt)}` : 'Tap to add status update'}
                </Text>
              </View>
            </TouchableOpacity>

            {others.length > 0 && (
              <Text style={S.sectionLabel}>RECENT UPDATES</Text>
            )}
          </View>
        }
        ListEmptyComponent={others.length === 0 && mutedOthers.length === 0 ? (
          <View style={[S.center, { paddingHorizontal: 32, paddingTop: 48 }]}>
            <Text style={S.emptyTitle}>No updates yet</Text>
            <Text style={S.emptySub}>
              Stories from people you share chats with will appear here. They auto-expire after 24 hours.
            </Text>
          </View>
        ) : null}
        renderItem={({ item }) => statusRow(item)}
        ListFooterComponent={mutedOthers.length > 0 ? (
          <View>
            <Text style={S.sectionLabel}>MUTED UPDATES</Text>
            {mutedOthers.map(item => <View key={item.userId}>{statusRow(item)}</View>)}
          </View>
        ) : null}
      />
    </View>
  );
}

function formatRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000)      return 'now';
    if (diff < 3600_000)    return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000)   return `${Math.floor(diff / 3600_000)}h ago`;
    return `${Math.floor(diff / 86400_000)}d ago`;
  } catch { return ''; }
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.bg },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: HEADER_TOP, paddingBottom: 16, justifyContent: 'space-between' },
  title:        { color: c.text, fontSize: 28, fontWeight: '800' },
  headerBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.glassStroke },
  headerBtnTxt: { color: c.primary, fontSize: 22, fontWeight: '600', marginTop: -2 },
  // Text status composer
  textCompose:      { flex: 1, paddingTop: HEADER_TOP },
  textComposeBar:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  bgSwatch:         { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  bgSwatchOn:       { borderWidth: 3, borderColor: c.glassStroke },
  textComposeInput: { flex: 1, color: '#fff', fontSize: 26, fontWeight: '700', paddingHorizontal: 24, textAlignVertical: 'center' },
  textPostBtn:      { position: 'absolute', right: 20, bottom: 36, width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' },
  emojiPanel:       { maxHeight: 200, backgroundColor: 'rgba(0,0,0,0.35)', paddingVertical: 8 },
  emojiGrid:        { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', paddingHorizontal: 8 },
  emojiSection:     { color: 'rgba(255,255,255,0.6)', fontSize: 11, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 2 },

  previewScreen:    { flex: 1, backgroundColor: c.bg, paddingTop: HEADER_TOP },
  previewBar:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 },
  previewCount:     { color: '#fff', fontSize: 14, fontWeight: '700' },
  previewMain:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewImg:       { width: '100%', height: '100%' },
  previewPlay:      { position: 'absolute', width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  filmstrip:        { maxHeight: 64, paddingVertical: 8 },
  thumb:            { width: 48, height: 48, borderRadius: 8, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  thumbOn:          { borderColor: c.glassStroke },
  thumbImg:         { width: '100%', height: '100%' },
  gateArea:         { maxHeight: 260, backgroundColor: 'rgba(0,0,0,0.35)' },
  captionRow:       { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 12, paddingBottom: 28, paddingTop: 8 },
  captionInput:     { flex: 1, color: '#fff', fontSize: 16, maxHeight: 120, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.12)' },
  sendFab:          { width: 50, height: 50, borderRadius: 25, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  emojiBtn:         { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  emojiTxt:         { fontSize: 28 },

  errorTxt:     { color: c.danger, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },

  sectionLabel: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },

  row:          { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  // 3px-thick ring that wraps the avatar. Purple = unseen, grey = all
  // seen. The ring is a padded square with a coloured background.
  avatarRing:        { width: 60, height: 60, borderRadius: 30, padding: 3, alignItems: 'center', justifyContent: 'center' },
  avatarRingMine:    { backgroundColor: c.primary },
  avatarRingUnseen:  { backgroundColor: c.primary },
  avatarRingSeen:    { backgroundColor: c.textDim },
  avatarImg:         { width: 54, height: 54, borderRadius: 27 },
  avatarFallback:    { width: 54, height: 54, borderRadius: 27, backgroundColor: c.glassSoft, alignItems: 'center', justifyContent: 'center' },
  cameraBadge:       { position: 'absolute', right: -1, bottom: -1, width: 22, height: 22, borderRadius: 11, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: c.bg },
  avatarFallbackTxt: { color: c.text, fontSize: 20, fontWeight: '700' },

  rowName:      { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:       { color: c.textDim, fontSize: 12, marginTop: 2 },

  emptyTitle:   { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  emptySub:     { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
});
