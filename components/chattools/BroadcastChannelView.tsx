// components/chattools/BroadcastChannelView.tsx — one broadcast channel: its
// posts (paged, live), the admin's composer and post delete, and Leave for a
// subscriber. Split out of app/broadcast.tsx, which keeps the channel list.
//
// Render it with key={channel.id}: everything here belongs to one channel, so a
// different channel is a fresh instance and a slow page for the previous one is
// dropped by the `alive` flag instead of an id comparison.
//
// Leave and post delete are new server routes (fixes/R4BE.md C5/C6), written
// but not deployed. Today's server answers them with a plain-text 404, which
// isMissingRoute recognises: the channel and the post stay, and the copy says
// the action is not available yet.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, FlatList, Share, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../lib/theme';
import { getSocket } from '../../lib/socket';
import { isMissingRoute } from '../../lib/missingRoute';
import {
  deleteChannelPost, leaveChannel, listChannelPosts, postToChannel,
  type Channel, type ChannelPost,
} from '../../lib/chatService';
import { AuroraBackground } from '../ui';
import { KeyboardSafe } from '../ui/KeyboardSafe';
import { useBroadcastStyles } from './broadcastStyles';

const POSTS_PAGE = 50;

export function shareChannelInvite(ch: Channel) {
  return Share.share({ message: `Join my crazzychat channel "${ch.name}"!\nOpen crazzychat → Broadcast Channels → Join Channel and enter: ${ch.inviteCode}\nOr open: vaultchat://broadcast?code=${encodeURIComponent(ch.inviteCode)}` });
}

const postTime = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };

export function BroadcastChannelView({ channel, onClose, onLeft }: {
  channel: Channel;
  onClose: () => void;
  /** The user left this channel: drop it from the list. */
  onLeft: (channelId: string) => void;
}) {
  const { colors } = useTheme();
  const s = useBroadcastStyles();
  const channelId = channel.id;

  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(true);
  const [postsErr, setPostsErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Older posts: loaded page by page with `before` as the list scrolls up.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [postText, setPostText] = useState('');
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // The channel view is an in-screen mode, so Android back must close it
  // rather than leave the whole screen.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => sub.remove();
  }, [onClose]);

  // First page. A failure is an error with Try again, never "No posts yet".
  useEffect(() => {
    let active = true;
    setLoadingPosts(true);
    setPostsErr(null);
    listChannelPosts(channelId, { limit: POSTS_PAGE })
      .then(page => { if (active) { setPosts(page); setHasMore(page.length >= POSTS_PAGE); } })
      .catch((e: any) => { if (active) setPostsErr(e?.message ?? 'Failed to load posts'); })
      .finally(() => { if (active) setLoadingPosts(false); });
    return () => { active = false; };
  }, [channelId, reloadKey]);

  // Realtime: join the channel's room, prepend live posts, drop deleted ones.
  // channelId on the event is new (R4BE C4); while it is absent every event in
  // this room is accepted, as before.
  useEffect(() => {
    let active = true;
    let cleanup = () => {};
    (async () => {
      try {
        const sock = await getSocket();
        if (!active) return;
        sock.emit('channel_join', { channelId });
        const onPost = (p: ChannelPost) => {
          if (p.channelId && p.channelId !== channelId) return;
          setPosts(prev => prev.some(x => x.id === p.id) ? prev : [p, ...prev]);
        };
        const onDeleted = (d: { channelId?: string; id?: number | string }) => {
          if (d?.channelId !== channelId) return;
          setPosts(prev => prev.filter(x => String(x.id) !== String(d.id)));
        };
        sock.on('channel_post', onPost);
        sock.on('channel_post_deleted', onDeleted);
        cleanup = () => {
          sock.off('channel_post', onPost);
          sock.off('channel_post_deleted', onDeleted);
          sock.emit('channel_leave', { channelId });
        };
      } catch { /* realtime optional */ }
    })();
    return () => { active = false; cleanup(); };
  }, [channelId]);

  const loadOlder = useCallback(async () => {
    const oldest = posts[posts.length - 1];
    if (!oldest || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listChannelPosts(channelId, { before: oldest.id, limit: POSTS_PAGE });
      if (!alive.current) return;
      setPosts(prev => [...prev, ...page.filter(p => !prev.some(x => x.id === p.id))]);
      setHasMore(page.length >= POSTS_PAGE);
    } catch { /* stays scrollable; the next end-reached retries */ }
    finally { if (alive.current) setLoadingMore(false); }
  }, [channelId, posts, hasMore, loadingMore]);

  const sendPost = async () => {
    const text = postText.trim();
    if (!text || postingRef.current) return;
    postingRef.current = true;
    setPosting(true);
    try {
      const post = await postToChannel(channelId, text);
      if (!alive.current) return;
      setPosts(prev => prev.some(x => x.id === post.id) ? prev : [post, ...prev]);
      setPostText('');
    } catch (e: any) { Alert.alert('Could not post', e?.message ?? 'Try again.'); }
    finally { postingRef.current = false; if (alive.current) setPosting(false); }
  };

  const deletePost = useCallback((p: ChannelPost) => Alert.alert(
    'Delete this post?',
    'It is removed for every subscriber.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await deleteChannelPost(channelId, p.id);
          if (alive.current) setPosts(prev => prev.filter(x => x.id !== p.id));
        } catch (e: any) {
          if (isMissingRoute(e)) Alert.alert("Deleting posts isn't available yet", 'The post was not deleted.');
          else Alert.alert('Could not delete the post', e?.message ?? 'Try again.');
        }
      } },
    ],
  ), [channelId]);

  const leave = () => Alert.alert(
    `Leave ${channel.name}?`,
    'You will stop receiving its posts. You can join again with an invite code.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: async () => {
        setLeaving(true);
        try {
          await leaveChannel(channelId);
          onLeft(channelId);
        } catch (e: any) {
          if (isMissingRoute(e)) Alert.alert("Leaving channels isn't available yet", 'You are still subscribed to this channel.');
          else Alert.alert('Could not leave the channel', e?.message ?? 'Try again.');
        } finally { if (alive.current) setLeaving(false); }
      } },
    ],
  );

  const renderPost = useCallback(({ item }: { item: ChannelPost }) => {
    const body = (
      <>
        {!!item.authorName && <Text style={s.postAuthor}>{item.authorName}</Text>}
        <Text style={s.postText}>{item.text}</Text>
        <Text style={s.postTime}>{postTime(item.createdAt)}</Text>
      </>
    );
    if (!channel.isAdmin) return <View style={s.postCard}>{body}</View>;
    // Admin: long-press deletes; screen readers get the same as an action.
    return (
      <TouchableOpacity
        style={s.postCard}
        activeOpacity={0.7}
        onLongPress={() => deletePost(item)}
        accessibilityRole="text"
        accessibilityLabel={`${item.authorName ? item.authorName + ': ' : ''}${item.text}. ${postTime(item.createdAt)}`}
        accessibilityActions={[{ name: 'delete', label: 'Delete post' }]}
        onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'delete') deletePost(item); }}
      >
        {body}
      </TouchableOpacity>
    );
  }, [s, channel.isAdmin, deletePost]);

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={onClose} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} numberOfLines={1} accessibilityRole="header">{channel.name}</Text>
        <TouchableOpacity onPress={() => shareChannelInvite(channel)} style={s.shareBtn} accessibilityRole="button" accessibilityLabel="Share invite code">
          <Text style={s.shareLink}>Share</Text>
        </TouchableOpacity>
        {!channel.isAdmin && (
          <TouchableOpacity onPress={leave} disabled={leaving} style={s.shareBtn} accessibilityRole="button" accessibilityLabel="Leave channel" accessibilityState={{ disabled: leaving, busy: leaving }}>
            {leaving ? <ActivityIndicator color={colors.danger} size="small" /> : <Text style={s.leaveLink}>Leave</Text>}
          </TouchableOpacity>
        )}
      </View>

      <View style={s.channelInfo}>
        <Text style={s.channelMeta}>
          {(channel.subscriberCount ?? 1)} subscribers{channel.isAdmin ? ' • You are admin · long-press a post to delete it' : ''}
        </Text>
        {!!channel.description && <Text style={s.channelDesc}>{channel.description}</Text>}
        <Text style={s.channelMeta}>Channel posts are not end-to-end encrypted.</Text>
      </View>

      {postsErr && posts.length === 0 ? (
        <View style={s.postErrBox}>
          <Text style={s.emptyTxt}>{"Couldn't load posts"}</Text>
          <Text style={s.emptySub} accessibilityRole="alert">{postsErr}</Text>
          <TouchableOpacity accessibilityRole="button" onPress={() => setReloadKey(k => k + 1)} style={s.retryBtn}>
            <Text style={s.modalBtnTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : loadingPosts && posts.length === 0 ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} accessibilityLabel="Loading posts" />
      ) : (
        <FlatList
          data={posts}
          inverted
          keyExtractor={p => String(p.id)}
          renderItem={renderPost}
          ListEmptyComponent={<View style={s.emptyBox}><Text style={s.emptyTxt}>No posts yet</Text></View>}
          onEndReached={loadOlder}
          onEndReachedThreshold={0.3}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={{ margin: 12 }} accessibilityLabel="Loading older posts" /> : null}
          contentContainerStyle={{ padding: 12 }}
        />
      )}

      {channel.isAdmin ? (
        <KeyboardSafe keyboardOnly style={{ flex: 0 }}>
          <View style={s.postBar}>
            <TextInput
              style={s.postInput}
              value={postText}
              onChangeText={setPostText}
              placeholder="Write a broadcast…"
              placeholderTextColor={colors.textFaint}
              accessibilityLabel="Broadcast message"
              multiline
            />
            <TouchableOpacity style={[s.postBtn, !postText.trim() && s.postBtnOff]} onPress={sendPost} disabled={!postText.trim() || posting} accessibilityRole="button" accessibilityLabel="Post broadcast" accessibilityState={{ disabled: !postText.trim() || posting, busy: posting }}>
              {posting ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Text style={s.postBtnTxt}>POST</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardSafe>
      ) : (
        <View style={s.readOnly}><Text style={s.readOnlyTxt}>Only the admin can post in this channel</Text></View>
      )}
    </View>
  );
}
