// app/contacts.tsx — Day 5 contact discovery.
//
// Flow:
//   1. Ask for the Contacts permission (Android + iOS)
//   2. Pull every address-book contact with at least one phone number
//   3. Hash each phone (digits-only, India default for 10-digit, SHA-256)
//      using the SAME normalize+hash we use server-side for users.phone_hash
//   4. POST /contacts/match — get the subset already on crazzychat
//   5. Render two sections:
//       * "On crazzychat"  — tap → opens or creates a direct chat
//       * "Invite to crazzychat" — fires the OS share sheet with an invite link
//
// Privacy: raw phone numbers never leave the device. Only SHA-256 hashes go
// over the wire, and the server only sees hashes for users who opted in to
// `discoverable=TRUE`.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  Share,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { type Palette } from '../constants/theme';
import { useTheme } from '../lib/theme';
import {
  createDirectChat,
  hashPhoneForLookup,
  matchContacts,
  type MatchedContact,
} from '../lib/chatService';
import { AppText as Text, AuroraBackground } from '../components/ui';

interface PhoneEntry {
  hash:        string;
  contactId:   string;
  contactName: string;
  rawPhone:    string;
}

interface MatchedRow extends MatchedContact {
  contactName?: string;
  rawPhone?:    string;
}

interface InviteRow {
  contactId:   string;
  contactName: string;
  rawPhone:    string;
}

const INVITE_URL = 'https://vaultchat.app/invite';

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ContactsScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  const [permission, setPermission]   = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [scanning,   setScanning]     = useState(false);
  const [matched,    setMatched]      = useState<MatchedRow[]>([]);
  const [invite,     setInvite]       = useState<InviteRow[]>([]);
  const [error,      setError]        = useState<string | null>(null);
  const [openingId,  setOpeningId]    = useState<string | null>(null);
  // Hashing is one async digest PER PHONE NUMBER, so a 1000-contact book is
  // minutes of work behind a spinner that never moves. Count it out loud.
  const [progress,   setProgress]     = useState<{ done: number; total: number } | null>(null);

  // ── Request permission + scan ─────────────────────────────
  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const { status, canAskAgain } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        setPermission('denied');
        if (!canAskAgain) {
          setError('Permission was denied. Enable Contacts access in system settings to find friends.');
        }
        return;
      }
      setPermission('granted');

      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
        pageSize: 0, // all
      });

      // Flatten to per-phone-number entries (one contact can have many phones)
      const withPhones = data.filter(c => c.phoneNumbers?.length);
      setProgress({ done: 0, total: withPhones.length });
      const entries: PhoneEntry[] = [];
      for (let i = 0; i < withPhones.length; i++) {
        const c = withPhones[i];
        const contactName = (c.name || '').trim() || 'Unknown';
        for (const p of c.phoneNumbers!) {
          const raw = p.number?.trim();
          if (!raw) continue;
          const hash = await hashPhoneForLookup(raw);
          if (!hash) continue;
          entries.push({ hash, contactId: c.id || raw, contactName, rawPhone: raw });
        }
        // Every 25, not every one: 1000 setStates would cost more than the work.
        if (i % 25 === 0 || i === withPhones.length - 1) setProgress({ done: i + 1, total: withPhones.length });
      }
      if (entries.length === 0) {
        setError('No phone numbers found in your contacts.');
        setMatched([]);
        setInvite([]);
        return;
      }

      // Dedupe hashes — same number can be in multiple contacts
      const hashToEntry = new Map<string, PhoneEntry>();
      for (const e of entries) {
        if (!hashToEntry.has(e.hash)) hashToEntry.set(e.hash, e);
      }
      const hashes = Array.from(hashToEntry.keys());

      // Server match in chunks of 1000 to stay well under the 5000 cap
      const results: MatchedContact[] = [];
      for (let i = 0; i < hashes.length; i += 1000) {
        const chunk = hashes.slice(i, i + 1000);
        try {
          const partial = await matchContacts(chunk);
          results.push(...partial);
        } catch (err: any) {
          console.warn('[contacts] match chunk failed:', err?.message);
        }
      }

      const matchedHashSet = new Set(results.map(r => r.phoneHash));
      const matchedRows: MatchedRow[] = results.map(r => {
        const e = hashToEntry.get(r.phoneHash);
        return { ...r, contactName: e?.contactName, rawPhone: e?.rawPhone };
      });

      const inviteByContact = new Map<string, InviteRow>();
      for (const e of entries) {
        if (matchedHashSet.has(e.hash)) continue;
        if (!inviteByContact.has(e.contactId)) {
          inviteByContact.set(e.contactId, {
            contactId:   e.contactId,
            contactName: e.contactName,
            rawPhone:    e.rawPhone,
          });
        }
      }
      const inviteRows = Array.from(inviteByContact.values())
        .sort((a, b) => a.contactName.localeCompare(b.contactName));

      matchedRows.sort((a, b) => (a.contactName || '').localeCompare(b.contactName || ''));

      setMatched(matchedRows);
      setInvite(inviteRows);
    } catch (e: any) {
      setError(e?.message ?? 'Contact scan failed');
    } finally {
      setScanning(false);
      setProgress(null);
    }
  }, []);

  useEffect(() => { scan(); }, [scan]);

  const openChat = useCallback(async (m: MatchedRow) => {
    setOpeningId(m.id);
    try {
      const res = await createDirectChat({ userId: m.id });
      router.replace({ pathname: '/chat', params: { id: res.id } } as any);
    } catch (e: any) {
      Alert.alert('Could not open chat', e?.message ?? 'Try again');
    } finally {
      setOpeningId(null);
    }
  }, [router]);

  const sendInvite = useCallback(async (row: InviteRow) => {
    const message = `Hey, I'm on crazzychat — encrypted messaging without the noise. Try it: ${INVITE_URL}`;
    try {
      const smsBody = encodeURIComponent(message);
      const smsUrl  = Platform.OS === 'ios'
        ? `sms:${row.rawPhone}&body=${smsBody}`
        : `sms:${row.rawPhone}?body=${smsBody}`;
      const can = await Linking.canOpenURL(smsUrl);
      if (can) {
        await Linking.openURL(smsUrl);
      } else {
        await Share.share({ message, title: 'Invite to crazzychat' });
      }
    } catch (e: any) {
      Alert.alert('Could not open invite', e?.message ?? 'Try again');
    }
  }, []);

  const sections = useMemo(() => ([
    { key: 'matched', title: `On crazzychat (${matched.length})`, data: matched },
    { key: 'invite',  title: `Invite to crazzychat (${invite.length})`, data: invite },
  ]), [matched, invite]);

  const renderItem = ({ item, section }: any) => {
    if (section === 'matched') {
      const m: MatchedRow = item;
      const initial = (m.contactName?.trim()[0] || m.name?.trim()[0] || '?').toUpperCase();
      return (
        <TouchableOpacity style={S.row} onPress={() => openChat(m)} activeOpacity={0.7} disabled={openingId === m.id}>
          <View style={[S.avatar, S.avatarOnApp]}><Text style={S.avatarTxt}>{initial}</Text></View>
          <View style={S.rowBody}>
            <Text style={S.rowName} numberOfLines={1}>{m.contactName || m.name || 'crazzychat user'}</Text>
            <Text style={S.rowSub} numberOfLines={1}>{m.rawPhone || 'On crazzychat'}</Text>
          </View>
          {openingId === m.id
            ? <ActivityIndicator color={colors.primary} />
            : <Text style={S.action}>Message →</Text>}
        </TouchableOpacity>
      );
    }
    const r: InviteRow = item;
    const initial = (r.contactName.trim()[0] || '?').toUpperCase();
    return (
      <TouchableOpacity style={S.row} onPress={() => sendInvite(r)} activeOpacity={0.7}>
        <View style={[S.avatar, S.avatarInvite]}><Text style={S.avatarTxt}>{initial}</Text></View>
        <View style={S.rowBody}>
          <Text style={S.rowName} numberOfLines={1}>{r.contactName}</Text>
          <Text style={S.rowSub} numberOfLines={1}>{r.rawPhone}</Text>
        </View>
        <Text style={[S.action, S.actionInvite]}>Invite</Text>
      </TouchableOpacity>
    );
  };

  const flat = useMemo(() => {
    const out: any[] = [];
    for (const s of sections) {
      if (s.data.length === 0) continue;
      out.push({ _header: true, key: 's-' + s.key, title: s.title });
      for (const item of s.data) {
        out.push({ ...item, _section: s.key });
      }
    }
    return out;
  }, [sections]);

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityLabel="Go back" onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title}>Contacts</Text>
        <TouchableOpacity accessibilityLabel="Refresh contacts" onPress={scan} disabled={scanning} style={S.refreshBtn} activeOpacity={0.7}>
          {scanning ? <Text style={S.refreshTxt}>…</Text> : <Ionicons name="refresh" size={22} color={colors.primary} />}
        </TouchableOpacity>
      </View>

      {scanning && matched.length === 0 && invite.length === 0 && (
        <View style={S.center}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={S.scanHint}>
            {progress
              ? `Scanning your address book… ${progress.done} of ${progress.total}`
              : 'Scanning your address book…'}
          </Text>
        </View>
      )}

      {permission === 'denied' && !scanning && (
        <View style={S.center}>
          <Text style={S.icon}>📇</Text>
          <Text style={S.heading}>Contacts permission needed</Text>
          <Text style={S.sub}>{error ?? 'Allow crazzychat to read your contacts so you can find friends who are on the app.'}</Text>
          <TouchableOpacity style={S.ctaBtn} onPress={scan} activeOpacity={0.85}>
            <Text style={S.ctaTxt}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}

      {error && permission === 'granted' && (
        <View style={S.errorBar}>
          <Text style={S.errorTxt}>{error}</Text>
        </View>
      )}

      {flat.length > 0 && (
        <FlatList
          data={flat}
          keyExtractor={(it, idx) => it._header ? it.key : `${it._section}-${it.id ?? it.contactId}-${idx}`}
          renderItem={({ item }) => item._header
            ? <Text numberOfLines={1} style={S.sectionHeader}>{item.title}</Text>
            : renderItem({ item, section: item._section })}
          // Device contact books run to thousands of rows; without these the
          // list mounts far more than it needs on first paint. No getItemLayout
          // here — header and contact rows have different heights.
          removeClippedSubviews
          initialNumToRender={14}
          maxToRenderPerBatch={12}
          updateCellsBatchingPeriod={60}
          windowSize={11}
        />
      )}
    </View>
  );
}


const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: HEADER_TOP, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.glassStroke, gap: 8 },
  backBtn:       { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backTxt:       { color: c.text, fontSize: 24 },
  title:         { color: c.text, fontSize: 18, fontWeight: '700', flex: 1 },
  refreshBtn:    { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  refreshTxt:    { color: c.primary, fontSize: 22, fontWeight: '700' },

  center:        { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  icon:          { fontSize: 56, marginBottom: 8 },
  heading:       { color: c.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  sub:           { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 8 },
  scanHint:      { color: c.textDim, fontSize: 13, marginTop: 8 },

  errorBar:      { backgroundColor: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.4)', borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, borderRadius: 10 },
  errorTxt:      { color: c.danger, fontSize: 12 },

  sectionHeader: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },

  row:           { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 12, gap: 12, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  avatar:        { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarOnApp:   { backgroundColor: c.primary },
  avatarInvite:  { backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  avatarTxt:     { color: '#fff', fontSize: 16, fontWeight: '700' },
  rowBody:       { flex: 1 },
  rowName:       { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:        { color: c.textDim, fontSize: 12, marginTop: 2 },
  action:        { color: c.primary, fontSize: 13, fontWeight: '600' },
  actionInvite:  { color: c.textDim },

  ctaBtn:        { marginTop: 16, backgroundColor: c.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  ctaTxt:        { color: '#fff', fontWeight: '700', fontSize: 14 },
});
