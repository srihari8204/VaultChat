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

import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getAccessToken } from '../../lib/api';
import {
  addStory,
  addEncryptedStory,
  getStoryAudience,
  attachmentUrl,
  listStoriesFeed,
  uploadAttachment,
  type StoryFeedEntry,
} from '../../lib/chatService';
import { STORY_E2EE, E2EE_ENABLED } from '../../constants/flags';
import { uploadEncryptedAttachment } from '../../lib/mediaAttachments';
import { wrapStoryKeyForViewers } from '../../lib/storyKeys';

export default function StatusScreen() {
  const router = useRouter();
  const [feed,       setFeed]       = useState<StoryFeedEntry[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [posting,    setPosting]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [f, tok] = await Promise.all([listStoriesFeed(), getAccessToken()]);
      setFeed(f);
      setAuthHeader(tok ? `Bearer ${tok}` : null);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load stories');
    }
  }, []);

  // Re-fetch every time the tab regains focus. Cheap (single round-trip)
  // and means the user always sees fresh stories without manual pulldown.
  useFocusEffect(useCallback(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
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

  // ── Create a new story ────────────────────────────────────
  // Photo only for the MVP — videos add a Video<>RTCView size dance we
  // can address in round 2. Server already accepts mediaType:'video'.
  const onAddStory = useCallback(async () => {
    if (posting) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to post a story.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setPosting(true);
    try {
      const filename = asset.fileName || `story-${Date.now()}.jpg`;
      const mime     = asset.mimeType || 'image/jpeg';

      if (STORY_E2EE && E2EE_ENABLED) {
        // Encrypt the media once, then wrap its key per authorized viewer.
        const { attachmentId, mediaKey } = await uploadEncryptedAttachment(asset.uri, filename, mime);
        const viewerIds = await getStoryAudience();
        const keys = await wrapStoryKeyForViewers(viewerIds, mediaKey);
        await addEncryptedStory(attachmentId, 'image', keys);
      } else {
        const up = await uploadAttachment(asset.uri, filename, mime);
        await addStory(up.id, 'image');
      }
      await load();
    } catch (e: any) {
      Alert.alert('Could not post story', e?.message ?? 'Try again');
    } finally {
      setPosting(false);
    }
  }, [posting, load]);

  // Split feed: my own bucket (which may not yet exist) + others.
  const { mine, others } = useMemo(() => {
    const mine = feed.find(e => e.isMine) ?? null;
    const others = feed.filter(e => !e.isMine);
    return { mine, others };
  }, [feed]);

  const openViewer = useCallback((entry: StoryFeedEntry) => {
    router.push({
      pathname: '/story-viewer' as any,
      params: {
        userId:   entry.userId,
        userName: entry.name ?? entry.email ?? '',
      },
    });
  }, [router]);

  if (loading) {
    return <View style={[S.screen, S.center]}><ActivityIndicator color={ACCENT} size="large" /></View>;
  }

  return (
    <View style={S.screen}>
      <View style={S.header}>
        <Text style={S.title}>Status</Text>
        <TouchableOpacity
          onPress={onAddStory}
          disabled={posting}
          activeOpacity={0.7}
          style={S.headerBtn}
        >
          {posting ? <ActivityIndicator color={ACCENT} /> : <Text style={S.headerBtnTxt}>＋</Text>}
        </TouchableOpacity>
      </View>

      {error && <Text style={S.errorTxt}>{error}</Text>}

      <FlatList
        data={others}
        keyExtractor={(e) => e.userId}
        refreshControl={<RefreshControl tintColor={ACCENT} refreshing={refreshing} onRefresh={onRefresh} />}
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
              <View style={[S.avatarRing, S.avatarRingMine]}>
                {mine?.photoURL && authHeader ? (
                  <Image
                    source={{ uri: attachmentUrl(mine.photoURL), headers: { Authorization: authHeader } }}
                    style={S.avatarImg}
                  />
                ) : (
                  <View style={S.avatarFallback}>
                    <Text style={S.avatarFallbackTxt}>＋</Text>
                  </View>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.rowName}>My status</Text>
                <Text style={S.rowSub} numberOfLines={1}>
                  {mine
                    ? `${mine.stories.length} ${mine.stories.length === 1 ? 'update' : 'updates'} · tap to view`
                    : 'Add a photo. Disappears in 24 hours.'}
                </Text>
              </View>
            </TouchableOpacity>

            {others.length > 0 && (
              <Text style={S.sectionLabel}>RECENT UPDATES</Text>
            )}
          </View>
        }
        ListEmptyComponent={others.length === 0 ? (
          <View style={[S.center, { paddingHorizontal: 32, paddingTop: 48 }]}>
            <Text style={S.emptyTitle}>No updates yet</Text>
            <Text style={S.emptySub}>
              Stories from people you share chats with will appear here. They auto-expire after 24 hours.
            </Text>
          </View>
        ) : null}
        renderItem={({ item }) => (
          <TouchableOpacity style={S.row} onPress={() => openViewer(item)} activeOpacity={0.7}>
            <View style={[S.avatarRing, item.seenAll ? S.avatarRingSeen : S.avatarRingUnseen]}>
              {item.photoURL && authHeader ? (
                <Image
                  source={{ uri: attachmentUrl(item.photoURL), headers: { Authorization: authHeader } }}
                  style={S.avatarImg}
                />
              ) : (
                <View style={S.avatarFallback}>
                  <Text style={S.avatarFallbackTxt}>{(item.name ?? item.email ?? '?').trim()[0].toUpperCase()}</Text>
                </View>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.rowName} numberOfLines={1}>{item.name ?? item.email ?? item.userId.slice(0, 8)}</Text>
              <Text style={S.rowSub}>
                {item.stories.length} {item.stories.length === 1 ? 'update' : 'updates'} · {formatRelative(item.latestAt)}
              </Text>
            </View>
          </TouchableOpacity>
        )}
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

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:       { flex: 1, backgroundColor: DARK_BG },
  center:       { justifyContent: 'center', alignItems: 'center' },

  header:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16, justifyContent: 'space-between' },
  title:        { color: TEXT, fontSize: 28, fontWeight: '800' },
  headerBtn:    { width: 40, height: 40, borderRadius: 20, backgroundColor: CARD_BG, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BORDER },
  headerBtnTxt: { color: ACCENT, fontSize: 22, fontWeight: '600', marginTop: -2 },

  errorTxt:     { color: DANGER, paddingHorizontal: 16, paddingVertical: 8, fontSize: 12 },

  sectionLabel: { color: SUBTLE, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },

  row:          { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  // 3px-thick ring that wraps the avatar. Purple = unseen, grey = all
  // seen. The ring is a padded square with a coloured background.
  avatarRing:        { width: 60, height: 60, borderRadius: 30, padding: 3, alignItems: 'center', justifyContent: 'center' },
  avatarRingMine:    { backgroundColor: ACCENT },
  avatarRingUnseen:  { backgroundColor: ACCENT },
  avatarRingSeen:    { backgroundColor: '#374151' },
  avatarImg:         { width: 54, height: 54, borderRadius: 27 },
  avatarFallback:    { width: 54, height: 54, borderRadius: 27, backgroundColor: CARD_BG, alignItems: 'center', justifyContent: 'center' },
  avatarFallbackTxt: { color: TEXT, fontSize: 20, fontWeight: '700' },

  rowName:      { color: TEXT, fontSize: 15, fontWeight: '600' },
  rowSub:       { color: SUBTLE, fontSize: 12, marginTop: 2 },

  emptyTitle:   { color: TEXT, fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 8 },
  emptySub:     { color: SUBTLE, fontSize: 13, lineHeight: 18, textAlign: 'center' },
});
