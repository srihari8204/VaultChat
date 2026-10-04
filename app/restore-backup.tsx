// app/restore-backup.tsx — "we found your chats" on a new phone.
//
// WHY THIS SCREEN EXISTS
// ----------------------
// Everything needed to restore was already here: cloudBackupMeta() says whether
// a backup exists, restoreCloudBackup() / restoreFromGoogleDrive() apply it.
// What was missing is the MOMENT — nothing ever offered it. So replacing a
// handset meant either knowing about a settings screen in advance or silently
// losing the history, and a messenger that loses your chats when you upgrade
// your phone does not get a second chance.
//
// This is shown exactly once per install, at the one point where the answer is
// unambiguous: signed in, and this device has no messages of its own. Both
// halves matter. Offering a restore to someone who already has their chats here
// risks overwriting newer local history with an older backup; offering it before
// sign-in is impossible, because the backup is account-scoped.
//
// SKIPPING IS SAFE, AND SAYS WHAT IT COSTS. The backup is not consumed by being
// declined — it stays on the server, and Settings → Chat backup can restore it
// later. A restore prompt that implies "now or never" pressures people into a
// slow operation on mobile data at the worst moment.
//
// It used to say "Skipping changes nothing" while the scheduler, due at once on
// a fresh install, uploaded the near-empty phone over that backup seconds
// later. Showing this screen now marks the restore decision pending
// (lib/cloudBackup): until the user restores, or explicitly chooses "Start
// fresh" after being told the next backup replaces the online copy, this phone
// uploads nothing. "Skip for now" keeps it that way, and says so.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { HEADER_TOP } from '../constants/layout';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui';
import {
  cloudBackupMeta, isSecretRequired, restoreCloudBackup, restoreFromGoogleDrive, type BackupMeta,
  markRestoreDecisionPending, resolveRestoreDecision, hasRestoreDecisionFlag, restoreDecisionPending,
} from '../lib/cloudBackup';
import { markRestorePromptSeen } from '../lib/restoreGate';
import { resetTo } from '../lib/authNav';

function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function humanWhen(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function RestoreBackupScreen() {
  const { colors } = useTheme();
  const S = useS();

  const [meta, setMeta] = useState<BackupMeta | null>(null);
  const [busy, setBusy] = useState<null | 'cloud' | 'drive'>(null);
  const [restored, setRestored] = useState<number | null>(null);
  // Restored from Google Drive: the account copy was not restored and may be
  // newer, so automatic backup stays paused (lib/restoreDecision D2).
  const [stillPaused, setStillPaused] = useState(false);
  // A restore can finish after the screen is gone (resetTo from elsewhere).
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Sent to Chat backup for an encrypted restore: on the way back, a cleared
  // restore-decision flag means the backup was restored (or replaced) there,
  // so this screen offers Continue instead of "Restore now" again.
  const [handledElsewhere, setHandledElsewhere] = useState(false);
  const sentToChatBackup = useRef(false);
  useFocusEffect(useCallback(() => {
    if (!sentToChatBackup.current) return;
    sentToChatBackup.current = false;
    hasRestoreDecisionFlag()
      .then((pending) => { if (!pending && alive.current) setHandledElsewhere(true); })
      .catch(() => {});
  }, []));

  // `unavailable` means the lookup failed — NOT "no backup". Showing "No
  // backup was found" for a dead connection invited the user to carry on and
  // lose a backup that exists; offer a retry instead.
  //
  // A real "no backup" answer may settle the restore decision — once a linked
  // Google Drive has been asked too (lib/restoreDecision D3).
  const lookUp = useCallback(() => {
    setMeta(null);
    cloudBackupMeta()
      .then((m) => {
        if (!m.exists && !m.unavailable) restoreDecisionPending(m).catch(() => {});
        if (alive.current) setMeta(m);
      })
      .catch(() => { if (alive.current) setMeta({ exists: false, unavailable: true }); });
  }, []);
  // Marked before the lookup, so its "no backup" answer is what clears it.
  // A failed write is retried once; if storage still refuses, uploads stay
  // gated anyway: restoreDecisionPending asks the server for any install that
  // has not settled the decision, and fails closed when storage can't be read.
  useEffect(() => {
    markRestoreDecisionPending().catch(() => markRestoreDecisionPending()).catch(() => {}).finally(lookUp);
  }, [lookUp]);
  const lookupFailed = !!meta?.unavailable;

  // Leaving after a real answer marks the prompt seen, or a user who skips is
  // asked again on the next cold start, which reads as the app nagging. NOT
  // after a failed or unfinished lookup: someone who was offline never saw
  // whether a backup exists, so they are offered it again next launch.
  const answered = meta !== null && !meta.unavailable;
  const leave = useCallback(async () => {
    if (answered) await markRestorePromptSeen();
    // resetTo: replays a launch deep link stashed before sign-in
    // (lib/postSignIn.ts deliberately leaves it in place on the way here).
    resetTo('/(tabs)/chats');
  }, [answered]);

  // Declining a backup that exists: say what each choice does to it.
  const skip = useCallback(() => {
    if (!meta?.exists) { leave(); return; }
    const what = meta.messageCount ? ` (${meta.messageCount.toLocaleString()} messages)` : '';
    Alert.alert(
      'Skip restoring?',
      `Your online backup${what} stays as it is. To keep it safe, this phone won't back up until you restore it or choose to replace it — both from Settings → Chat backup.`
      + "\n\nStart fresh if you don't need those chats: this phone's next backup replaces the online copy, and that can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Start fresh', style: 'destructive', onPress: () => {
            // If this fails the decision stays pending, which is the safe side.
            resolveRestoreDecision().catch(() => {}).finally(leave);
          } },
        { text: 'Skip for now', onPress: leave },
      ],
    );
  }, [meta, leave]);

  // A ref, not `busy`: two taps in one frame both read busy === null from the
  // same render and started two restores.
  const inFlight = useRef(false);
  const run = useCallback(async (from: 'cloud' | 'drive') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(from);
    try {
      const n = from === 'cloud' ? await restoreCloudBackup() : await restoreFromGoogleDrive();
      await markRestorePromptSeen();
      const paused = from === 'drive' && await hasRestoreDecisionFlag().catch(() => true);
      if (!alive.current) return;
      setStillPaused(paused);
      setRestored(n);
    } catch (e) {
      inFlight.current = false;
      if (!alive.current) return;
      setBusy(null);
      // An end-to-end encrypted backup needs its password or key, which this
      // screen does not ask for; Chat backup's restore does.
      if (isSecretRequired(e)) {
        Alert.alert(
          'Your backup is end-to-end encrypted',
          `Restore it from Settings → Chat backup → Restore, with the ${e.mode === 'key' ? '64-character key' : 'backup password'} you set.`,
          [{ text: 'Later', style: 'cancel' }, { text: 'Open Chat backup', onPress: () => { sentToChatBackup.current = true; router.push('/chat-backup'); } }],
        );
        return;
      }
      // Named plainly: the two real causes are "there isn't one" and "the
      // network went away mid-download", and the user can act on both.
      // Mapped, not the raw error text.
      const msg = String((e as { message?: unknown } | null)?.message ?? '');
      Alert.alert(
        'Could not restore',
        msg.includes('No backup')
          ? 'No backup was found for this account.'
          : `${/network|abort|timed? ?out/i.test(msg) ? 'The connection dropped during the restore.' : 'The restore did not finish.'}\n\nYour backup is untouched — try again, or later from Settings → Chat backup.`,
      );
      return;
    }
    inFlight.current = false;
    if (alive.current) setBusy(null);
  }, []);

  if (restored !== null || handledElsewhere) {
    return (
      <View style={S.screen}>
        <AuroraBackground />
        <View style={S.done}>
          <Ionicons name="checkmark-circle" size={64} color={colors.success} />
          <Text style={S.doneTitle} accessibilityRole="header">{restored !== null ? 'Chats restored' : 'Backup settled'}</Text>
          <Text style={S.doneSub}>
            {restored === null
              ? 'Your backup was restored or replaced in Chat backup.'
              : restored > 0
                ? `${restored.toLocaleString()} message${restored === 1 ? '' : 's'} are back on this phone.`
                : 'Your backup was applied.'}
            {stillPaused
              ? '\n\nThat was the Google Drive copy. The backup in your account may be newer, so automatic backup stays paused until you restore it or choose to replace it, from Settings → Chat backup.'
              : ''}
          </Text>
          <TouchableOpacity style={S.cta} onPress={leave} activeOpacity={0.85} accessibilityRole="button">
            <Text style={S.ctaTxt}>Continue</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <ScrollView contentContainerStyle={S.body}>
        <View style={S.badge} accessibilityElementsHidden importantForAccessibility="no"><Ionicons name="cloud-download-outline" size={34} color={colors.primary} /></View>

        <Text style={S.title} accessibilityRole="header">Restore your chats</Text>
        <Text style={S.lede} accessibilityLiveRegion="polite">
          {meta === null
            ? 'Looking for a backup…'
            : lookupFailed
              ? 'Couldn’t check for a backup — you may be offline. Try again, or carry on: while this phone has no chats yet, crazzychat offers this again the next time it opens, and you can restore any time from Settings → Chat backup. Until it can check, this phone won’t back up over a backup it hasn’t seen.'
            : meta.exists
              // ponytail: the backup meta does not say whether the backup is
              // end-to-end encrypted (lib/cloudBackup BackupMeta has no mode), so
              // this names the case up front for everyone; show it only for an
              // e2ee backup once the server meta carries the mode.
              ? 'We found a backup for this account. Restoring brings your messages and media onto this phone. If you protected it with a backup password or 64-character key, restore it from Settings → Chat backup, where you can enter it.'
              : 'No backup was found for this account. You can carry on — new messages will be backed up from here.'}
        </Text>

        {meta?.exists && (
          <View style={S.card}>
            <Row label="Messages" value={meta.messageCount ? meta.messageCount.toLocaleString() : '—'} S={S} />
            <Row label="Size" value={humanSize(meta.sizeBytes) || '—'} S={S} />
            <Row label="Last backed up" value={humanWhen(meta.updatedAt) || '—'} S={S} last />
          </View>
        )}

        {lookupFailed && (
          <TouchableOpacity style={S.cta} onPress={lookUp} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Try again to check for a backup">
            <Text style={S.ctaTxt}>Try again</Text>
          </TouchableOpacity>
        )}

        {meta?.exists && (
          <>
            <TouchableOpacity
              style={[S.cta, !!busy && S.ctaOff]}
              onPress={() => run('cloud')}
              disabled={!!busy}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!busy, busy: busy === 'cloud' }}
            >
              {busy === 'cloud'
                ? <ActivityIndicator color={colors.onPrimary} />
                : <Text style={S.ctaTxt}>Restore now</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[S.secondary, !!busy && S.ctaOff]}
              onPress={() => run('drive')}
              disabled={!!busy}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityState={{ disabled: !!busy, busy: busy === 'drive' }}
            >
              {busy === 'drive'
                ? <ActivityIndicator color={colors.text} />
                : <Text style={S.secondaryTxt}>Restore from Google Drive instead</Text>}
            </TouchableOpacity>

            <Text style={S.note}>
              This can take a few minutes on a large backup. Wi-Fi is kinder to your data plan.
            </Text>
          </>
        )}

        <TouchableOpacity
          style={S.skip}
          onPress={skip}
          disabled={!!busy}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityState={{ disabled: !!busy }}
        >
          <Text style={S.skipTxt}>{meta?.exists ? 'Not now' : 'Continue'}</Text>
        </TouchableOpacity>

        {meta?.exists && (
          <Text style={S.reassure}>
            Skipping keeps your backup where it is: this phone won’t back up over it until you
            restore it or choose to replace it, from Settings → Chat backup.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function Row({ label, value, S, last }: { label: string; value: string; S: ReturnType<typeof makeStyles>; last?: boolean }) {
  return (
    <View style={[S.row, last && { borderBottomWidth: 0 }]}>
      <Text style={S.rowLabel}>{label}</Text>
      <Text style={S.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  body: { paddingHorizontal: 24, paddingTop: HEADER_TOP + 40, paddingBottom: 48, alignItems: 'center' },

  badge: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: c.glassSoft,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  title: { color: c.text, fontSize: 24, fontWeight: '800', textAlign: 'center', marginBottom: 10 },
  lede: { color: c.textDim, fontSize: 15, lineHeight: 21, textAlign: 'center', marginBottom: 26, maxWidth: 340 },

  card: {
    width: '100%', backgroundColor: c.glassSoft, borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, marginBottom: 24,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 13, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hairline,
  },
  rowLabel: { color: c.textDim, fontSize: 14 },
  rowValue: { color: c.text, fontSize: 15, fontWeight: '700', flexShrink: 1, fontVariant: ['tabular-nums'] },

  cta: {
    width: '100%', minHeight: 52, borderRadius: 14, backgroundColor: c.primary,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 12,
  },
  ctaOff: { opacity: 0.45 },
  ctaTxt: { color: c.onPrimary, fontSize: 16.5, fontWeight: '800' },

  secondary: {
    width: '100%', minHeight: 48, borderRadius: 14, marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 10,
  },
  secondaryTxt: { color: c.text, fontSize: 14.5, fontWeight: '600' },

  note: { color: c.textFaint, fontSize: 12.5, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  skip: { marginTop: 22, paddingVertical: 10, paddingHorizontal: 20, minHeight: 44, justifyContent: 'center' },
  skipTxt: { color: c.textDim, fontSize: 15, fontWeight: '600' },
  reassure: {
    color: c.textFaint, fontSize: 12.5, lineHeight: 17, textAlign: 'center',
    marginTop: 6, maxWidth: 330,
  },

  done: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  doneTitle: { color: c.text, fontSize: 24, fontWeight: '800', marginTop: 6 },
  doneSub: { color: c.textDim, fontSize: 15, textAlign: 'center', marginBottom: 18 },
});
