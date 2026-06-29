// app/settings.tsx — Day 11 privacy / settings screen.
//
// Backed by:
//   GET  /user/settings   { discoverable, lastSeenVisible, readReceipts, profilePhotoVisible }
//   PUT  /user/settings   (any subset of the above as a Partial<UserSettings>)
//   GET  /user/blocks     [{ userId, name, email, photoURL, createdAt }]
//   DELETE /user/blocks/:userId
//
// No Firebase, no Firestore — pure Postgres + JWT.

import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { isMfaEnabled, enableMfa, disableMfa } from '../lib/mfa';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { logoutUser } from './(constants)/authService';
import { api, getAccessToken } from '../lib/api';
import { getAutoDownload, setAutoDownload, type AutoDownloadPolicy } from '../lib/mediaPrefs';
import { useTheme, type ThemePref } from '../lib/theme';
import { type Palette, brandAlpha } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';

/** Memoized themed stylesheet for this screen. */
function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}
import {
  attachmentUrl,
  deleteAccount,
  exportMyData,
  getSettings,
  listBlocks,
  unblockUser,
  updateSettings,
  type BlockedUser,
  type UserSettings,
} from '../lib/chatService';
import { unregisterPushToken } from '../lib/push';
import { disconnect as disconnectSocket } from '../lib/socket';

export default function SettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const S = useS();

  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [blocks,   setBlocks]   = useState<BlockedUser[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState<null | keyof UserSettings>(null);
  const [authHeader, setAuthHeader] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ name?: string; email?: string; status?: string; photoURL?: string } | null>(null);
  const [autoDl, setAutoDl] = useState<AutoDownloadPolicy>('always');
  useEffect(() => { getAutoDownload().then(setAutoDl); }, []);
  const autoDlLabel = (p: AutoDownloadPolicy) => p === 'never' ? 'Never' : p === 'wifi' ? 'Wi-Fi only' : 'Wi-Fi & mobile data';

  // Initial fetch — settings + blocks in parallel + auth header + profile
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [s, b, tok, p] = await Promise.all([
          getSettings(), listBlocks(), getAccessToken(),
          api<{ name?: string; email?: string; status?: string; photoURL?: string }>('/user/profile').catch(() => null),
        ]);
        if (cancel) return;
        setSettings(s);
        setBlocks(b);
        setAuthHeader(tok ? `Bearer ${tok}` : null);
        setProfile(p);
      } catch (e: any) {
        Alert.alert('Could not load settings', e?.message ?? 'Try again');
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  // Toggle one flag — optimistic, with rollback on failure.
  const toggle = useCallback(async (key: keyof UserSettings) => {
    if (!settings || saving) return;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    setSaving(key);
    try {
      await updateSettings({ [key]: next[key] });
    } catch (e: any) {
      setSettings(settings); // rollback
      Alert.alert('Save failed', e?.message ?? 'Try again');
    } finally {
      setSaving(null);
    }
  }, [settings, saving]);

  // Non-boolean settings (group-add policy, default timer) — optimistic save.
  const savePref = useCallback(async (patch: Partial<UserSettings>) => {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...settings, ...patch });
    try { await updateSettings(patch); }
    catch (e: any) { setSettings(prev); Alert.alert('Save failed', e?.message ?? 'Try again'); }
  }, [settings]);

  const groupAddLabel = (p?: string) => p === 'nobody' ? 'Nobody' : p === 'contacts' ? 'My contacts' : 'Everyone';
  const timerLabel = (s?: number) => !s ? 'Off' : s >= 7776000 ? '90 days' : s >= 604800 ? '7 days' : s >= 86400 ? '24 hours' : `${Math.round(s / 60)} min`;

  const [exporting, setExporting] = useState(false);
  const [deleting,  setDeleting]  = useState(false);

  // Device MFA (biometric / device PIN) — local + server mirror.
  const [mfaOn,   setMfaOn]   = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);
  useEffect(() => { isMfaEnabled().then(setMfaOn); }, []);
  const toggleMfa = useCallback(async () => {
    if (mfaBusy) return;
    setMfaBusy(true);
    try {
      if (mfaOn) { await disableMfa(); setMfaOn(false); }
      else {
        const ok = await enableMfa();
        if (ok) setMfaOn(true);
        else Alert.alert('Could not enable', 'No device biometrics/PIN found, or the prompt was dismissed.');
      }
    } catch { Alert.alert('Error', 'Could not update MFA.'); }
    finally { setMfaBusy(false); }
  }, [mfaOn, mfaBusy]);

  // GDPR export → write to cache → share sheet (user picks where to save).
  const onExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const json = await exportMyData();
      const fname = `vaultchat-export-${Date.now()}.json`;
      const dest  = `${(FileSystem as any).cacheDirectory}${fname}`;
      await (FileSystem as any).writeAsStringAsync(dest, json, { encoding: 'utf8' });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dest, { mimeType: 'application/json', dialogTitle: 'Save your VaultChat data' });
      } else {
        Alert.alert('Saved', `Export saved to ${dest}`);
      }
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? 'Try again');
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  // Delete account → confirm twice → soft-delete server-side → sign out.
  const onDeleteAccount = useCallback(() => {
    if (deleting) return;
    Alert.alert(
      'Delete account?',
      'This will permanently disable your VaultChat account. Existing chat history with other members remains on their devices but you will no longer be reachable.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => {
            Alert.alert(
              'Are you absolutely sure?',
              'This cannot be undone.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Yes, delete', style: 'destructive', onPress: async () => {
                    setDeleting(true);
                    try {
                      await deleteAccount();
                      try { await unregisterPushToken(); } catch {}
                      try { disconnectSocket(); } catch {}
                      await logoutUser();
                      router.replace('/onboard' as any);
                    } catch (e: any) {
                      setDeleting(false);
                      Alert.alert('Delete failed', e?.message ?? 'Try again');
                    }
                  }
                },
              ],
            );
          }
        },
      ],
    );
  }, [deleting, router]);

  const onUnblock = useCallback((u: BlockedUser) => {
    Alert.alert('Unblock?', `${u.name || u.email || 'This user'} will be able to message you again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unblock', style: 'destructive', onPress: async () => {
          try {
            await unblockUser(u.userId);
            setBlocks(prev => prev.filter(x => x.userId !== u.userId));
          } catch (e: any) {
            Alert.alert('Could not unblock', e?.message ?? 'Try again');
          }
        }
      },
    ]);
  }, []);

  if (loading || !settings) {
    return (
      <View style={[S.screen, S.center]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 64 }}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Settings</Text>
      </View>

      {/* Profile card (WhatsApp-style) — avatar + name + about + QR */}
      <TouchableOpacity style={S.profileCard} activeOpacity={0.8} onPress={() => router.push('/(tabs)/profile' as any)}>
        <View style={S.profileAvatar}>
          {profile?.photoURL && authHeader ? (
            <Image source={{ uri: attachmentUrl(profile.photoURL), headers: { Authorization: authHeader } }} style={S.profileAvatarImg} />
          ) : (
            <Text style={S.profileAvatarTxt}>{(profile?.name || profile?.email || '?').trim()[0].toUpperCase()}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={S.profileName} numberOfLines={1}>{profile?.name || 'Your name'}</Text>
          <Text style={S.profileSub} numberOfLines={1}>{profile?.status || profile?.email || ''}</Text>
        </View>
        <Ionicons name="qr-code-outline" size={22} color={colors.textDim} />
      </TouchableOpacity>

      <AppearanceSection />

      <View style={S.section}>
        <Text style={S.label}>CHATS</Text>
        <View style={S.linkCard}>
          <LinkRow icon="color-palette-outline" title="Bubble theme" sub="Color of your sent messages" onPress={() => router.push('/chat-themes' as any)} />
          <LinkRow icon="image-outline" title="Wallpaper" sub="Default chat background" onPress={() => router.push('/chat-wallpaper' as any)} />
          <TouchableOpacity style={[S.linkRow, { borderBottomWidth: 0 }]} activeOpacity={0.7} onPress={() => Alert.alert('Media auto-download', 'When to download photos automatically.', [
            { text: 'Wi-Fi & mobile data', onPress: () => { setAutoDl('always'); setAutoDownload('always'); } },
            { text: 'Wi-Fi only', onPress: () => { setAutoDl('wifi'); setAutoDownload('wifi'); } },
            { text: 'Never', onPress: () => { setAutoDl('never'); setAutoDownload('never'); } },
            { text: 'Cancel', style: 'cancel' },
          ])}>
            <View style={S.linkIconWrap}><Ionicons name="cloud-download-outline" size={22} color={colors.text} /></View>
            <View style={{ flex: 1 }}>
              <Text style={S.linkTitle}>Media auto-download</Text>
              <Text style={S.linkSub}>{autoDlLabel(autoDl)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={S.section}>
        <Text style={S.label}>PRIVACY</Text>

        <ToggleRow
          title="Discoverable by phone"
          sub="Allow others who have your number to find your VaultChat account when they tap Contacts."
          value={settings.discoverable}
          busy={saving === 'discoverable'}
          onValueChange={() => toggle('discoverable')}
        />
        <ToggleRow
          title="Show last seen"
          sub="Other users will see when you were last online."
          value={settings.lastSeenVisible}
          busy={saving === 'lastSeenVisible'}
          onValueChange={() => toggle('lastSeenVisible')}
        />
        <ToggleRow
          title="Send read receipts"
          sub="Senders see ✓✓ blue when you read their message."
          value={settings.readReceipts}
          busy={saving === 'readReceipts'}
          onValueChange={() => toggle('readReceipts')}
        />
        <ToggleRow
          title="Show profile photo to everyone"
          sub="When off, only people you've chatted with see your photo."
          value={settings.profilePhotoVisible}
          busy={saving === 'profilePhotoVisible'}
          onValueChange={() => toggle('profilePhotoVisible')}
        />
        <TouchableOpacity style={S.prefRow} activeOpacity={0.7} onPress={() => Alert.alert('Who can add me to groups', undefined, [
          { text: 'Everyone', onPress: () => savePref({ groupAddPolicy: 'everyone' }) },
          { text: 'My contacts', onPress: () => savePref({ groupAddPolicy: 'contacts' }) },
          { text: 'Nobody', onPress: () => savePref({ groupAddPolicy: 'nobody' }) },
          { text: 'Cancel', style: 'cancel' },
        ])}>
          <View style={{ flex: 1 }}>
            <Text style={S.toggleTitle}>Add me to groups</Text>
            <Text style={S.toggleSub}>{groupAddLabel(settings.groupAddPolicy)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity style={S.prefRow} activeOpacity={0.7} onPress={() => Alert.alert('Default disappearing timer', 'Applied to new chats you start.', [
          { text: 'Off', onPress: () => savePref({ defaultDisappearingSeconds: 0 }) },
          { text: '24 hours', onPress: () => savePref({ defaultDisappearingSeconds: 86400 }) },
          { text: '7 days', onPress: () => savePref({ defaultDisappearingSeconds: 604800 }) },
          { text: '90 days', onPress: () => savePref({ defaultDisappearingSeconds: 7776000 }) },
          { text: 'Cancel', style: 'cancel' },
        ])}>
          <View style={{ flex: 1 }}>
            <Text style={S.toggleTitle}>Default message timer</Text>
            <Text style={S.toggleSub}>{timerLabel(settings.defaultDisappearingSeconds)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      </View>

      <View style={S.section}>
        <Text style={S.label}>SECURITY</Text>
        <ToggleRow
          title="Device MFA (PIN / fingerprint / face)"
          sub="Require your device biometrics or MPIN each time VaultChat launches."
          value={mfaOn}
          busy={mfaBusy}
          onValueChange={toggleMfa}
        />
      </View>

      <View style={S.section}>
        <Text style={S.label}>DATA & ACCOUNT</Text>
        <View style={S.linkCard}>
          <LinkRow icon="notifications-outline" title="Notifications & Sounds" sub="Message tones, ringtone, vibration" onPress={() => router.push('/notification-sounds' as any)} />
          <LinkRow icon="call-outline" title="Call reliability" sub="Make calls ring when the app is closed" onPress={() => router.push('/call-reliability' as any)} />
          <LinkRow icon="cloud-upload-outline" title="Chat backup" sub="Encrypted backup to cloud or file" onPress={() => router.push('/chat-backup' as any)} />
          <LinkRow icon="time-outline" title="Scheduled messages" sub="Messages waiting to send later" onPress={() => router.push('/scheduled' as any)} />
          <LinkRow icon="bookmark-outline" title="Bookmarks" sub="Messages you've saved across chats" onPress={() => router.push('/bookmarks' as any)} />
          <LinkRow icon="alarm-outline" title="Message reminders" sub="Notifications you've scheduled" onPress={() => router.push('/message-reminder' as any)} />
          <LinkRow icon="eye-off-outline" title="Hidden chats" sub="PIN-gated chats, hidden from the list" onPress={() => router.push('/hidden-chats' as any)} />
          <LinkRow icon="desktop-outline" title="Active devices" sub="Where you're signed in" onPress={() => router.push('/login-history' as any)} />
          <LinkRow icon="glasses-outline" title="Ghost Mode contacts" sub="Hidden online, typing, read, last-seen" onPress={() => router.push('/ghost-mode' as any)} />
          <LinkRow icon="download-outline" title="Export my data" sub="Download a JSON of your account" onPress={onExport} busy={exporting} last />
        </View>

        <TouchableOpacity
          style={S.deleteBtn}
          onPress={onDeleteAccount}
          disabled={deleting}
          activeOpacity={0.85}
        >
          {deleting ? <ActivityIndicator color={colors.danger} /> : (
            <Text style={S.deleteBtnTxt}>Delete my account</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={S.section}>
        <Text style={S.label}>BLOCKED USERS</Text>
        {blocks.length === 0 ? (
          <Text style={S.emptySub}>You haven't blocked anyone. To block someone, open their chat → menu → Block.</Text>
        ) : (
          blocks.map(u => (
            <View key={u.userId} style={S.blockRow}>
              <View style={S.blockAvatar}>
                {u.photoURL && authHeader ? (
                  <Image
                    source={{ uri: attachmentUrl(u.photoURL), headers: { Authorization: authHeader } }}
                    style={S.blockAvatarImg}
                  />
                ) : (
                  <Text style={S.blockAvatarTxt}>{(u.name || u.email || '?').trim()[0].toUpperCase()}</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.blockName} numberOfLines={1}>{u.name || u.email || u.userId.slice(0, 8)}</Text>
                {u.email && u.name && <Text style={S.blockEmail} numberOfLines={1}>{u.email}</Text>}
              </View>
              <TouchableOpacity onPress={() => onUnblock(u)} style={S.unblockBtn} activeOpacity={0.7}>
                <Text style={S.unblockTxt}>Unblock</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

// WhatsApp-style settings row: tinted leading icon, title + sub, chevron.
function LinkRow({ icon, title, sub, onPress, busy, last }: {
  icon: React.ComponentProps<typeof Ionicons>['name']; title: string; sub?: string;
  onPress?: () => void; busy?: boolean; last?: boolean;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <TouchableOpacity style={[S.linkRow, last && { borderBottomWidth: 0 }]} onPress={onPress} activeOpacity={0.7} disabled={busy}>
      <View style={S.linkIconWrap}><Ionicons name={icon} size={22} color={colors.text} /></View>
      <View style={{ flex: 1 }}>
        <Text style={S.linkTitle} numberOfLines={1}>{title}</Text>
        {sub ? <Text style={S.linkSub} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {busy ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="chevron-forward" size={18} color={colors.textDim} />}
    </TouchableOpacity>
  );
}

// Appearance (U3) — Light / Dark / System, persisted via the ThemeProvider.
// The control itself is theme-aware so the chosen palette previews live.
function AppearanceSection() {
  const { pref, setPref, colors, scheme } = useTheme();
  const S = useS();
  const opts: { key: ThemePref; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
    { key: 'system', label: 'System', icon: 'phone-portrait-outline' },
    { key: 'light',  label: 'Light',  icon: 'sunny-outline' },
    { key: 'dark',   label: 'Dark',   icon: 'moon-outline' },
  ];
  return (
    <View style={S.section}>
      <Text style={S.label}>APPEARANCE</Text>
      <View style={[apS.row, { backgroundColor: colors.surfaceSolid, borderColor: colors.border }]}>
        {opts.map(o => {
          const active = pref === o.key;
          return (
            <TouchableOpacity
              key={o.key}
              style={[apS.pill, active && { backgroundColor: colors.primary }]}
              onPress={() => setPref(o.key)}
              activeOpacity={0.8}
            >
              <Ionicons name={o.icon} size={16} color={active ? '#FFFFFF' : colors.textDim} />
              <Text style={[apS.pillTxt, { color: active ? '#FFFFFF' : colors.textDim }]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[apS.hint, { color: colors.textDim }]}>
        {pref === 'system' ? `Following your device (currently ${scheme}).` : `Always ${pref}.`} Light mode is rolling out screen by screen.
      </Text>
    </View>
  );
}

const apS = StyleSheet.create({
  row: { flexDirection: 'row', borderRadius: 14, borderWidth: 1, padding: 4, gap: 4, marginTop: 4 },
  pill: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 11 },
  pillTxt: { fontSize: 13, fontWeight: '700' },
  hint: { fontSize: 11.5, marginTop: 8, lineHeight: 16 },
});

function ToggleRow({
  title, sub, value, busy, onValueChange,
}: {
  title:         string;
  sub:           string;
  value:         boolean;
  busy:          boolean;
  onValueChange: () => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <View style={S.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={S.toggleTitle}>{title}</Text>
        <Text style={S.toggleSub}>{sub}</Text>
      </View>
      {busy ? (
        <ActivityIndicator color={colors.primary} style={{ marginLeft: 8 }} />
      ) : (
        <Switch
          value={value}
          onValueChange={onValueChange}
          trackColor={{ true: colors.primary, false: '#374151' }}
          thumbColor="#fff"
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen:        { flex: 1, backgroundColor: c.bg },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 26, fontWeight: '600' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  // Profile card
  profileCard:   { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginTop: 4, padding: 14, borderRadius: 16, backgroundColor: c.card, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  profileAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  profileAvatarImg: { width: '100%', height: '100%' },
  profileAvatarTxt: { color: '#fff', fontSize: 22, fontWeight: '800' },
  profileName:   { color: c.text, fontSize: 17, fontWeight: '700' },
  profileSub:    { color: c.textDim, fontSize: 13, marginTop: 2 },

  // Icon-led link rows (grouped card)
  linkCard:      { backgroundColor: c.card, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: 'hidden' },
  linkRow:       { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  linkIconWrap:  { width: 30, alignItems: 'center', justifyContent: 'center' },
  linkTitle:     { color: c.text, fontSize: 15, fontWeight: '600' },
  linkSub:       { color: c.textDim, fontSize: 12, marginTop: 1 },

  section:       { paddingHorizontal: 16, marginTop: 16 },
  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  toggleRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  prefRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  toggleTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 2 },

  blockRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  blockAvatar:   { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  blockAvatarImg:{ width: '100%', height: '100%' },
  blockAvatarTxt:{ color: '#fff', fontWeight: '700' },
  blockName:     { color: c.text, fontSize: 15, fontWeight: '600' },
  blockEmail:    { color: c.textDim, fontSize: 12, marginTop: 2 },
  unblockBtn:    { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: c.danger },
  unblockTxt:    { color: c.danger, fontSize: 12, fontWeight: '700' },

  emptySub:      { color: c.textDim, fontSize: 13, lineHeight: 18, paddingVertical: 16 },

  // Data & account section
  dataBtn:       { marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  dataBtnTxt:    { color: c.primary, fontWeight: '700' },
  dataHint:      { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 6 },
  deleteBtn:     { marginTop: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  deleteBtnTxt:  { color: c.danger, fontWeight: '700' },
});
