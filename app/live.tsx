// app/live.tsx — Live broadcasts: what is on now, and going live yourself.
//
// The third communication mode. Unlike calls and group calls, a broadcast is
// NOT end-to-end encrypted — the audience is unbounded and receives HLS from a
// CDN, so no key exchange can reach them. That is stated to the user here,
// before they publish anything, rather than buried in settings: in an app
// called crazzychat, someone going live has every reason to assume the same
// protection their calls have, and they would be wrong.
//
// The banner reads `e2ee` from the server rather than hardcoding "not
// encrypted", so if an encrypted broadcast mode ever ships this screen tells
// the truth without being edited.

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  listLive, startBroadcast, inviteCodeFrom, type Broadcast, type BroadcastVisibility,
} from '../lib/broadcast';
import { rememberHostPasscode } from '../lib/golive/hostPasscodeMemo';

export default function LiveScreen() {
  const colors = useColors();
  const router = useRouter();
  const [live, setLive] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // An offline list is not "Nobody is live right now".
  const [loadError, setLoadError] = useState(false);
  const [starting, setStarting] = useState(false);
  const [title, setTitle] = useState('');
  const [composing, setComposing] = useState(false);
  const [desc, setDesc] = useState('');
  /**
   * Camera and microphone chosen BEFORE going live, not after.
   *
   * A host who wants an audio-only stream, or who is about to share a screen
   * rather than their face, should not have to go live with the camera on and
   * then scramble to turn it off in front of an audience. These are handed to
   * the broadcast screen as params and applied at join.
   */
  const [cam, setCam] = useState(true);
  const [mic, setMic] = useState(true);
  // Public by default. A host who wanted private and forgot to say so gets a
  // stream that is too open, which is bad — but the reverse default gives every
  // host who did nothing a stream nobody can find, which is worse and silent.
  // The choice is on screen before "Go live", not in a settings sheet.
  const [visibility, setVisibility] = useState<BroadcastVisibility>('public');
  // The host's own copy of the passcode. The server stores only a bcrypt hash
  // and never returns it, so this is the ONLY readable copy — it is handed to
  // live-view so the invite sheet can show the host what to share.
  const [passcode, setPasscode] = useState('');
  // Joining someone else's private live, as opposed to starting one.
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');

  /**
   * Hand the pasted invitation to the join screen.
   *
   * inviteCodeFrom accepts a whole URL or a bare code, so pasting the link
   * verbatim — which is what people actually do — works without asking anyone to
   * pick the code out of it by hand.
   */
  const goJoin = useCallback(() => {
    const code = inviteCodeFrom(joinCode);
    if (!code) return;
    setJoinOpen(false);
    setJoinCode('');
    // The join screen owns the name + passcode prompt and the redeem itself, so
    // this only has to get the code there.
    router.push(`/live/join/${encodeURIComponent(code)}`);
  }, [joinCode, router]);

  // The list request can land after the screen is gone: no state updates then.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const rows = await listLive();
      if (!mounted.current) return;
      setLive(rows); setLoadError(false);
    } catch { if (mounted.current) setLoadError(true); /* offline — keep what we have, and say so */ }
    if (mounted.current) setLoading(false);
  }, []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { if (mounted.current) setRefreshing(false); }
  }, [load]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const goLive = async () => {
    const t = title.trim();
    if (!t) { Alert.alert('Give it a title', 'Viewers see this in the list.'); return; }
    setStarting(true);
    try {
      // Passcode only on a private live — the server drops it otherwise, so
      // sending it would be a lie the UI told about a public stream.
      const pc = visibility === 'private' ? passcode.trim() : '';
      const b = await startBroadcast(t, undefined, visibility, desc.trim(), pc);
      setComposing(false);
      setTitle('');
      setDesc('');
      setPasscode('');
      // The host's readable passcode goes to live-view through memory, not the
      // route params: params land in the navigation state and the URL.
      if (pc) rememberHostPasscode(b.id, pc);
      router.push({ pathname: '/live-view', params: {
        id: b.id, host: '1',
        // The pre-live choices, applied at join rather than after it.
        cam: cam ? '1' : '0', mic: mic ? '1' : '0',
        // Private streams get their shareable invitation opened immediately —
        // it is the whole point of choosing private, and burying it behind a
        // menu would make the host hunt for it while already on air.
        invite: visibility === 'private' ? '1' : '0',
        // The passcode is NOT here — see rememberHostPasscode above. Still lost
        // if the app restarts mid-broadcast, which is why the field warns the
        // host to keep their own copy.
      } });
    } catch (e: any) {
      // Three outcomes worth telling apart, because the user's next action
      // differs for each.
      // Told apart by the HTTP status lib/api puts on the error, not by matching
      // the message text (the server's wording is free to change).
      const status = typeof e?.status === 'number' ? e.status : null;
      const already = status === 409;
      // 503 is the deployment saying Go Live has no LiveKit of its own. It does
      // NOT fall back to the calling cluster, so this is a real, final answer —
      // and "something went wrong" would send the user into a retry loop that
      // cannot succeed.
      const unconfigured = status === 503;
      Alert.alert(
        'Could not go live',
        already
          ? 'You already have a broadcast running. End it before starting another.'
          : unconfigured
            ? 'Live broadcasting is not available on this server yet. Your calls and messages are unaffected.'
            : 'Something went wrong starting the broadcast.',
      );
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  return (
    <View style={[S.root, { backgroundColor: colors.surfaceSolid }]}>
      <Stack.Screen options={{
        headerShown: true, /* the root Stack sets headerShown:false app-wide, so the options below were inert and this screen had no back control at all */  title: 'Live' }} />

      <ScrollView
        contentContainerStyle={S.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textDim} />}
      >
        {/* Said plainly, and BEFORE the go-live button. */}
        <View style={[S.notice, { backgroundColor: colors.glassSoft }]}>
          <Ionicons name="eye-outline" size={18} color={colors.textDim} />
          {/* Matches the visibility being composed: "public" under the Private
              option contradicted the hint right below it. */}
          <AppText style={[S.noticeText, { color: colors.textDim }]}>
            {composing && visibility === 'private'
              ? 'Private broadcasts reach only the people you invite, but are '
              : 'Broadcasts are public and '}
            <AppText style={{ color: colors.text, fontWeight: '700' }}>not
            end-to-end encrypted</AppText>.{composing && visibility === 'private'
              ? ' Anyone holding your invitation can watch.'
              : ' Anyone with the link can watch.'} Your calls and messages are unaffected.
          </AppText>
        </View>

        {composing ? (
          <View style={[S.card, { backgroundColor: colors.glassSoft }]}>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="What are you streaming?"
              accessibilityLabel="Broadcast title"
              placeholderTextColor={colors.textFaint}
              style={[S.input, { color: colors.text }]}
              maxLength={200}
              autoFocus
            />

            {/* Who can watch. Two options, stated in plain words rather than a
                toggle labelled "private" that leaves the user guessing what the
                other state means. */}
            <View style={S.segment}>
              {(['public', 'private'] as const).map(v => {
                const on = visibility === v;
                return (
                  <TouchableOpacity
                    key={v}
                    onPress={() => setVisibility(v)}
                    style={[
                      S.segmentBtn,
                      { backgroundColor: on ? colors.surfaceSolid : 'transparent' },
                    ]}
                    activeOpacity={0.85}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={v === 'public' ? 'Public broadcast' : 'Private broadcast'}
                  >
                    <Ionicons
                      name={v === 'public' ? 'globe-outline' : 'lock-closed-outline'}
                      size={15}
                      color={on ? colors.text : colors.textFaint}
                    />
                    <AppText style={{ color: on ? colors.text : colors.textFaint, fontWeight: on ? '700' : '500' }}>
                      {v === 'public' ? 'Public' : 'Private'}
                    </AppText>
                  </TouchableOpacity>
                );
              })}
            </View>
            <AppText style={[S.segmentHint, { color: colors.textFaint }]}>
              {visibility === 'public'
                ? 'Anyone on crazzychat can find and watch this.'
                : 'Only people you invite can watch. It will not appear in Live now.'}
            </AppText>

            {/* Passcode — private only, and optional.

                Shown only for private because on a public stream it would imply
                a protection that does not exist: the server drops a passcode
                sent with visibility=public.

                Optional because the invite code is already 32 random bytes. The
                passcode defends against the link being FORWARDED, which not
                every host cares about, and forcing one on everybody to serve
                that case would be a wall in front of the common flow. */}
            {visibility === 'private' && (
              <>
                <TextInput
                  value={passcode}
                  onChangeText={setPasscode}
                  placeholder="Passcode (optional)"
                  accessibilityLabel="Passcode, optional"
                  placeholderTextColor={colors.textFaint}
                  style={[S.input, { color: colors.text }]}
                  maxLength={64}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <AppText style={[S.segmentHint, { color: colors.textFaint }]}>
                  {passcode.trim()
                    ? 'Viewers must enter this as well as opening your link. Send it separately — a forwarded link alone will not get anyone in.'
                    : 'Add one if you want the link to be useless on its own. You cannot read it back later, so keep your own copy.'}
                </AppText>
              </>
            )}

            <TextInput
              value={desc}
              onChangeText={setDesc}
              placeholder="Description (optional)"
              accessibilityLabel="Description, optional"
              placeholderTextColor={colors.textFaint}
              style={[S.input, S.inputDesc, { color: colors.text }]}
              maxLength={1000}
              multiline
            />

            {/* Camera and mic, decided before going on air. */}
            <View style={S.devices}>
              {([['cam', cam, setCam, 'videocam', 'videocam-off', 'Camera'],
                 ['mic', mic, setMic, 'mic', 'mic-off', 'Mic']] as const).map(
                ([key, on, set, onIcon, offIcon, label]) => (
                  <TouchableOpacity
                    key={key}
                    onPress={() => set(v => !v)}
                    style={[S.device, { backgroundColor: colors.surfaceSolid }]}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={label}
                    activeOpacity={0.85}
                  >
                    <Ionicons
                      name={on ? onIcon : offIcon}
                      size={16}
                      color={on ? colors.text : colors.textFaint}
                    />
                    <AppText style={{ color: on ? colors.text : colors.textFaint, fontSize: 13 }}>
                      {label} {on ? 'on' : 'off'}
                    </AppText>
                  </TouchableOpacity>
                ))}
            </View>

            <View style={S.row}>
              <TouchableOpacity
                // The passcode is cleared too: it is the one secret on this form.
                onPress={() => { setComposing(false); setTitle(''); setDesc(''); setPasscode(''); }}
                style={[S.btn, { backgroundColor: colors.surfaceSolid }]}
                accessibilityRole="button"
              >
                <AppText style={{ color: colors.textDim }}>Cancel</AppText>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={goLive} disabled={starting} style={S.btnPrimary}
                accessibilityRole="button" accessibilityLabel="Go live now"
                accessibilityState={{ disabled: starting, busy: starting }}
              >
                {/* The "on air" red gradient is a fixed brand mark for Go Live in both themes. */}
                <LinearGradient colors={['#EF4444', '#B91C1C']} style={S.btnGrad}>
                  {starting
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <AppText style={S.btnPrimaryText}>Go live</AppText>}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <>
            <TouchableOpacity onPress={() => setComposing(true)} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Go live">
              <LinearGradient colors={['#EF4444', '#B91C1C']} style={S.goLive}>
                <Ionicons name="radio-outline" size={22} color="#fff" />
                <AppText style={S.goLiveText}>Go live</AppText>
              </LinearGradient>
            </TouchableOpacity>

            {/* JOIN A PRIVATE LIVE.
                A private broadcast is deliberately absent from LIVE NOW, so
                without this the ONLY way in was tapping the host's link. Anyone
                who received the invitation as text — read out, in another app,
                on a second device — had no way to use it at all.

                The passcode alone cannot get you in and there is no field for it
                here on purpose: it is the SECOND factor, not an address. What
                identifies the broadcast is the invitation code, so that is what
                this asks for; the passcode and your name are then asked for on
                the join screen itself. */}
            {joinOpen ? (
              <View style={[S.card, { backgroundColor: colors.glassSoft, marginTop: SPACING.md }]}>
                <AppText style={[S.title, { color: colors.text }]}>Join a private live</AppText>
                <AppText style={[S.segmentHint, { color: colors.textFaint }]}>
                  Paste the invitation link the host sent you. You will be asked for
                  your name and the passcode next.
                </AppText>
                <TextInput
                  value={joinCode}
                  onChangeText={setJoinCode}
                  placeholder="Paste invitation link or code"
                  accessibilityLabel="Invitation link or code"
                  placeholderTextColor={colors.textFaint}
                  style={[S.input, { color: colors.text }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={goJoin}
                  returnKeyType="go"
                />
                <View style={S.row}>
                  <TouchableOpacity
                    style={[S.btn, { backgroundColor: colors.glassSoft }]}
                    onPress={() => { setJoinOpen(false); setJoinCode(''); }}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                  >
                    <AppText style={{ color: colors.textDim, fontWeight: '600' }}>Cancel</AppText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[S.btn, { backgroundColor: colors.primary, opacity: joinCode.trim() ? 1 : 0.5 }]}
                    onPress={goJoin}
                    disabled={!joinCode.trim()}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !joinCode.trim() }}
                  >
                    <AppText style={{ color: colors.onPrimary, fontWeight: '700' }}>Continue</AppText>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                onPress={() => setJoinOpen(true)}
                activeOpacity={0.85}
                style={[S.joinBtn, { borderColor: colors.glassStroke }]}
                accessibilityRole="button"
              >
                <Ionicons name="lock-closed-outline" size={18} color={colors.textDim} />
                <AppText style={{ color: colors.text, fontWeight: '600' }}>Join a private live</AppText>
              </TouchableOpacity>
            )}
          </>
        )}

        <AppText style={[S.section, { color: colors.textDim }]} accessibilityRole="header">LIVE NOW</AppText>

        {/* A failed refresh over a list already shown keeps the list, and says
            it may be out of date (the empty case has its own state below). */}
        {!loading && loadError && live.length > 0 && (
          <TouchableOpacity
            onPress={refresh} accessibilityRole="button" style={S.stale}
            accessibilityLabel="Could not refresh live broadcasts. This list may be out of date. Try again"
          >
            <Ionicons name="cloud-offline-outline" size={14} color={colors.danger} />
            <AppText style={[S.staleText, { color: colors.textDim }]}>
              Couldn’t refresh — this list may be out of date. <AppText style={{ color: colors.primary, fontWeight: '600' }}>Try again</AppText>
            </AppText>
          </TouchableOpacity>
        )}

        {loading ? (
          <ActivityIndicator style={{ marginTop: SPACING.xl }} color={colors.textDim} />
        ) : loadError && live.length === 0 ? (
          <View style={S.empty}>
            <Ionicons name="cloud-offline-outline" size={34} color={colors.textFaint} />
            <AppText style={[S.emptyText, { color: colors.textDim }]}>
              Could not load live broadcasts. Check your connection.
            </AppText>
            <TouchableOpacity onPress={refresh} accessibilityRole="button" style={[S.joinBtn, { borderColor: colors.glassStroke, paddingHorizontal: SPACING.xl }]}>
              <AppText style={{ color: colors.text, fontWeight: '600' }}>Try again</AppText>
            </TouchableOpacity>
          </View>
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
              onPress={() => router.push({ pathname: '/live-view', params: { id: b.id } })}
              style={[S.card, { backgroundColor: colors.glassSoft }]}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`Watch ${b.title || 'Untitled broadcast'}, live${b.visibility === 'private' ? ', private' : ''}, ${b.viewerCount} watching`}
            >
              <View style={S.cardTop}>
                <View style={S.liveDot} />
                <AppText style={[S.liveLabel, { color: colors.danger }]}>LIVE</AppText>
                {/* A private stream only reaches this list for its host and the
                    people invited to it, so the badge explains WHY it is here
                    rather than flagging something unusual. From the server's
                    `visibility`, never from what this client requested. */}
                {b.visibility === 'private' && (
                  <Ionicons name="lock-closed" size={11} color={colors.textFaint} />
                )}
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
  joinBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.sm, paddingVertical: SPACING.md, borderRadius: RADIUS.md,
    borderWidth: 1, marginTop: SPACING.md,
  },
  card: { padding: SPACING.lg, borderRadius: RADIUS.lg, marginBottom: SPACING.md },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm },
  // The LIVE dot/label are the same fixed "on air" red as the Go Live gradient.
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
  // The label takes the theme's danger red: the fixed #EF4444 is ~3.3:1 on the
  // light glass card, below AA for 12 pt text. Dark danger is the same #EF4444.
  liveLabel: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  viewers: { fontSize: 12, marginLeft: 'auto' },
  title: { fontSize: 16, fontWeight: '600' },
  notEncrypted: { fontSize: 11, marginTop: SPACING.xs },
  section: { fontSize: 11, fontWeight: '700', letterSpacing: 1, marginVertical: SPACING.lg },
  input: { fontSize: 16, paddingVertical: SPACING.md },
  inputDesc: { fontSize: 14, maxHeight: 90 },
  devices: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.sm },
  device: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.xs, paddingVertical: SPACING.sm, borderRadius: RADIUS.md,
  },
  segment: { flexDirection: 'row', gap: SPACING.xs, marginTop: SPACING.sm },
  segmentBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: SPACING.xs, paddingVertical: SPACING.sm, borderRadius: RADIUS.md,
  },
  segmentHint: { fontSize: 12, marginTop: SPACING.xs, lineHeight: 17 },
  row: { flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.md },
  btn: { flex: 1, paddingVertical: SPACING.md, borderRadius: RADIUS.md, alignItems: 'center' },
  btnPrimary: { flex: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  btnGrad: { paddingVertical: SPACING.md, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '700' },
  empty: { alignItems: 'center', gap: SPACING.md, paddingVertical: SPACING.xxl },
  stale: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.md, minHeight: 44 },
  staleText: { flex: 1, fontSize: 13 },
  emptyText: { fontSize: 14 },
});
