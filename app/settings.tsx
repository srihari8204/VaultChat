// app/settings.tsx — Day 11 privacy / settings screen.
//
// Backed by:
//   GET  /user/settings   { discoverable, lastSeenVisible, readReceipts, profilePhotoVisible }
//   PUT  /user/settings   (any subset of the above as a Partial<UserSettings>)
//   GET  /user/blocks     [{ userId, name, email, photoURL, createdAt }]
//   DELETE /user/blocks/:userId
//
// No Firebase, no Firestore — pure Postgres + JWT.

import * as FileSystem from 'expo-file-system';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
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
import { getAccessToken } from '../lib/api';
import { useTheme, type ThemePref } from '../lib/theme';
import { Ionicons } from '@expo/vector-icons';
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

  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [blocks,   setBlocks]   = useState<BlockedUser[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState<null | keyof UserSettings>(null);
  const [authHeader, setAuthHeader] = useState<string | null>(null);

  // Initial fetch — settings + blocks in parallel + auth header
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const [s, b, tok] = await Promise.all([getSettings(), listBlocks(), getAccessToken()]);
        if (cancel) return;
        setSettings(s);
        setBlocks(b);
        setAuthHeader(tok ? `Bearer ${tok}` : null);
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

  const [exporting, setExporting] = useState(false);
  const [deleting,  setDeleting]  = useState(false);

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
                      router.replace('/welcome' as any);
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
        <ActivityIndicator color={ACCENT} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ paddingBottom: 64 }}>
      <View style={S.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={S.backBtn} activeOpacity={0.7}>
          <Text style={S.backTxt}>←</Text>
        </TouchableOpacity>
        <Text style={S.title}>Settings</Text>
      </View>

      <AppearanceSection />

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
      </View>

      <View style={S.section}>
        <Text style={S.label}>DATA & ACCOUNT</Text>

        <TouchableOpacity
          style={S.dataBtn}
          onPress={() => router.push('/scheduled' as any)}
          activeOpacity={0.85}
        >
          <Text style={S.dataBtnTxt}>📅 Scheduled messages</Text>
        </TouchableOpacity>
        <Text style={S.dataHint}>
          Review and cancel any messages waiting to send at a future time.
        </Text>

        <TouchableOpacity
          style={[S.dataBtn, { marginTop: 12 }]}
          onPress={() => router.push('/bookmarks' as any)}
          activeOpacity={0.85}
        >
          <Text style={S.dataBtnTxt}>🔖 Bookmarks</Text>
        </TouchableOpacity>
        <Text style={S.dataHint}>
          Messages you've saved across all chats.
        </Text>

        <TouchableOpacity
          style={[S.dataBtn, { marginTop: 12 }]}
          onPress={() => router.push('/message-reminder' as any)}
          activeOpacity={0.85}
        >
          <Text style={S.dataBtnTxt}>⏰ Message reminders</Text>
        </TouchableOpacity>
        <Text style={S.dataHint}>
          Notifications you've scheduled for specific messages.
        </Text>

        <TouchableOpacity
          style={[S.dataBtn, { marginTop: 12 }]}
          onPress={() => router.push('/hidden-chats' as any)}
          activeOpacity={0.85}
        >
          <Text style={S.dataBtnTxt}>🕶️ Hidden chats</Text>
        </TouchableOpacity>
        <Text style={S.dataHint}>
          PIN-gated. Hidden chats stay invisible in the main list until you unlock them here.
        </Text>

        <TouchableOpacity
          style={[S.dataBtn, { marginTop: 12 }]}
          onPress={() => router.push('/login-history' as any)}
          activeOpacity={0.85}
        >
          <Text style={S.dataBtnTxt}>🖥️ Active devices</Text>
        </TouchableOpacity>
        <Text style={S.dataHint}>
          See where you're signed in and remotely sign out other devices.
        </Text>

        <TouchableOpacity
          style={[S.dataBtn, { marginTop: 12 }]}
          onPress={() => router.push('/ghost-mode' as any)}
          activeOpacity={0.85}
        >
          <Text style={S.dataBtnTxt}>👻 Ghost Mode contacts</Text>
        </TouchableOpacity>
        <Text style={S.dataHint}>
          People for whom you've hidden online, typing, read, or last-seen.
        </Text>

        <TouchableOpacity
          style={[S.dataBtn, { marginTop: 12 }]}
          onPress={onExport}
          disabled={exporting}
          activeOpacity={0.85}
        >
          {exporting ? <ActivityIndicator color={ACCENT} /> : (
            <Text style={S.dataBtnTxt}>📦 Export my data</Text>
          )}
        </TouchableOpacity>
        <Text style={S.dataHint}>
          Download a JSON file containing your profile, chats, messages, and settings.
          Attachments are listed by id — fetch them separately.
        </Text>

        <TouchableOpacity
          style={S.deleteBtn}
          onPress={onDeleteAccount}
          disabled={deleting}
          activeOpacity={0.85}
        >
          {deleting ? <ActivityIndicator color={DANGER} /> : (
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

// Appearance (U3) — Light / Dark / System, persisted via the ThemeProvider.
// The control itself is theme-aware so the chosen palette previews live.
function AppearanceSection() {
  const { pref, setPref, colors, scheme } = useTheme();
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
              <Ionicons name={o.icon} size={16} color={active ? '#04130D' : colors.textDim} />
              <Text style={[apS.pillTxt, { color: active ? '#04130D' : colors.textDim }]}>{o.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={[apS.hint, { color: SUBTLE }]}>
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
  return (
    <View style={S.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={S.toggleTitle}>{title}</Text>
        <Text style={S.toggleSub}>{sub}</Text>
      </View>
      {busy ? (
        <ActivityIndicator color={ACCENT} style={{ marginLeft: 8 }} />
      ) : (
        <Switch
          value={value}
          onValueChange={onValueChange}
          trackColor={{ true: ACCENT, false: '#374151' }}
          thumbColor="#fff"
        />
      )}
    </View>
  );
}

const DARK_BG = '#0D0F14';
const CARD_BG = '#161A22';
const BORDER  = '#1F2937';
const TEXT    = '#E5E7EB';
const SUBTLE  = '#9CA3AF';
const ACCENT  = '#6C63FF';
const DANGER  = '#EF4444';

const S = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: DARK_BG },
  center:        { justifyContent: 'center', alignItems: 'center' },

  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 56, paddingBottom: 12, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: TEXT, fontSize: 26, fontWeight: '600' },
  title:         { color: TEXT, fontSize: 22, fontWeight: '800' },

  section:       { paddingHorizontal: 16, marginTop: 16 },
  label:         { color: SUBTLE, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginBottom: 8 },

  toggleRow:     { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  toggleTitle:   { color: TEXT, fontSize: 15, fontWeight: '600' },
  toggleSub:     { color: SUBTLE, fontSize: 12, lineHeight: 16, marginTop: 2 },

  blockRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: BORDER },
  blockAvatar:   { width: 40, height: 40, borderRadius: 20, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  blockAvatarImg:{ width: '100%', height: '100%' },
  blockAvatarTxt:{ color: '#fff', fontWeight: '700' },
  blockName:     { color: TEXT, fontSize: 15, fontWeight: '600' },
  blockEmail:    { color: SUBTLE, fontSize: 12, marginTop: 2 },
  unblockBtn:    { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: DANGER },
  unblockTxt:    { color: DANGER, fontSize: 12, fontWeight: '700' },

  emptySub:      { color: SUBTLE, fontSize: 13, lineHeight: 18, paddingVertical: 16 },

  // Data & account section
  dataBtn:       { marginTop: 8, padding: 12, borderRadius: 12, backgroundColor: CARD_BG, borderWidth: 1, borderColor: BORDER, alignItems: 'center' },
  dataBtnTxt:    { color: ACCENT, fontWeight: '700' },
  dataHint:      { color: SUBTLE, fontSize: 12, lineHeight: 16, marginTop: 6 },
  deleteBtn:     { marginTop: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: DANGER, alignItems: 'center' },
  deleteBtnTxt:  { color: DANGER, fontWeight: '700' },
});
