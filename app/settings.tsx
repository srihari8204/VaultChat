// app/settings.tsx — Day 11 privacy / settings screen.
//
// Backed by:
//   GET  /user/settings   { discoverable, lastSeenVisible, readReceipts, profilePhotoVisible }
//   PUT  /user/settings   (any subset of the above as a Partial<UserSettings>)
//   GET  /user/blocks     [{ userId, name, email, photoURL, createdAt }]
//   DELETE /user/blocks/:userId
//
// No Firebase, no Firestore — pure Postgres + JWT.

import { HEADER_TOP } from '../constants/layout';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { isMfaEnabled, enableMfa, disableMfa } from '../lib/mfa';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SERVER_URL } from '../constants/server';
import { initUsageCounter, setUsageCounterEnabled, usageCounterEnabled } from '../lib/usageCounter';
import { api, getAccessToken } from '../lib/api';
import { getAutoDownload, setAutoDownload, type AutoDownloadPolicy } from '../lib/mediaPrefs';
import { getSaveToGallery, setSaveToGallery } from '../lib/galleryExport';
import { useTheme, type ThemePref } from '../lib/theme';
import { type Palette, brandAlpha } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { Sheet, type SheetAction } from '../components/ui/Sheet';

// Multi-choice settings are pickers, not alerts. Android's native dialog takes
// exactly three buttons (positive/negative/neutral), so an Alert.alert with one
// button per option SILENTLY DROPS the rest — the 5-option message timer showed
// 3, and "7 days" / "90 days" were unreachable on Android. Sheet scrolls and
// takes as many rows as we give it.
type Picker = { title: string; message?: string; actions: SheetAction[] } | null;

/** Memoized themed stylesheet for this screen. */
function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}
import {
  attachmentUrl,
  exportMyData,
  getSettings,
  listBlocks,
  unblockUser,
  updateSettings,
  type BlockedUser,
  type UserSettings,
} from '../lib/chatService';
import { AuroraBackground } from '../components/ui';

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
  const [picker, setPicker] = useState<Picker>(null);
  const [toGallery, setToGallery] = useState(true);
  useEffect(() => { getAutoDownload().then(setAutoDl); }, []);
  useEffect(() => { getSaveToGallery().then(setToGallery); }, []);
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

  // Device MFA (biometric / device PIN) — local + server mirror.
  const [mfaOn,   setMfaOn]   = useState(false);
  // AUDIT F9 — the usage counter's switch. Read once; the module holds the
  // live value, and this mirrors it for the control.
  const [usageOn, setUsageOn] = useState(usageCounterEnabled());
  useEffect(() => { initUsageCounter().then(setUsageOn).catch(() => {}); }, []);
  const toggleUsage = useCallback(async (on: boolean) => {
    setUsageOn(on);
    await setUsageCounterEnabled(on);
  }, []);
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

  // Delete account lives on its own screen (app/delete-account.tsx), not in a
  // pair of Alerts. Erasing an account is not something a native dialog should
  // be able to do in two taps, and the consequences need more room than an
  // alert body gives them — same reasoning as WhatsApp's dedicated screen.
  const onDeleteAccount = useCallback(() => {
    router.push('/delete-account' as any);
  }, [router]);

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
      <AuroraBackground />
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
        <TouchableOpacity onPress={() => router.push('/qr-contact' as any)} hitSlop={12}>
          <Ionicons name="qr-code-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
      </TouchableOpacity>

      <AppearanceSection />

      <View style={S.section}>
        <Text style={S.label}>CHATS</Text>
        <View style={S.linkCard}>
          <LinkRow icon="color-palette-outline" title="Bubble theme" sub="Color of your sent messages" onPress={() => router.push('/chat-themes' as any)} />
          <LinkRow icon="image-outline" title="Wallpaper" sub="Default chat background" onPress={() => router.push('/chat-wallpaper' as any)} />
          <TouchableOpacity style={[S.linkRow, { borderBottomWidth: 0 }]} activeOpacity={0.7} onPress={() => setPicker({
            title: 'Media auto-download',
            message: 'When to download photos automatically.',
            actions: [
              { label: 'Wi-Fi & mobile data', onPress: () => { setAutoDl('always'); setAutoDownload('always'); } },
              { label: 'Wi-Fi only', onPress: () => { setAutoDl('wifi'); setAutoDownload('wifi'); } },
              { label: 'Never', onPress: () => { setAutoDl('never'); setAutoDownload('never'); } },
            ],
          })}>
            <View style={S.linkIconWrap}><Ionicons name="cloud-download-outline" size={22} color={colors.text} /></View>
            <View style={{ flex: 1 }}>
              <Text style={S.linkTitle}>Media auto-download</Text>
              <Text style={S.linkSub}>{autoDlLabel(autoDl)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
          </TouchableOpacity>
          <View style={[S.linkRow, { borderBottomWidth: 0 }]}>
            <View style={S.linkIconWrap}><Ionicons name="images-outline" size={22} color={colors.text} /></View>
            <View style={{ flex: 1 }}>
              <Text style={S.linkTitle}>Save to gallery</Text>
              <Text style={S.linkSub}>
                Show received photos and videos in your phone&apos;s gallery. Anything saved
                leaves this app&apos;s protection — view-once media is never saved.
              </Text>
            </View>
            <Switch
              value={toGallery}
              onValueChange={(v) => { setToGallery(v); setSaveToGallery(v); }}
              trackColor={{ false: colors.border, true: colors.accentDeep }}
              thumbColor="#FFFFFF"
            />
          </View>
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
        <TouchableOpacity style={S.prefRow} activeOpacity={0.7} onPress={() => setPicker({
          title: 'Who can add me to groups',
          actions: [
            { label: 'Everyone', onPress: () => savePref({ groupAddPolicy: 'everyone' }) },
            { label: 'My contacts', onPress: () => savePref({ groupAddPolicy: 'contacts' }) },
            { label: 'Nobody', onPress: () => savePref({ groupAddPolicy: 'nobody' }) },
          ],
        })}>
          <View style={{ flex: 1 }}>
            <Text style={S.toggleTitle}>Add me to groups</Text>
            <Text style={S.toggleSub}>{groupAddLabel(settings.groupAddPolicy)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity style={S.prefRow} activeOpacity={0.7} onPress={() => setPicker({
          title: 'Default disappearing timer',
          message: 'Applied to new chats you start.',
          actions: [
            { label: 'Off', onPress: () => savePref({ defaultDisappearingSeconds: 0 }) },
            { label: '24 hours', onPress: () => savePref({ defaultDisappearingSeconds: 86400 }) },
            { label: '7 days', onPress: () => savePref({ defaultDisappearingSeconds: 604800 }) },
            { label: '90 days', onPress: () => savePref({ defaultDisappearingSeconds: 7776000 }) },
          ],
        })}>
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
        <Text style={S.label}>PRIVACY & SECURITY</Text>
        <View style={S.linkCard}>
          <LinkRow icon="shield-checkmark-outline" title="Vault features" sub="Screenshot alerts, disappearing messages, incognito keyboard" onPress={() => router.push('/vault-features' as any)} />
          {/* #32: the opt-in for session sealing. Setting a device PIN is what
              seals the signed-in session under it (services/security/pinStore);
              nobody is migrated into it, they choose it here. */}
          <LinkRow icon="keypad-outline" title="Device PIN" sub="Lock this device's session behind a PIN only you know" onPress={() => router.push('/backup-pin?from=settings' as any)} />
          <LinkRow icon="speedometer-outline" title="Privacy dashboard" sub="Your privacy score and what is protecting you" onPress={() => router.push('/privacy-dashboard' as any)} />
          <LinkRow icon="checkmark-done-outline" title="Read receipts" sub="Control who sees when you have read a message" onPress={() => router.push('/receipt-control' as any)} />
          <LinkRow icon="time-outline" title="Last seen & online" sub="Who can see when you were last active" onPress={() => router.push('/last-seen-privacy' as any)} />
          {/* Opens in the browser, not a WebView: a privacy policy is the one
              document a person should be able to see is served from the real
              domain, with the padlock their own browser drew. Play also expects
              this link to exist in-app, not only on the store listing. */}
          <LinkRow icon="document-text-outline" title="Privacy Policy" sub="What we collect, and what we cannot read" onPress={() => Linking.openURL(`${SERVER_URL}/privacy`)} />
          <LinkRow icon="reader-outline" title="Terms of Service" sub="The agreement you accepted" onPress={() => Linking.openURL(`${SERVER_URL}/terms`)} last />
        </View>
        {/* AUDIT F9. Stated in the sub-line rather than behind a help link,
            because the only reason a privacy product is allowed to count
            anything is that it says exactly what it counts. The sentence is the
            whole disclosure: a screen name and a day, no identity. */}
        <ToggleRow
          title="Help improve VaultChat"
          sub="Sends which screens get opened — a screen name and a day, with no account, device or message information. Never the content of anything."
          value={usageOn}
          onValueChange={toggleUsage}
        />
      </View>

      <View style={S.section}>
        <Text style={S.label}>DATA & ACCOUNT</Text>
        <View style={S.linkCard}>
          <LinkRow icon="notifications-outline" title="Notifications & Sounds" sub="Message tones, ringtone, vibration" onPress={() => router.push('/notification-sounds' as any)} />
          <LinkRow icon="call-outline" title="Call reliability" sub="Make calls ring when the app is closed" onPress={() => router.push('/call-reliability' as any)} />
          <LinkRow icon="cloud-upload-outline" title="Chat backup" sub="Encrypted backup to cloud or file" onPress={() => router.push('/chat-backup' as any)} />
          {/* Routes into the same one-conversation-at-a-time flow as the chat's
              ⋮ menu. Deliberately not a migration dashboard: the screen picks one
              contact, then imports one export. */}
          <LinkRow icon="download-outline" title="Import chats" sub="Bring one conversation over from WhatsApp" onPress={() => router.push('/import-chats' as any)} />
          <LinkRow icon="cube-outline" title="VaultBeam auto-download" sub="Auto-accept incoming files by network, sender & size" onPress={() => router.push('/vaultbeam-settings' as any)} />
          <LinkRow icon="time-outline" title="Scheduled messages" sub="Messages waiting to send later" onPress={() => router.push('/scheduled' as any)} />
          <LinkRow icon="bookmark-outline" title="Bookmarks" sub="Messages you've saved across chats" onPress={() => router.push('/bookmarks' as any)} />
          <LinkRow icon="alarm-outline" title="Message reminders" sub="Notifications you've scheduled" onPress={() => router.push('/message-reminder' as any)} />
          <LinkRow icon="eye-off-outline" title="Hidden chats" sub="PIN-gated chats, hidden from the list" onPress={() => router.push('/hidden-chats' as any)} />
          <LinkRow icon="desktop-outline" title="Active devices" sub="Where you're signed in" onPress={() => router.push('/login-history' as any)} />
          <LinkRow icon="mail-unread-outline" title="Message requests" sub="Messages from people you have not accepted" onPress={() => router.push('/msgrequests' as any)} />
          <LinkRow icon="pie-chart-outline" title="Storage & data" sub="What is using space on this device" onPress={() => router.push('/storage-manager' as any)} />
          <LinkRow icon="cloud-offline-outline" title="Offline mode" sub="What works without a connection, and the pending queue" onPress={() => router.push('/offline-mode' as any)} />
          <LinkRow icon="glasses-outline" title="Ghost Mode contacts" sub="Hidden online, typing, read, last-seen" onPress={() => router.push('/ghost-mode' as any)} />
          <LinkRow icon="download-outline" title="Export my data" sub="Download a JSON of your account" onPress={onExport} busy={exporting} last />
        </View>

        <TouchableOpacity
          style={S.deleteBtn}
          onPress={onDeleteAccount}
          activeOpacity={0.85}
        >
          <Text style={S.deleteBtnTxt}>Delete my account</Text>
        </TouchableOpacity>
      </View>

      <View style={S.section}>
        <Text style={S.label}>BLOCKED USERS</Text>
        {blocks.length === 0 ? (
          <Text style={S.emptySub}>You haven’t blocked anyone. To block someone, open their chat → menu → Block.</Text>
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

      <Sheet
        visible={!!picker}
        title={picker?.title}
        message={picker?.message}
        actions={picker?.actions ?? []}
        onClose={() => setPicker(null)}
      />
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
      <View style={[apS.row, { backgroundColor: colors.surfaceSolid, borderColor: colors.glassStroke }]}>
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
  // Optional: most toggles are instant. A row that has no async work to do
  // should not have to pass `busy={false}` to say so.
  busy?:         boolean;
  // Takes the NEW value. A `() => void` handler is still assignable, so every
  // existing caller keeps working; the ones that need the value can now read it
  // instead of inferring it from the state they are about to change.
  onValueChange: (value: boolean) => void;
}) {
  const { colors } = useTheme();
  const S = useS();
  return (
    <View style={S.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={S.toggleTitle}>{title}</Text>
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
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 26, fontWeight: '600' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  // Profile card
  profileCard:   { flexDirection: 'row', alignItems: 'center', gap: 14, marginHorizontal: 16, marginTop: 4, padding: 14, borderRadius: 16, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  profileAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  profileAvatarImg: { width: '100%', height: '100%' },
  profileAvatarTxt: { color: '#fff', fontSize: 22, fontWeight: '800' },
  profileName:   { color: c.text, fontSize: 17, fontWeight: '700' },
  profileSub:    { color: c.textDim, fontSize: 13, marginTop: 2 },

  // Icon-led link rows (grouped card)
  linkCard:      { backgroundColor: c.glassSoft, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke, overflow: 'hidden' },
  linkRow:       { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  linkIconWrap:  { width: 30, alignItems: 'center', justifyContent: 'center' },
  linkTitle:     { color: c.text, fontSize: 15, fontWeight: '600' },
  linkSub:       { color: c.textDim, fontSize: 12, marginTop: 1 },

  section:       { paddingHorizontal: 16, marginTop: 16 },
  label:         { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  toggleRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  prefRow:       { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  toggleTitle:   { color: c.text, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 2 },

  blockRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke },
  blockAvatar:   { width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  blockAvatarImg:{ width: '100%', height: '100%' },
  blockAvatarTxt:{ color: '#fff', fontWeight: '700' },
  blockName:     { color: c.text, fontSize: 15, fontWeight: '600' },
  blockEmail:    { color: c.textDim, fontSize: 12, marginTop: 2 },
  unblockBtn:    { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: c.danger },
  unblockTxt:    { color: c.danger, fontSize: 12, fontWeight: '700' },

  emptySub:      { color: c.textDim, fontSize: 13, lineHeight: 18, paddingVertical: 16 },

  // Data & account section
  dataBtn:       { marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke, alignItems: 'center' },
  dataBtnTxt:    { color: c.primary, fontWeight: '700' },
  dataHint:      { color: c.textDim, fontSize: 12, lineHeight: 16, marginTop: 6 },
  deleteBtn:     { marginTop: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  deleteBtnTxt:  { color: c.danger, fontWeight: '700' },
});
