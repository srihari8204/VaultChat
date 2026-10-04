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
// SKIPPING IS SAFE AND SAYS SO. The backup is not consumed by being declined —
// it stays on the server, and Settings → Chat backup can restore it later. A
// restore prompt that implies "now or never" pressures people into a slow
// operation on mobile data at the worst moment.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { HEADER_TOP } from '../constants/layout';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { AuroraBackground } from '../components/ui';
import {
  cloudBackupMeta, restoreCloudBackup, restoreFromGoogleDrive, type BackupMeta,
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

  useEffect(() => { cloudBackupMeta().then(setMeta).catch(() => setMeta({ exists: false })); }, []);

  // Leaving — by any route — must mark the prompt seen, or a user who skips is
  // asked again on the next cold start, which reads as the app nagging.
  const leave = useCallback(async () => {
    await markRestorePromptSeen();
    // resetTo: replays a launch deep link stashed before sign-in
    // (lib/postSignIn.ts deliberately leaves it in place on the way here).
    resetTo('/(tabs)/chats');
  }, []);

  const run = useCallback(async (from: 'cloud' | 'drive') => {
    if (busy) return;
    setBusy(from);
    try {
      const n = from === 'cloud' ? await restoreCloudBackup() : await restoreFromGoogleDrive();
      setRestored(n);
      await markRestorePromptSeen();
    } catch (e: any) {
      setBusy(null);
      // Named plainly: the two real causes are "there isn't one" and "the
      // network went away mid-download", and the user can act on both.
      Alert.alert(
        'Could not restore',
        e?.message?.includes('No backup')
          ? 'No backup was found for this account.'
          : `${e?.message ?? 'Something went wrong.'}\n\nYour backup is untouched — you can try again from Settings → Chat backup.`,
      );
      return;
    }
    setBusy(null);
  }, [busy]);

  if (restored !== null) {
    return (
      <View style={S.screen}>
        <AuroraBackground />
        <View style={S.done}>
          <Ionicons name="checkmark-circle" size={64} color={colors.success} />
          <Text style={S.doneTitle}>Chats restored</Text>
          <Text style={S.doneSub}>
            {restored > 0
              ? `${restored.toLocaleString()} message${restored === 1 ? '' : 's'} are back on this phone.`
              : 'Your backup was applied.'}
          </Text>
          <TouchableOpacity style={S.cta} onPress={leave} activeOpacity={0.85}>
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
        <View style={S.badge}><Ionicons name="cloud-download-outline" size={34} color={colors.primary} /></View>

        <Text style={S.title}>Restore your chats</Text>
        <Text style={S.lede}>
          {meta === null
            ? 'Looking for a backup…'
            : meta.exists
              ? 'We found a backup for this account. Restoring brings your messages and media onto this phone.'
              : 'No backup was found for this account. You can carry on — new messages will be backed up from here.'}
        </Text>

        {meta?.exists && (
          <View style={S.card}>
            <Row label="Messages" value={meta.messageCount ? meta.messageCount.toLocaleString() : '—'} S={S} />
            <Row label="Size" value={humanSize(meta.sizeBytes) || '—'} S={S} />
            <Row label="Last backed up" value={humanWhen(meta.updatedAt) || '—'} S={S} last />
          </View>
        )}

        {meta?.exists && (
          <>
            <TouchableOpacity
              style={[S.cta, !!busy && S.ctaOff]}
              onPress={() => run('cloud')}
              disabled={!!busy}
              activeOpacity={0.85}
            >
              {busy === 'cloud'
                ? <ActivityIndicator color="#fff" />
                : <Text style={S.ctaTxt}>Restore now</Text>}
            </TouchableOpacity>

            <TouchableOpacity
              style={[S.secondary, !!busy && S.ctaOff]}
              onPress={() => run('drive')}
              disabled={!!busy}
              activeOpacity={0.8}
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

        <TouchableOpacity style={S.skip} onPress={leave} disabled={!!busy} activeOpacity={0.7}>
          <Text style={S.skipTxt}>{meta?.exists ? 'Not now' : 'Continue'}</Text>
        </TouchableOpacity>

        {meta?.exists && (
          <Text style={S.reassure}>
            Skipping changes nothing — your backup stays where it is, and Settings → Chat backup
            can restore it whenever you like.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function Row({ label, value, S, last }: { label: string; value: string; S: any; last?: boolean }) {
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
  ctaTxt: { color: '#fff', fontSize: 16.5, fontWeight: '800' },

  secondary: {
    width: '100%', minHeight: 48, borderRadius: 14, marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke,
    alignItems: 'center', justifyContent: 'center', paddingVertical: 10,
  },
  secondaryTxt: { color: c.text, fontSize: 14.5, fontWeight: '600' },

  note: { color: c.textFaint, fontSize: 12.5, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  skip: { marginTop: 22, paddingVertical: 10, paddingHorizontal: 20 },
  skipTxt: { color: c.textDim, fontSize: 15, fontWeight: '600' },
  reassure: {
    color: c.textFaint, fontSize: 12.5, lineHeight: 17, textAlign: 'center',
    marginTop: 6, maxWidth: 330,
  },

  done: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  doneTitle: { color: c.text, fontSize: 24, fontWeight: '800', marginTop: 6 },
  doneSub: { color: c.textDim, fontSize: 15, textAlign: 'center', marginBottom: 18 },
});
