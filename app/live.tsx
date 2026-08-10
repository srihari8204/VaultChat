// app/live.tsx — Live broadcasts: what is on now, and going live yourself.
//
// The third communication mode. Unlike calls and group calls, a broadcast is
// NOT end-to-end encrypted — the audience is unbounded and receives HLS from a
// CDN, so no key exchange can reach them. That is stated to the user here,
// before they publish anything, rather than buried in settings: in an app
// called VaultChat, someone going live has every reason to assume the same
// protection their calls have, and they would be wrong.
//
// The banner reads `e2ee` from the server rather than hardcoding "not
// encrypted", so if an encrypted broadcast mode ever ships this screen tells
// the truth without being edited.

import React, { useCallback, useState } from 'react';
import {
  View, ScrollView, TouchableOpacity, StyleSheet, TextInput,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '../lib/theme';
import { AppText } from '../components/ui/Text';
import { SPACING, RADIUS } from '../constants/theme';
import { listLive, startBroadcast, type Broadcast } from '../lib/broadcast';

export default function LiveScreen() {
  const colors = useColors();
  const router = useRouter();
  const [live, setLive] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [title, setTitle] = useState('');
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    try { setLive(await listLive()); } catch { /* offline — keep what we have */ }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const goLive = async () => {
    const t = title.trim();
    if (!t) { Alert.alert('Give it a title', 'Viewers see this in the list.'); return; }
    setStarting(true);
    try {
      const b = await startBroadcast(t);
      setComposing(false);
      setTitle('');
      router.push({ // `as any`: expo-router's generated route union is written at build time and
// does not yet know a route added in the same change. Matches how the call
// screens reference /group-call-active.
pathname: '/live-view' as any, params: { id: b.id, host: '1' } });
    } catch (e: any) {
      // 409 is the specific, actionable case: one live stream per account, so
      // a second would orphan the first with no way to end it.
      const msg = String(e?.message ?? '');
      Alert.alert(
        'Could not go live',
        msg.includes('409') || /already/i.test(msg)
          ? 'You already have a broadcast running. End it before starting another.'
          : 'Something went wrong starting the broadcast.',
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <View style={[S.root, { backgroundColor: colors.surfaceSolid }]}>
      <Stack.Screen options={{ title: 'Live' }} />

      <ScrollView
        contentContainerStyle={S.scroll}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.textDim} />}
      >
        {/* Said plainly, and BEFORE the go-live button. */}
        <View style={[S.notice, { backgroundColor: colors.surface }]}>
          <Ionicons name="eye-outline" size={18} color={colors.textDim} />
          <AppText style={[S.noticeText, { color: colors.textDim }]}>
            Broadcasts are public and <AppText style={{ color: colors.text, fontWeight: '700' }}>not
            end-to-end encrypted</AppText>. Anyone with the link can watch. Your
            calls and messages are unaffected.
          </AppText>
        </View>

        {composing ? (
          <View style={[S.card, { backgroundColor: colors.surface }]}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What are you streaming?"
              placeholderTextColor={colors.textFaint}
              style={[S.input, { color: colors.text }]}
              maxLength={200}
              autoFocus
            />
            <View style={S.row}>
              <TouchableOpacity
                onPress={() => { setComposing(false); setTitle(''); }}
                style={[S.btn, { backgroundColor: colors.surfaceSolid }]}
              >
                <AppText style={{ color: colors.textDim }}>Cancel</AppText>
              </TouchableOpacity>
              <TouchableOpacity onPress={goLive} disabled={starting} style={S.btnPrimary}>
                <LinearGradient colors={['#EF4444', '#B91C1C']} style={S.btnGrad}>
                  {starting
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <AppText style={S.btnPrimaryText}>Go live</AppText>}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity onPress={() => setComposing(true)} activeOpacity={0.85}>
            <LinearGradient colors={['#EF4444', '#B91C1C']} style={S.goLive}>
              <Ionicons name="radio-outline" size={22} color="#fff" />
              <AppText style={S.goLiveText}>Go live</AppText>
            </LinearGradient>
          </TouchableOpacity>
        )}

        <AppText style={[S.section, { color: colors.textDim }]}>LIVE NOW</AppText>

        {loading ? (
          <ActivityIndicator style={{ marginTop: SPACING.xl }} color={colors.textDim} />
        ) : live.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="videocam-off-outline" size={34} color={colors.textFaint} />
            <AppText style={[S.emptyText, { color: colors.textFaint }]}>
              Nobody is live right now
            </AppText>
          </View>
        ) : (
          live.map(b => (
            <TouchableOpacity
              key={b.id}
              onPress={() => router.push({ // `as any`: expo-router's generated route union is written at build time and
// does not yet know a route added in the same change. Matches how the call
// screens reference /group-call-active.
pathname: '/live-view' as any, params: { id: b.id } })}
              style={[S.card, { backgroundColor: colors.surface }]}
              activeOpacity={0.85}
            >
              <View style={S.cardTop}>
                <View style={S.liveDot} />
                <AppText style={[S.liveLabel]}>LIVE</AppText>
                <AppText style={[S.viewers, { color: colors.textFaint }]}>
                  {b.viewerCount} watching
                </AppText>
              </View>
              <AppText style={[S.title, { color: colors.text }]} numberOfLines={2}>
                {b.title || 'Untitled broadcast'}
              </AppText>
              {/* Rendered from the server's value, never assumed. */}
              {!b.e2ee && (
                <AppText style={[S.notEncrypted, { color: colors.textFaint }]}>
                  Not end-to-end encrypted
                </AppText>
              )}
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const S = StyleSheet.create({
  root: { flex: 1 },
  scroll: { padding: SPACING.lg, paddingBottom: SPACING.xxxl },
  notice: {
    flexDirection: 'row', gap: SPACING.md, padding: SPACING.md,
    borderRadius: RADIUS.md, marginBottom: SPACING.lg, alignItems: 'flex-start',
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 19 },
  goLive: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.sm, paddingVertical: SPACING.lg, borderRadius: RADIUS.lg,
  },
  goLiveText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  card: { padding: SPACING.lg, borderRadius: RADIUS.lg, marginBottom: SPACING.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  liveLabel: { color: '#EF4444', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  viewers: { fontSize: 12, marginLeft: 'auto' },
  title: { fontSize: 16, fontWeight: '600' },
  notEncrypted: { fontSize: 11, marginTop: SPACING.xs },
  section: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginVertical: SPACING.lg },
  input: { fontSize: 16, paddingVertical: SPACING.md },
  row: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.md },
  btn: { flex: 1, paddingVertical: SPACING.md, borderRadius: RADIUS.md, alignItems: 'center' },
  btnPrimary: { flex: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  btnGrad: { paddingVertical: SPACING.md, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '700' },
  empty: { alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.xxl },
  emptyText: { fontSize: 14 },
});
