// app/settings.tsx — Day 11 privacy / settings screen.
//
// Backed by:
//   GET  /user/settings   { discoverable, lastSeenVisible, readReceipts, profilePhotoVisible }
//   PUT  /user/settings   (any subset of the above as a Partial<UserSettings>)
//   GET  /user/blocks     [{ userId, name, email, photoURL, createdAt }]
//   DELETE /user/blocks/:userId
//
// No Firebase, no Firestore — pure Postgres + JWT.

import { useAuthHeader } from '../hooks/useAuthHeader';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
// In-app browser (Custom Tab), not a bounce out to the default browser: the
// policy pages are part of the app's own agreement flow, so reading them
// should not lose the user's place in Settings.
import * as WebBrowser from 'expo-web-browser';
import { isMfaEnabled, enableMfa, disableMfa } from '../lib/mfa';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Switch,
  TouchableOpacity,
  View,
} from 'react-native';
import { SERVER_URL } from '../constants/server';
import { initUsageCounter, setUsageCounterEnabled, usageCounterEnabled } from '../lib/usageCounter';
import { api } from '../lib/api';
import { profileFromProtobuf } from '../lib/userProfilePolicy';
import { initialOf } from '../lib/format';
import { getAutoDownload, setAutoDownload, type AutoDownloadPolicy } from '../lib/mediaPrefs';
import { getSaveToGallery, setSaveToGallery } from '../lib/galleryExport';
import { useTheme, type ThemePref } from '../lib/theme';
import { useVisionComfort } from '../lib/visionComfort';
import { type Palette } from '../constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { Sheet, type SheetAction } from '../components/ui/Sheet';

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
import { AppText as Text, AuroraBackground } from '../components/ui';

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

export default function SettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { activeProfile } = useVisionComfort();
  const S = useS();

  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [blocks,   setBlocks]   = useState<BlockedUser[]>([]);
  const [loading,  setLoading]  = useState(true);
  // A failed load is shown as a failure with a retry, never as a spinner that
  // never stops. Blocks load on their own so a /user/blocks outage does not
  // take the whole Settings screen down with it.
  const [loadError,   setLoadError]   = useState<string | null>(null);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [loadTick,    setLoadTick]    = useState(0);
  const authHeader = useAuthHeader();
  const [profile, setProfile] = useState<{ name?: string; email?: string; status?: string; photoURL?: string } | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [autoDl, setAutoDl] = useState<AutoDownloadPolicy>('always');
  const [picker, setPicker] = useState<Picker>(null);
  const [toGallery, setToGallery] = useState(true);
  useEffect(() => { getAutoDownload().then(setAutoDl).catch(() => {}); }, []);
  useEffect(() => { getSaveToGallery().then(setToGallery).catch(() => {}); }, []);
  // Device-local preferences: shown at once, put back with a notice if the
  // write is refused, so the row never claims a choice that was not kept.
  const saveLocal = useCallback(<T,>(apply: (v: T) => void, prev: T, next: T, write: (v: T) => Promise<void>) => {
    apply(next);
    write(next).catch(() => {
      apply(prev);
      Alert.alert('Not saved', 'This setting could not be saved on this phone. Try again.');
    });
  }, []);
  const autoDlLabel = (p: AutoDownloadPolicy) => p === 'never' ? 'Never' : p === 'wifi' ? 'Wi-Fi only' : 'Wi-Fi & mobile data';

  const loadBlocks = useCallback((cancelled: () => boolean = () => false) => {
    setBlocksError(null);
    listBlocks()
      .then((b) => { if (!cancelled()) setBlocks(b); })
      .catch((e: any) => { if (!cancelled()) setBlocksError(e?.message ?? 'Could not load blocked users'); });
  }, []);

  // Initial fetch — settings, blocks and profile in parallel, each settling on
  // its own. Re-run by bumping loadTick (the full-screen Try again).
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setLoadError(null);
    getSettings()
      .then((s) => { if (!cancel) setSettings(s); })
      .catch((e: any) => { if (!cancel) setLoadError(e?.message ?? 'Could not load settings'); })
      .finally(() => { if (!cancel) setLoading(false); });
    loadBlocks(() => cancel);
    api<{ name?: string; email?: string; status?: string; photoURL?: string }>(
      '/user/profile', { proto: profileFromProtobuf })
      .then((p) => { if (!cancel) { setProfile(p); setProfileFailed(false); } })
      // Said on the card: "Your name" would read as if the profile had no name.
      .catch(() => { if (!cancel) setProfileFailed(true); });
    return () => { cancel = true; };
  }, [loadTick, loadBlocks]);
  const reload = useCallback(() => setLoadTick((t) => t + 1), []);

  // Non-boolean settings (group-add policy, default timer) — optimistic save,
  // one at a time: a second pick while the first PUT is in flight could land
  // out of order and leave the server on the older choice.
  const [prefBusy, setPrefBusy] = useState(false);
  const savePref = useCallback(async (patch: Partial<UserSettings>) => {
    if (!settings || prefBusy) return;
    const prev = settings;
    setSettings({ ...settings, ...patch });
    setPrefBusy(true);
    try { await updateSettings(patch); }
    catch (e: any) { setSettings(prev); Alert.alert('Save failed', e?.message ?? 'Try again'); }
    finally { setPrefBusy(false); }
  }, [settings, prefBusy]);

  const groupAddLabel = (p?: string) => p === 'nobody' ? 'Nobody' : p === 'contacts' ? 'My contacts' : 'Everyone';
  const timerLabel = (s?: number) => !s ? 'Off' : s >= 7776000 ? '90 days' : s >= 604800 ? '7 days' : s >= 86400 ? '24 hours' : `${Math.round(s / 60)} min`;

  const [exporting, setExporting] = useState(false);

  // Device MFA (biometric / device PIN) — local + server mirror.
  const [mfaOn,   setMfaOn]   = useState(false);
  // AUDIT F9 — the usage counter's switch. Read once; the module holds the
  // live value, and this mirrors it for the control.
  const [usageOn, setUsageOn] = useState(usageCounterEnabled());
  useEffect(() => { initUsageCounter().then(setUsageOn).catch(() => {}); }, []);
  const toggleUsage = useCallback((on: boolean) => {
    saveLocal(setUsageOn, !on, on, setUsageCounterEnabled);
  }, [saveLocal]);
  const [mfaBusy, setMfaBusy] = useState(false);
  // A failed read is not "off": the row says it could not check.
  const [mfaReadFailed, setMfaReadFailed] = useState(false);
  useEffect(() => {
    isMfaEnabled().then((on) => { setMfaOn(on); setMfaReadFailed(false); }).catch(() => setMfaReadFailed(true));
  }, []);
  const toggleMfa = useCallback(async () => {
    if (mfaBusy) return;
    setMfaBusy(true);
    try {
      if (mfaOn) { await disableMfa(); setMfaOn(false); setMfaReadFailed(false); }
      else {
        const ok = await enableMfa();
        if (ok) { setMfaOn(true); setMfaReadFailed(false); }
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
      // Checked BEFORE anything is written: without a share sheet the export
      // could only sit in the app cache, where nobody can reach it and nothing
      // would ever delete the whole account's data.
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Export unavailable', 'Sharing is not available on this device, so the export has nowhere to go.');
        return;
      }
      const json = await exportMyData();
      const dest = `${FileSystem.cacheDirectory}vaultchat-export-${Date.now()}.json`;
      await FileSystem.writeAsStringAsync(dest, json, { encoding: FileSystem.EncodingType.UTF8 });
      try {
        await Sharing.shareAsync(dest, { mimeType: 'application/json', dialogTitle: 'Save your crazzychat data' });
      } finally {
        // The whole account export must not linger in the app cache once the
        // share sheet has handed it on (or been dismissed).
        await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
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
    router.push('/delete-account');
  }, [router]);

  // One unblock at a time: a second tap while the DELETE is in flight would
  // send it twice and could report a failure for a user already unblocked.
  const [unblocking, setUnblocking] = useState<string | null>(null);
  const onUnblock = useCallback((u: BlockedUser) => {
    if (unblocking) return;
    Alert.alert('Unblock?', `${u.name || u.email || 'This user'} will be able to message you again.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unblock', style: 'destructive', onPress: async () => {
          setUnblocking(u.userId);
          try {
            await unblockUser(u.userId);
            setBlocks(prev => prev.filter(x => x.userId !== u.userId));
          } catch (e: any) {
            Alert.alert('Could not unblock', e?.message ?? 'Try again');
          } finally {
            setUnblocking(null);
          }
        }
      },
    ]);
  }, [unblocking]);

  if (loading || !settings) {
    return (
      <View style={[S.screen, S.center]}>
      <AuroraBackground />
        {loading ? <ActivityIndicator color={colors.primary} size="large" /> : (
          <View style={S.errorBox} accessibilityRole="alert">
            <Text style={S.errorTitle}>Could not load settings</Text>
            <Text style={S.errorSub}>{loadError ?? 'Try again'}</Text>
            <View style={S.errorActions}>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={S.errorBtn} activeOpacity={0.7}>
                <Text style={S.errorBtnTxt}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading settings again" onPress={reload} style={S.errorBtn} activeOpacity={0.7}>
                <Text style={S.errorBtnTxt}>Try again</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  }

  return (
    // The ScrollView is wrapped so the <Sheet> below can be its SIBLING. A
    // react-native <Modal> mounted inside a scroll container is laid out as a
    // screen-sized host view in that container's content — its own window
    // paints in the right place, but the scroll view it lives in no longer
    // hit-tests where it paints, which is how a tap on one PRIVACY row fired a
    // different row a thousand pixels away. A modal is never scroll content.
    <View style={S.screen}>
      <AuroraBackground />
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 64 }}>
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} hitSlop={10} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Settings</Text>
      </View>

      {/* Profile card (WhatsApp-style) — avatar + name + about, with the QR
          button BESIDE it, not inside it: an accessible touchable hides its
          children from VoiceOver, so a nested QR button could not be reached. */}
      <View style={S.profileCard}>
        <TouchableOpacity style={S.profileMain} activeOpacity={0.8} onPress={() => router.push('/(tabs)/profile')}
          accessibilityRole="button" accessibilityLabel={profileFailed && !profile ? 'Your profile. It could not be loaded' : `Your profile, ${profile?.name || 'Your name'}`}>
          <View style={S.profileAvatar}>
            {profile?.photoURL && authHeader ? (
              <Image source={{ uri: attachmentUrl(profile.photoURL), headers: { Authorization: authHeader } }} style={S.profileAvatarImg} />
            ) : (
              <Text style={S.profileAvatarTxt}>{initialOf(profile?.name, profile?.email)}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={S.profileName}>{profileFailed && !profile ? 'Your profile' : profile?.name || 'Your name'}</Text>
            <Text style={S.profileSub}>{profileFailed && !profile ? 'Could not be loaded — tap to open it' : profile?.status || profile?.email || ''}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={S.qrBtn} accessibilityRole="button" accessibilityLabel="Show your QR code" onPress={() => router.push('/qr-contact')} hitSlop={6}>
          <Ionicons name="qr-code-outline" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <AppearanceSection />

      <View style={S.section}>
        <Text style={S.label}>ACCESSIBILITY</Text>
        <View style={S.linkCard}>
          <LinkRow icon="eye-outline" title="Vision Comfort" sub={`Active: ${activeProfile === 'with-glasses' ? 'With glasses' : 'Without glasses'}`} onPress={() => router.push('/vision-comfort')} last />
        </View>
      </View>

      <View style={S.section}>
        <Text style={S.label}>CHATS</Text>
        <View style={S.linkCard}>
          <LinkRow icon="color-palette-outline" title="Bubble theme" sub="Color of your sent messages" onPress={() => router.push('/chat-themes')} />
          <LinkRow icon="image-outline" title="Wallpaper" sub="Default chat background" onPress={() => router.push('/chat-wallpaper')} />
          <TouchableOpacity style={[S.linkRow, { borderBottomWidth: 0 }]} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={`Media auto-download, ${autoDlLabel(autoDl)}`} onPress={() => setPicker({
            title: 'Media auto-download',
            message: 'When to download photos automatically.',
            actions: [
              { label: 'Wi-Fi & mobile data', selected: autoDl === 'always', onPress: () => saveLocal(setAutoDl, autoDl, 'always', setAutoDownload) },
              { label: 'Wi-Fi only', selected: autoDl === 'wifi', onPress: () => saveLocal(setAutoDl, autoDl, 'wifi', setAutoDownload) },
              { label: 'Never', selected: autoDl === 'never', onPress: () => saveLocal(setAutoDl, autoDl, 'never', setAutoDownload) },
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
              accessibilityLabel="Save to gallery"
              value={toGallery}
              onValueChange={(v) => saveLocal(setToGallery, !v, v, setSaveToGallery)}
              trackColor={{ false: colors.border, true: colors.accentDeep }}
              thumbColor={colors.onPrimary}
            />
          </View>
        </View>
      </View>

      <View style={S.section}>
        <Text style={S.label}>PRIVACY</Text>

        {/* Last seen, read receipts, profile photo and discoverable are owned
            by ONE screen (app/last-seen-privacy.tsx). They used to be switches
            here, there and as chips on the Privacy Dashboard: three copies of
            one server value, each able to show a stale state after another
            had saved. Settings and the dashboard link to it instead. */}
        <View style={[S.linkCard, { marginBottom: 4 }]}>
          <LinkRow icon="time-outline" title="Last seen & privacy" sub="Last seen, read receipts, profile photo, discoverable by phone" onPress={() => router.push('/last-seen-privacy')} last />
        </View>
        <TouchableOpacity style={S.prefRow} activeOpacity={0.7} disabled={prefBusy} accessibilityRole="button" accessibilityLabel={`Add me to groups, ${groupAddLabel(settings.groupAddPolicy)}`} accessibilityState={{ disabled: prefBusy }} onPress={() => setPicker({
          title: 'Who can add me to groups',
          actions: [
            { label: 'Everyone', selected: settings.groupAddPolicy === 'everyone', onPress: () => savePref({ groupAddPolicy: 'everyone' }) },
            { label: 'My contacts', selected: settings.groupAddPolicy === 'contacts', onPress: () => savePref({ groupAddPolicy: 'contacts' }) },
            { label: 'Nobody', selected: settings.groupAddPolicy === 'nobody', onPress: () => savePref({ groupAddPolicy: 'nobody' }) },
          ],
        })}>
          <View style={{ flex: 1 }}>
            <Text style={S.toggleTitle}>Add me to groups</Text>
            <Text style={S.toggleSub}>{groupAddLabel(settings.groupAddPolicy)}</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity style={S.prefRow} activeOpacity={0.7} disabled={prefBusy} accessibilityRole="button" accessibilityLabel={`Default message timer, ${timerLabel(settings.defaultDisappearingSeconds)}`} accessibilityState={{ disabled: prefBusy }} onPress={() => setPicker({
          title: 'Default disappearing timer',
          message: 'Applied to new chats you start.',
          actions: [
            { label: 'Off', selected: !settings.defaultDisappearingSeconds, onPress: () => savePref({ defaultDisappearingSeconds: 0 }) },
            { label: '24 hours', selected: settings.defaultDisappearingSeconds === 86400, onPress: () => savePref({ defaultDisappearingSeconds: 86400 }) },
            { label: '7 days', selected: settings.defaultDisappearingSeconds === 604800, onPress: () => savePref({ defaultDisappearingSeconds: 604800 }) },
            { label: '90 days', selected: settings.defaultDisappearingSeconds === 7776000, onPress: () => savePref({ defaultDisappearingSeconds: 7776000 }) },
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
          sub={mfaReadFailed
            ? 'Could not check whether this is on. Require your device biometrics or MPIN each time crazzychat launches.'
            : 'Require your device biometrics or MPIN each time crazzychat launches.'}
          value={mfaOn}
          busy={mfaBusy}
          onValueChange={toggleMfa}
        />
      </View>

      <View style={S.section}>
        <Text style={S.label}>PRIVACY & SECURITY</Text>
        <View style={S.linkCard}>
          {/* The sub-line used to advertise screenshot alerts and an incognito
              keyboard, which nothing reads (2026-10-04 audit). It names only
              what the screen really does; the message timer lives below. */}
          <LinkRow icon="shield-checkmark-outline" title="Vault features" sub="Temp invite codes, auto screen lock, Vault" onPress={() => router.push('/vault-features')} />
          {/* #32: the opt-in for session sealing. Setting a device PIN is what
              seals the signed-in session under it (services/security/pinStore);
              nobody is migrated into it, they choose it here. */}
          <LinkRow icon="keypad-outline" title="Device PIN" sub="Lock this device's session behind a PIN only you know" onPress={() => router.push('/backup-pin?from=settings')} />
          <LinkRow icon="lock-closed-outline" title="Chat locks" sub="Lock individual chats behind a PIN or biometrics" onPress={() => router.push('/app-lock-chats')} />
          {/* app/permissions.tsx existed with no entry point: the only way in was
              the old onboarding chain, whose first screen nothing reaches. It is a
              genuine feature - one place to see and re-request every permission,
              including full-screen-intent, which no other screen surfaces - so it
              is routed here rather than deleted (2026-09-17). */}
          <LinkRow icon="options-outline" title="App permissions" sub="Camera, microphone, contacts, location and notifications" onPress={() => router.push('/permissions?from=settings')} />
          <LinkRow icon="speedometer-outline" title="Privacy dashboard" sub="Your privacy score and what is protecting you" onPress={() => router.push('/privacy-dashboard')} />
          <LinkRow icon="shield-half-outline" title="Security Hub" sub="Your account's security overview" onPress={() => router.push('/dashboard')} />
          <LinkRow icon="checkmark-done-outline" title="Per-contact receipts" sub="Hide read receipts, typing or last seen from chosen people" onPress={() => router.push('/receipt-control')} />
          {/* Opens in the browser, not a WebView: a privacy policy is the one
              document a person should be able to see is served from the real
              domain, with the padlock their own browser drew. Play also expects
              this link to exist in-app, not only on the store listing. */}
          <LinkRow icon="document-text-outline" title="Privacy Policy" sub="What we collect, and what we cannot read" onPress={() => WebBrowser.openBrowserAsync(`${SERVER_URL}/privacy`)} />
          <LinkRow icon="reader-outline" title="Terms of Service" sub="The agreement you accepted" onPress={() => WebBrowser.openBrowserAsync(`${SERVER_URL}/terms`)} last />
        </View>
        {/* AUDIT F9. Stated in the sub-line rather than behind a help link,
            because the only reason a privacy product is allowed to count
            anything is that it says exactly what it counts. The sentence is the
            whole disclosure: a screen name and a day, no identity. */}
        <ToggleRow
          title="Help improve crazzychat"
          sub="Sends which screens get opened — a screen name and a day, with no account, device or message information. Never the content of anything."
          value={usageOn}
          onValueChange={toggleUsage}
        />
      </View>

      <View style={S.section}>
        <Text style={S.label}>DATA & ACCOUNT</Text>
        <View style={S.linkCard}>
          <LinkRow icon="notifications-outline" title="Notifications & Sounds" sub="Message tones, ringtone, vibration" onPress={() => router.push('/notification-sounds')} />
          <LinkRow icon="call-outline" title="Call reliability" sub="Make calls ring when the app is closed" onPress={() => router.push('/call-reliability')} />
          <LinkRow icon="cloud-upload-outline" title="Chat backup" sub="Encrypted backup to cloud or file" onPress={() => router.push('/chat-backup')} />
          {/* Routes into the same one-conversation-at-a-time flow as the chat's
              ⋮ menu. Deliberately not a migration dashboard: the screen picks one
              contact, then imports one export. */}
          <LinkRow icon="download-outline" title="Import chats" sub="Bring one conversation over from WhatsApp" onPress={() => router.push('/import-chats')} />
          <LinkRow icon="cube-outline" title="VaultBeam auto-download" sub="Auto-accept incoming files by network, sender & size" onPress={() => router.push('/vaultbeam-settings')} />
          <LinkRow icon="time-outline" title="Scheduled messages" sub="Messages waiting to send later" onPress={() => router.push('/scheduled')} />
          <LinkRow icon="bookmark-outline" title="Bookmarks" sub="Messages you've saved across chats" onPress={() => router.push('/bookmarks')} />
          <LinkRow icon="alarm-outline" title="Message reminders" sub="Notifications you've scheduled" onPress={() => router.push('/message-reminder')} />
          <LinkRow icon="eye-off-outline" title="Hidden chats" sub="PIN-gated chats, hidden from the list" onPress={() => router.push('/hidden-chats')} />
          <LinkRow icon="desktop-outline" title="Active devices" sub="Where you're signed in" onPress={() => router.push('/login-history')} />
          <LinkRow icon="pie-chart-outline" title="Storage & data" sub="What is using space on this device" onPress={() => router.push('/storage-manager')} />
          <LinkRow icon="cloud-offline-outline" title="Offline mode" sub="What works without a connection, and the pending queue" onPress={() => router.push('/offline-mode')} />
          <LinkRow icon="glasses-outline" title="Ghost Mode contacts" sub="Hidden online, typing, read, last-seen" onPress={() => router.push('/ghost-mode')} />
          <LinkRow icon="download-outline" title="Export my data" sub="Download a JSON of your account" onPress={onExport} busy={exporting} />
          {/* Both were unreachable. They are support tools, not dead code: the
              network test is what tells you whether a call failure is the app or
              the link, and d2de-status lists the encryption layers this build
              uses. Routed at the end of the section, after the everyday rows. */}
          <LinkRow icon="pulse-outline" title="Network test" sub="Check the connection this device is actually getting" onPress={() => router.push('/network-test')} />
          <LinkRow icon="git-compare-outline" title="Encryption status" sub="Which encryption layers this build uses" onPress={() => router.push('/d2de-status')} last />
        </View>

        <TouchableOpacity
          style={S.deleteBtn}
          onPress={onDeleteAccount}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Delete my account"
        >
          <Text style={S.deleteBtnTxt}>Delete my account</Text>
        </TouchableOpacity>
      </View>

      <View style={S.section}>
        <Text style={S.label}>BLOCKED USERS</Text>
        {blocksError ? (
          <View style={S.blocksError}>
            <Text style={[S.emptySub, { flex: 1 }]}>Could not load blocked users. {blocksError}</Text>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading blocked users again" onPress={() => loadBlocks()} style={S.errorBtn} activeOpacity={0.7}>
              <Text style={S.errorBtnTxt}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : blocks.length === 0 ? (
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
                  <Text style={S.blockAvatarTxt}>{initialOf(u.name, u.email)}</Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={S.blockName} numberOfLines={1}>{u.name || u.email || u.userId.slice(0, 8)}</Text>
                {u.email && u.name && <Text style={S.blockEmail} numberOfLines={1}>{u.email}</Text>}
              </View>
              <TouchableOpacity onPress={() => onUnblock(u)} style={[S.unblockBtn, !!unblocking && unblocking !== u.userId && { opacity: 0.5 }]} activeOpacity={0.7}
                disabled={!!unblocking}
                accessibilityRole="button" accessibilityLabel={`Unblock ${u.name || u.email || 'this user'}`}
                accessibilityState={{ disabled: !!unblocking, busy: unblocking === u.userId }}>
                {unblocking === u.userId ? <ActivityIndicator size="small" color={colors.danger} /> : <Text style={S.unblockTxt}>Unblock</Text>}
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

    </ScrollView>

      <Sheet
        visible={!!picker}
        title={picker?.title}
        message={picker?.message}
        actions={picker?.actions ?? []}
        onClose={() => setPicker(null)}
      />
    </View>
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
    <TouchableOpacity style={[S.linkRow, last && { borderBottomWidth: 0 }]} onPress={onPress} activeOpacity={0.7} disabled={busy}
      accessibilityRole="button" accessibilityLabel={sub ? `${title}. ${sub}` : title} accessibilityState={{ disabled: !!busy, busy: !!busy }}>
      <View style={S.linkIconWrap}><Ionicons name={icon} size={22} color={colors.text} /></View>
      <View style={{ flex: 1 }}>
        <Text style={S.linkTitle}>{title}</Text>
        {sub ? <Text style={S.linkSub}>{sub}</Text> : null}
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
      <View style={[apS.row, { backgroundColor: colors.glass, borderColor: colors.glassStroke }]}>
        {opts.map(o => {
          const active = pref === o.key;
          return (
            <TouchableOpacity
              key={o.key}
              style={[apS.pill, active && { backgroundColor: colors.primary }]}
              onPress={() => setPref(o.key)}
              activeOpacity={0.8}
              accessibilityRole="radio"
              accessibilityLabel={`Appearance: ${o.label}`}
              accessibilityState={{ selected: active, checked: active }}
            >
              <Ionicons name={o.icon} size={16} color={active ? colors.onPrimary : colors.textDim} />
              <Text style={[apS.pillTxt, { color: active ? colors.onPrimary : colors.textDim }]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[apS.hint, { color: colors.textDim }]}>
        {pref === 'system' ? `Following your device (currently ${scheme}).` : `Always ${pref}.`}
      </Text>
    </View>
  );
}

const apS = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', borderRadius: 14, borderWidth: 1, padding: 4, gap: 4, marginTop: 4 },
  pill: { flexGrow: 1, minWidth: 120, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 11 },
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
        <Text style={S.toggleTitle}>{title}</Text>
        <Text style={S.toggleSub}>{sub}</Text>
      </View>
      {busy ? (
        <ActivityIndicator color={colors.primary} style={{ marginLeft: 8 }} />
      ) : (
        <Switch
          accessibilityLabel={title}
          value={value}
          onValueChange={onValueChange}
          trackColor={{ true: colors.primary, false: colors.border }}
          thumbColor={colors.onPrimary}
        />
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  center:        { justifyContent: 'center', alignItems: 'center' },

  // The status-bar inset comes from the navigator (INSET_SCREENS in
  // app/_layout.tsx), which pads the SCREEN — so scrolled rows clip at the
  // inset instead of sliding under the clock. This is just the header's gap.
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title:         { color: c.text, fontSize: 22, fontWeight: '800' },

  // Profile card
  profileCard:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 4, padding: 14, borderRadius: 16, backgroundColor: c.glassSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  profileMain:   { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 },
  qrBtn:         { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  profileAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  profileAvatarImg: { width: '100%', height: '100%' },
  profileAvatarTxt: { color: c.onPrimary, fontSize: 22, fontWeight: '800' },
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
  blockAvatarTxt:{ color: c.onPrimary, fontWeight: '700' },
  blockName:     { color: c.text, fontSize: 15, fontWeight: '600' },
  blockEmail:    { color: c.textDim, fontSize: 12, marginTop: 2 },
  unblockBtn:    { minHeight: 44, minWidth: 88, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: c.danger },
  unblockTxt:    { color: c.danger, fontSize: 12, fontWeight: '700' },

  emptySub:      { color: c.textDim, fontSize: 13, lineHeight: 18, paddingVertical: 16 },

  // Load failure
  errorBox:      { alignItems: 'center', paddingHorizontal: 32, gap: 6 },
  errorTitle:    { color: c.text, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  errorSub:      { color: c.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  errorActions:  { flexDirection: 'row', gap: 12, marginTop: 12 },
  errorBtn:      { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  errorBtnTxt:   { color: c.primary, fontWeight: '700' },
  blocksError:   { flexDirection: 'row', alignItems: 'center', gap: 12 },

  // Data & account section
  deleteBtn:     { marginTop: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: c.danger, alignItems: 'center' },
  deleteBtnTxt:  { color: c.danger, fontWeight: '700' },
});
