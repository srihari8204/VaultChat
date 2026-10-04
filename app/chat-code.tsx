// app/chat-code.tsx — the two halves of a chat code: make one, or use one.
//
// A chat code is for the person sitting across from you who is not in your
// address book and is not going to be. You read them six digits, they type them
// in, and you have a normal crazzychat conversation — encryption, calls, files,
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
  AccessibilityInfo, ActivityIndicator, Alert, ScrollView, Share,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  createChatCode, getChatCode, joinChatCode, revokeChatCode, type ChatCode,
} from '../lib/chatService';
import { AuroraBackground, KeyboardSafe } from '../components/ui';
import { HEADER_TOP } from '../constants/layout';

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

// What a screen reader is told as the code runs down. A polite live region on
// the one-second tick made TalkBack speak every second; this changes only at
// these marks.
function countdownMark(s: number): string | null {
  if (s <= 0) return null;
  if (s <= 10) return 'Code expires in 10 seconds';
  if (s <= 30) return 'Code expires in 30 seconds';
  if (s <= 60) return 'Code expires in 1 minute';
  return null;
}

// The share text's "expires in …", from the time actually left.
function expiresIn(s: number): string {
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim();
  return `${s} s`;
}

// The chat-code routes answer with copy written for people ("That code has
// expired or was already used"). Anything without a status is the network or
// the app, whose raw message ("Network request failed") is not.
function codeError(e: any, fallback: string): string {
  return typeof e?.status === 'number' && e?.message ? e.message : fallback;
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
  // A failed read is shown, not swallowed: silently showing "no code" invites
  // minting a new one, which kills a code that may already have been read out.
  const [loadErr, setLoadErr] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const c = await getChatCode();
      setLive(c.active ? c : null);
      setLoadErr(false);
    } catch { setLoadErr(true); }
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

  const mark = countdownMark(left);
  useEffect(() => {
    if (mark) AccessibilityInfo.announceForAccessibility(mark);
  }, [mark]);

  // Synchronous re-entry guards: `busy`/`joining` state lands a render late,
  // so two taps in one frame would mint (and kill) two codes.
  const busyRef = useRef(false);
  const joiningRef = useRef(false);

  const mint = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      setLive(await createChatCode({ ttlSeconds: pick.ttl, keepContact: pick.keep }));
    } catch (e: any) {
      Alert.alert('Could not create a code', codeError(e, 'Check your connection and try again.'));
    } finally { busyRef.current = false; setBusy(false); }
  };

  // A new code kills the live one, which may already have been read out.
  const generate = () => {
    if (!live) { mint(); return; }
    Alert.alert('Replace this code?', 'The current code stops working, even if you have already read it out.', [
      { text: 'Keep it', style: 'cancel' },
      { text: 'New code', style: 'destructive', onPress: mint },
    ]);
  };

  const stop = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await revokeChatCode();
      setLive(null);
    } catch (e: any) {
      Alert.alert('Could not stop the code', codeError(e, 'Check your connection and try again. The code still works until it expires.'));
    } finally { busyRef.current = false; setBusy(false); }
  };

  // The server applies the code's timer to the chat before answering, so there
  // is nothing to set here — just open it.
  const join = async () => {
    const digits = typed.replace(/\D/g, '');
    if (joiningRef.current || digits.length !== 6) return;
    joiningRef.current = true;
    setJoining(true);
    try {
      const res = await joinChatCode(digits);
      router.replace({ pathname: '/chat', params: { id: res.chatId } });
    } catch (e: any) {
      Alert.alert('That code did not work', codeError(e, 'Check your connection and try again.'));
    } finally { joiningRef.current = false; setJoining(false); }
  };

  return (
    <KeyboardSafe style={S.screen} >
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">Chat by code</Text>
      </View>

      <View style={S.tabs}>
        {(['share', 'enter'] as const).map(m => (
          <TouchableOpacity
            key={m}
            style={[S.tab, mode === m && S.tabOn]}
            onPress={() => setMode(m)}
            activeOpacity={0.8}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === m }}>
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

            {loadErr && !live && (
              <TouchableOpacity onPress={refresh} accessibilityRole="button" style={{ paddingVertical: 8 }}>
                <Text style={[S.hint, { color: colors.danger }]}>
                  Could not check for a live code. Tap to try again.
                </Text>
              </TouchableOpacity>
            )}
            {live?.code ? (
              <View style={S.codeBox}>
                <Text style={S.code} selectable>{live.code}</Text>
                <View style={S.timerRow} accessible accessibilityLabel={`${mmss(left)} left`}>
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
                    accessibilityRole="button"
                    accessibilityLabel="Copy code"
                    onPress={async () => {
                      try {
                        await copyAndAutoClear(live.code!);
                        Alert.alert('Copied', 'The code is on your clipboard for 30 seconds.');
                      } catch (e: any) { Alert.alert('Could not copy', e?.message ?? 'Try again.'); }
                    }}>
                    <Ionicons name="copy-outline" size={20} color={colors.primary} />
                    <Text style={S.codeActionTxt}>Copy</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={S.codeAction}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Share code"
                    onPress={() => Share.share({ message: `Chat with me on crazzychat. Code: ${live.code} (expires in ${expiresIn(left)})` })}>
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
                    activeOpacity={0.8}
                    accessibilityRole="radio"
                    accessibilityLabel={`${o.label}. ${o.sub}`}
                    accessibilityState={{ checked: pick.key === o.key }}>
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
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{ disabled: busy, busy }}>
              {busy ? <ActivityIndicator color={colors.onPrimary} />
                    : <Text style={S.ctaTxt}>{live ? 'New code' : 'Generate code'}</Text>}
            </TouchableOpacity>

            {live && (
              <TouchableOpacity style={S.stop} onPress={stop} disabled={busy} activeOpacity={0.7} accessibilityRole="button" accessibilityState={{ disabled: busy }}>
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
              accessibilityLabel="Six-digit chat code"
              onSubmitEditing={join}
            />
            <Text style={S.hint}>
              Codes expire two minutes after they are made. If it does not work, ask for a new one.
            </Text>

            <TouchableOpacity
              style={[S.cta, (typed.length !== 6 || joining) && S.ctaOff]}
              onPress={join}
              disabled={typed.length !== 6 || joining}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{ disabled: typed.length !== 6 || joining, busy: joining }}>
              {joining ? <ActivityIndicator color={colors.onPrimary} /> : <Text style={S.ctaTxt}>Open chat</Text>}
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </KeyboardSafe>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8 },
  backBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { color: c.text, fontSize: 20, fontWeight: '800' },

  tabs: { flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 8 },
  tab: { flex: 1, minHeight: 44, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: c.glassSoft },
  tabOn: { backgroundColor: c.primary },
  tabTxt: { color: c.textDim, fontSize: 14, fontWeight: '700' },
  tabTxtOn: { color: c.onPrimary },

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
  codeAction: { alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 56, minHeight: 48 },
  codeActionTxt: { color: c.primary, fontSize: 12.5, fontWeight: '700' },

  // 2026-09-18: minHeight on both — a 34sp code field and a 16sp button pinned
  // to a fixed box clip once the OS font scale is turned up. The padding is
  // sized so content + 2×10 still sits inside the old 66 / 50 at scale 1.0,
  // so nothing moves there.
  input: { marginTop: 22, minHeight: 66, paddingVertical: 10, borderRadius: 14, backgroundColor: c.glassSoft, color: c.text, fontSize: 34, fontWeight: '800', letterSpacing: 10, textAlign: 'center' },

  cta: { marginTop: 22, minHeight: 50, paddingVertical: 10, borderRadius: 14, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' },
  ctaOff: { opacity: 0.4 },
  ctaTxt: { color: c.onPrimary, fontSize: 16, fontWeight: '800' },

  stop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, minHeight: 44 },
  stopTxt: { color: c.danger, fontSize: 13.5, fontWeight: '700' },

  hint: { color: c.textFaint, fontSize: 12, marginTop: 10, lineHeight: 17 },
});
