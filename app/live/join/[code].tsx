// app/live/join/[code].tsx — redeem a Private Live invitation and watch.
//
// Reached three ways:
//   1. The https link the host copies:  https://<api-host>/live/join/CODE
//   2. The app scheme:                  vaultchat://live/join/CODE
//   3. In-app paste-to-join, which pushes /live/join/<code>
//
// Backed by POST /golive/invite/:code (routes/golive_invites.go). Redeeming
// writes an ordinary broadcast_invites row, so every existing gate — watch,
// token, chat, polls, HLS ticket — then applies with no new authorization path.
//
// WHY THIS ASKS FOR A NAME AND A PASSCODE
// ---------------------------------------
// Same reason Zoom does. The passcode is a SECOND CHANNEL: a link is one string
// in a group chat, and once forwarded it carries its own authority. Requiring
// something the host shared separately makes a leaked link inert. The name is
// the joiner's call because a broadcast audience is not a contact list — it can
// include people the host has never messaged, and you should decide what a room
// of strangers sees. It is prefilled from the profile, so the default is free.
//
// A redeemed link grants VIEWING, never a seat on the 20-person stage. Only the
// host promoting someone puts their camera up.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ActivityIndicator, TouchableOpacity, StatusBar,
  TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { type Palette } from '../../../constants/theme';
import { useTheme } from '../../../lib/theme';
import { redeemInviteLink, inviteCodeFrom } from '../../../lib/broadcast';
import { getMyProfile } from '../../../lib/chatService';

type Phase =
  // Trying with what we have. The FIRST attempt deliberately sends no passcode:
  // most private lives do not set one, and prompting for a passcode that is not
  // required would be a wall in front of every joiner to serve a minority.
  | { kind: 'joining' }
  // The code is good, the passcode is not (or was not supplied).
  | { kind: 'passcode'; wrong: boolean }
  | { kind: 'error' };

export default function LiveJoinScreen() {
  const { colors } = useTheme();
  const s = useS(colors);
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();

  // inviteCodeFrom also accepts a whole pasted URL, so a user who pastes the
  // full link into the in-app box lands here with something usable either way.
  const code = inviteCodeFrom(String(params.code ?? ''));

  const [phase, setPhase] = useState<Phase>({ kind: 'joining' });
  const [name, setName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [busy, setBusy] = useState(false);

  // Prefill the name from the profile. Failure is not worth surfacing — the
  // field is editable and the server falls back to the profile name anyway.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const me: any = await getMyProfile();
        const n = (me?.name ?? me?.displayName ?? me?.username ?? '').trim();
        if (alive && n) setName(n);
      } catch { /* leave it blank */ }
    })();
    return () => { alive = false; };
  }, []);

  const attempt = useCallback(async (pc: string, showWrong: boolean) => {
    if (!code) { setPhase({ kind: 'error' }); return; }
    setBusy(true);
    try {
      const res = await redeemInviteLink(code, { passcode: pc, displayName: name });
      if (res.ok) {
        // replace, not push, so Back does not bounce through the redeem flow.
        router.replace({ pathname: '/live-view', params: { id: res.broadcastId } } as any);
        return;
      }
      setPhase(res.reason === 'passcode'
        ? { kind: 'passcode', wrong: showWrong }
        : { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }, [code, name, router]);

  // One silent attempt on mount. Runs once: `attempt` closes over `name`, and
  // re-firing a redeem every time the prefill lands would double-post.
  useEffect(() => { void attempt('', false); /* eslint-disable-next-line */ }, [code]);

  if (phase.kind === 'joining') {
    return (
      <View style={s.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <StatusBar barStyle="light-content" />
        <View style={s.body}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={s.title}>Joining live…</Text>
          <Text style={s.sub}>Checking your invitation</Text>
        </View>
      </View>
    );
  }

  if (phase.kind === 'error') {
    return (
      <View style={s.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <StatusBar barStyle="light-content" />
        <View style={s.body}>
          <Ionicons name="close-circle-outline" size={56} color={colors.danger} />
          <Text style={s.title}>This invitation isn’t valid</Text>
          <Text style={s.sub}>
            The link may have been revoked or expired, or the broadcast has ended.
            Ask the host for a new link.
          </Text>
          <TouchableOpacity style={s.cta} onPress={() => router.replace('/(tabs)/chats' as any)} activeOpacity={0.85}>
            <Text style={s.ctaText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Passcode gate.
  const canSubmit = passcode.trim().length > 0 && !busy;
  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="light-content" />
      <View style={s.body}>
        <Ionicons name="lock-closed-outline" size={48} color={colors.primary} />
        <Text style={s.title}>This live is protected</Text>
        <Text style={s.sub}>Enter the passcode the host gave you.</Text>

        <Text style={s.label}>Your name</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="Name viewers will see"
          placeholderTextColor={colors.textDim}
          maxLength={64}
          autoCapitalize="words"
          returnKeyType="next"
        />

        <Text style={s.label}>Passcode</Text>
        <TextInput
          style={[s.input, phase.wrong && s.inputBad]}
          value={passcode}
          onChangeText={setPasscode}
          placeholder="Passcode"
          placeholderTextColor={colors.textDim}
          maxLength={64}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={() => { if (canSubmit) void attempt(passcode, true); }}
        />
        {phase.wrong && <Text style={s.bad}>That passcode is not correct.</Text>}

        <TouchableOpacity
          style={[s.cta, !canSubmit && s.ctaOff]}
          onPress={() => { if (canSubmit) void attempt(passcode, true); }}
          activeOpacity={0.85}
          disabled={!canSubmit}
        >
          {busy
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.ctaText}>Join live</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.replace('/(tabs)/chats' as any)} activeOpacity={0.7}>
          <Text style={s.cancel}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function useS(colors: Palette) {
  return React.useMemo(() => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
    title: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 18, textAlign: 'center' },
    sub: { color: colors.textDim, fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
    label: { color: colors.textDim, fontSize: 12, fontWeight: '600', alignSelf: 'flex-start', marginTop: 20, marginBottom: 6 },
    input: {
      width: '100%', backgroundColor: colors.surface, color: colors.text,
      borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16,
      borderWidth: 1, borderColor: colors.border,
    },
    inputBad: { borderColor: colors.danger },
    bad: { color: colors.danger, fontSize: 13, marginTop: 8, alignSelf: 'flex-start' },
    cta: {
      backgroundColor: colors.primary, borderRadius: 14, paddingVertical: 14,
      paddingHorizontal: 32, marginTop: 24, minWidth: 200, alignItems: 'center',
    },
    ctaOff: { opacity: 0.5 },
    ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    cancel: { color: colors.textDim, fontSize: 14, marginTop: 18 },
  }), [colors]);
}
