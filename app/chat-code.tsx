// app/chat-code.tsx — the two halves of a chat code: make one, or use one.
//
// A chat code is for the person sitting across from you who is not in your
// address book and is not going to be. You read them six digits, they type them
// in, and you have a normal VaultChat conversation — encryption, calls, files,
// all of it — without either of you handing over a phone number.
//
// Reached from the temporary-chat sheet on Chats, because the timer and the
// code answer the same question ("talk to someone without keeping it") from
// opposite ends: the sheet's first two rows pick a duration for someone you
// already know, these two pick a person you do not.
//
// WHY THE COUNTDOWN IS THE LOUDEST THING ON THE SCREEN
// ----------------------------------------------------
// The code dies two minutes after it is made, and that short life is the only
// reason six digits is safe (see migration 118). So the countdown is not
// decoration — it is the feature. Someone who does not notice it will read out
// a dead code and blame the app.

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, Share,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  createChatCode, getChatCode, joinChatCode, revokeChatCode, type ChatCode,
} from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

// The four things a code can open.
//
// The first two SELF-DESTRUCT: at the deadline the whole conversation is
// deleted — messages, membership, the thread itself (migration 120) — and
// talking again needs a NEW code. That is deliberately stronger than the
// disappearing-messages timer the temporary-chat sheet uses, which expires
// messages and leaves the chat standing. The copy has to say "everything",
// because "messages disappear" is what the weaker feature promises.
//
// The last two never expire. They differ only in Ghost Mode: "Until I delete"
// leaves a stranger a stranger — no online, typing, read receipts or last-seen
// either way — while "Save this contact" says this is someone you are keeping,
// so they behave like every other contact.
const OPTIONS: {
  key: string; label: string; sub: string; ttl: number | null; keep: boolean;
}[] = [
  { key: '1h',    label: '1 hour',            sub: 'The whole chat deletes itself after an hour — you would need a new code',    ttl: 3600,  keep: false },
  { key: '3h',    label: '3 hours',           sub: 'The whole chat deletes itself after three hours — you would need a new code', ttl: 10800, keep: false },
  { key: 'keep',  label: 'Until I delete',    sub: 'Stays until one of you deletes it. You stay strangers — no last-seen, typing or read receipts', ttl: null, keep: false },
  { key: 'saved', label: 'Save this contact', sub: 'Stays, and they become a normal contact',            ttl: null,  keep: true  },
];

function secondsLeft(iso?: string): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

// mm:ss, because at two minutes "expires in 1 min" is a lie for half its life.
function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function ChatCodeScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const { mode: modeParam } = useLocalSearchParams<{ mode?: string }>();

  const [mode, setMode] = useState<'share' | 'enter'>(modeParam === 'enter' ? 'enter' : 'share');

  // ── share ──
  const [pick, setPick] = useState(OPTIONS[0]);
  const [live, setLive] = useState<ChatCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(0); // seconds

  // ── enter ──
  const [typed, setTyped] = useState('');
  const [joining, setJoining] = useState(false);

  // A live code is readable back from the server, so coming back to this screen
  // inside the two minutes shows the same one instead of quietly minting
  // another and invalidating the code already read out.
  const refresh = useCallback(async () => {
    try {
      const c = await getChatCode();
      setLive(c.active ? c : null);
    } catch {}
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Tick once a second while a code is live, and clear it the moment it dies —
  // a screen still showing digits that stopped working is worse than an empty
  // one, because the owner keeps reading them out.
  const expiresAt = live?.expiresAt;
  const onDead = useRef<() => void>(() => {});
  onDead.current = () => setLive(null);
  useEffect(() => {
    if (!expiresAt) { setLeft(0); return; }
    const tick = () => {
      const s = secondsLeft(expiresAt);
      setLeft(s);
      if (s === 0) onDead.current();
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [expiresAt]);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setLive(await createChatCode({ ttlSeconds: pick.ttl, keepContact: pick.keep }));
    } catch (e: any) {
      Alert.alert('Could not create a code', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  const stop = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await revokeChatCode();
      setLive(null);
    } catch (e: any) {
      Alert.alert('Could not stop the code', e?.message ?? 'Try again.');
    } finally { setBusy(false); }
  };

  // The server applies the code's timer to the chat before answering, so there
  // is nothing to set here — just open it.
  const join = async () => {
    const digits = typed.replace(/\D/g, '');
    if (joining || digits.length !== 6) return;
    setJoining(true);
    try {
      const res = await joinChatCode(digits);
      router.replace({ pathname: '/chat', params: { id: res.chatId } } as any);
    } catch (e: any) {
      Alert.alert('That code did not work', e?.message ?? 'Check it and try again.');
    } finally { setJoining(false); }
  };

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Chat by code</Text>
      </View>

      <View style={S.tabs}>
        {(['share', 'enter'] as const).map(m => (
          <TouchableOpacity
            key={m}
            style={[S.tab, mode === m && S.tabOn]}
            onPress={() => setMode(m)}
            activeOpacity={0.8}>
            <Text style={[S.tabTxt, mode === m && S.tabTxtOn]}>
              {m === 'share' ? 'Share a code' : 'Enter a code'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView contentContainerStyle={S.body} keyboardShouldPersistTaps="handled">
        {mode === 'share' ? (
          <>
            <Text style={S.lede}>
              Read someone these six digits and they can start a chat with you — no phone number
              either way. The code works <Text style={S.strong}>once</Text> and dies after
              {' '}<Text style={S.strong}>two minutes</Text>, so make it while they are with you.
            </Text>

            {live?.code ? (
              <View style={S.codeBox}>
                <Text style={S.code} selectable>{live.code}</Text>
                <View style={S.timerRow}>
                  <Ionicons name="time-outline" size={15} color={left <= 30 ? colors.danger : colors.textDim} />
                  <Text style={[S.timer, left <= 30 && S.timerLow]}>{mmss(left)} left</Text>
                </View>
                <Text style={S.codeSub}>
                  {OPTIONS.find(o => o.ttl === live.ttlSeconds && o.keep === live.keepContact)?.label
                    ?? 'Until I delete'}
                </Text>
                <View style={S.codeActions}>
                  <TouchableOpacity
                    style={S.codeAction}
                    activeOpacity={0.7}
                    onPress={async () => {
                      await Clipboard.setStringAsync(live.code!);
                      Alert.alert('Copied', 'The code is on your clipboard.');
                    }}>
                    <Ionicons name="copy-outline" size={20} color={colors.primary} />
                    <Text style={S.codeActionTxt}>Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={S.codeAction}
                    activeOpacity={0.7}
                    onPress={() => Share.share({ message: `Chat with me on VaultChat. Code: ${live.code} (expires in 2 minutes)` })}>
                    <Ionicons name="share-outline" size={20} color={colors.primary} />
                    <Text style={S.codeActionTxt}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <Text style={S.sectionLabel}>THE CHAT IT OPENS</Text>
                {OPTIONS.map(o => (
                  <TouchableOpacity
                    key={o.key}
                    style={[S.opt, pick.key === o.key && S.optOn]}
                    onPress={() => setPick(o)}
                    activeOpacity={0.8}>
                    <Ionicons
                      name={pick.key === o.key ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={pick.key === o.key ? colors.primary : colors.textFaint}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={S.optLabel}>{o.label}</Text>
                      <Text style={S.optSub}>{o.sub}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </>
            )}

            <TouchableOpacity
              style={[S.cta, busy && S.ctaOff]}
              onPress={generate}
              disabled={busy}
              activeOpacity={0.85}>
              {busy ? <ActivityIndicator color="#fff" />
                    : <Text style={S.ctaTxt}>{live ? 'New code' : 'Generate code'}</Text>}
            </TouchableOpacity>

            {live && (
              <TouchableOpacity style={S.stop} onPress={stop} disabled={busy} activeOpacity={0.7}>
                <Ionicons name="close-circle-outline" size={18} color={colors.danger} />
                <Text style={S.stopTxt}>Stop — nobody can use it</Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <>
            <Text style={S.lede}>
              Type the six digits someone gave you. It opens a normal chat with them — encrypted,
              with calls and files — and neither of you sees the other’s number.
            </Text>

            <TextInput
              style={S.input}
              value={typed}
              onChangeText={t => setTyped(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
              autoFocus
              maxLength={6}
              returnKeyType="go"
              onSubmitEditing={join}
            />
            <Text style={S.hint}>
              Codes expire two minutes after they are made. If it does not work, ask for a new one.
            </Text>

            <TouchableOpacity
              style={[S.cta, (typed.length !== 6 || joining) && S.ctaOff]}
              onPress={join}
              disabled={typed.length !== 6 || joining}
              activeOpacity={0.85}>
              {joining ? <ActivityIndicator color="#fff" /> : <Text style={S.ctaTxt}>Open chat</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },

  tabs: { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 8 },
  tab: { flex: 1, minHeight: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.glassSoft },
  tabOn: { backgroundColor: c.primary },
  tabTxt: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  tabTxtOn: { color: '#fff' },

  body: { paddingHorizontal: 18, paddingBottom: 40 },
  lede: { color: c.textDim, fontSize: 13.5, lineHeight: 20, marginTop: 10 },
  strong: { color: c.text, fontWeight: '800' },
  sectionLabel: { color: c.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 1, paddingTop: 22, paddingBottom: 8 },

  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14, marginBottom: 8, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: 'transparent' },
  optOn: { borderColor: c.primary },
  optLabel: { color: c.text, fontSize: 15.5, fontWeight: '700' },
  optSub: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },

  codeBox: { marginTop: 22, padding: 20, borderRadius: 16, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.accent, alignItems: 'center' },
  code: { color: c.text, fontSize: 46, fontWeight: '800', letterSpacing: 8, fontVariant: ['tabular-nums'] },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  timer: { color: c.textDim, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  timerLow: { color: c.danger },
  codeSub: { color: c.textFaint, fontSize: 12.5, marginTop: 8 },
  codeActions: { flexDirection: 'row', gap: 28, marginTop: 16 },
  codeAction: { alignItems: 'center', gap: 4 },
  codeActionTxt: { color: c.primary, fontSize: 12.5, fontWeight: '700' },

  input: { marginTop: 22, height: 66, borderRadius: 14, backgroundColor: c.glassSoft, color: c.text, fontSize: 34, fontWeight: '800', letterSpacing: 10, textAlign: 'center' },

  cta: { marginTop: 22, height: 50, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: '#fff', fontSize: 16, fontWeight: '800' },

  stop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16 },
  stopTxt: { color: c.danger, fontSize: 13.5, fontWeight: '700' },

  hint: { color: c.textFaint, fontSize: 12, marginTop: 10, lineHeight: 17 },
});
