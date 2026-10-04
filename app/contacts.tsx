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
//         (with `?mode=call`, from the Calls tab: tap → voice or video call)
//       * "Invite to crazzychat" — fires the OS share sheet with an invite link
//
// Privacy: numbers are sent as UNSALTED SHA-256 hashes. That hides them from
// casual reading but not from anyone who enumerates the (small) phone-number
// space, so do not describe this as "numbers never leave the device". The
// server peppers each submitted hash (HMAC with a server-only secret) before
// comparing, so a leaked users table is not rainbow-tableable, and caps hashes
// per account per day — see the comment above hashPhoneForLookup in
// lib/chatService.ts and vaultchat-backend-go/internal/routes/contacts.go.
// The server only matches users who opted in to `discoverable=TRUE`.
//
// The result is cached (sealed, lib/localCache) for a day, so reopening this
// screen does not re-hash the whole address book or spend the daily match
// quota; the refresh button rescans on demand.

import { HEADER_TOP } from '../constants/layout';
import { Ionicons } from '@expo/vector-icons';
import * as Contacts from 'expo-contacts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  SectionList,
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
import { initialOf } from '../lib/format';
import { readSealedCache, writeSealedCache } from '../lib/localCache';
import { tint } from '../lib/tintColor';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

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

const CACHE_KEY = 'contacts-match-v1';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
type CachedScan = { at: number; matched: MatchedRow[]; invite: InviteRow[] };

type Section =
  | { key: 'matched'; title: string; data: MatchedRow[] }
  | { key: 'invite'; title: string; data: InviteRow[] };

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ContactsScreen() {
  const { colors } = useTheme();
  const S = useS();
  const router = useRouter();
  // 'call' when opened from the Calls tab's "New call": a match places a call
  // instead of opening a chat.
  const callMode = useLocalSearchParams<{ mode?: string }>().mode === 'call';
  const [permission, setPermission]   = useState<'unknown' | 'granted' | 'denied'>('unknown');
  const [scanning,   setScanning]     = useState(false);
  const [matched,    setMatched]      = useState<MatchedRow[]>([]);
  const [invite,     setInvite]       = useState<InviteRow[]>([]);
  const [error,      setError]        = useState<string | null>(null);
  // Permanently denied: "Try again" cannot re-prompt, so offer Settings instead.
  const [blocked,    setBlocked]      = useState(false);
  const [openingId,  setOpeningId]    = useState<string | null>(null);
  // Hashing is one async digest PER PHONE NUMBER, so a 1000-contact book is
  // minutes of work behind a spinner that never moves. Count it out loud.
  const [progress,   setProgress]     = useState<{ done: number; total: number } | null>(null);
  // When the rows on screen were matched (from the cache or a scan just now).
  const [scannedAt,  setScannedAt]    = useState<number | null>(null);

  // A scan can run for minutes on a large address book: leaving the screen
  // stops the hashing loop and every later state update.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // ── Request permission + scan ─────────────────────────────
  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const { status, canAskAgain } = await Contacts.requestPermissionsAsync();
      if (!alive.current) return;
      if (status !== 'granted') {
        setPermission('denied');
        setBlocked(!canAskAgain);
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
      if (!alive.current) return;

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
        if (!alive.current) return;
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
      let chunkFailed = false;
      for (let i = 0; i < hashes.length; i += 1000) {
        const chunk = hashes.slice(i, i + 1000);
        try {
          const partial = await matchContacts(chunk);
          results.push(...partial);
        } catch (err: unknown) {
          chunkFailed = true;
          console.warn('[contacts] match chunk failed:', errText(err, String(err)));
        }
        if (!alive.current) return;
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
      // A failed chunk means we do not know who is on the app: listing those
      // contacts under "Invite" would be wrong, so show the error instead.
      setInvite(chunkFailed ? [] : inviteRows);
      if (chunkFailed) setError("Couldn't check all your contacts — you may be offline.");
      else {
        // Only a complete scan is cached; a partial one would hide contacts.
        const at = Date.now();
        setScannedAt(at);
        writeSealedCache<CachedScan>(CACHE_KEY, { at, matched: matchedRows, invite: inviteRows });
      }
    } catch (e: unknown) {
      if (alive.current) setError(errText(e, 'Contact scan failed'));
    } finally {
      if (alive.current) { setScanning(false); setProgress(null); }
    }
  }, []);

  // Paint the last complete scan when there is a fresh one and access is still
  // granted (a revoked permission must not keep showing the address book);
  // otherwise scan. The refresh button always rescans.
  useEffect(() => {
    let cancel = false;
    (async () => {
      const perm = await Contacts.getPermissionsAsync().catch(() => null);
      const cached = perm?.status === 'granted' ? await readSealedCache<CachedScan>(CACHE_KEY) : null;
      if (cancel) return;
      if (cached && Date.now() - cached.at < CACHE_MAX_AGE_MS) {
        setPermission('granted');
        setMatched(cached.matched ?? []);
        setInvite(cached.invite ?? []);
        setScannedAt(cached.at);
        return;
      }
      scan();
    })();
    return () => { cancel = true; };
  }, [scan]);

  const openChat = useCallback(async (m: MatchedRow, call?: 'voice' | 'video') => {
    if (openingId) return;
    setOpeningId(m.id);
    try {
      const res = await createDirectChat({ userId: m.id });
      if (call) {
        // Same params the Calls tab uses to redial (calls.tsx `call`).
        router.replace({
          pathname: call === 'video' ? '/videocall' : '/voicecall',
          params: { chatId: res.id, peerUid: m.id, peerName: m.contactName || m.name || 'crazzychat user' },
        });
      } else {
        router.replace({ pathname: '/chat', params: { id: res.id } });
      }
    } catch (e: unknown) {
      Alert.alert(call ? 'Could not start the call' : 'Could not open chat', errText(e, 'Try again'));
    } finally {
      setOpeningId(null);
    }
  }, [router, openingId]);

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
    } catch (e: unknown) {
      Alert.alert('Could not open invite', errText(e, 'Try again'));
    }
  }, []);

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    if (matched.length) out.push({ key: 'matched', title: `On crazzychat (${matched.length})`, data: matched });
    if (invite.length) out.push({ key: 'invite', title: `Invite to crazzychat (${invite.length})`, data: invite });
    return out;
  }, [matched, invite]);

  const renderItem = ({ item, section }: { item: MatchedRow | InviteRow; section: Section }) => {
    if (section.key === 'matched') {
      const m = item as MatchedRow;
      const initial = initialOf(m.contactName, m.name);
      const who = m.contactName || m.name || 'crazzychat user';
      // Call mode: Voice and Video are buttons on the row itself (was an Alert).
      if (callMode) {
        const busy = openingId === m.id;
        return (
          <View style={S.row}>
            <View style={[S.avatar, S.avatarOnApp]}><Text style={S.avatarTxt}>{initial}</Text></View>
            <View style={S.rowBody}>
              <Text style={S.rowName} numberOfLines={1}>{who}</Text>
              <Text style={S.rowSub} numberOfLines={1}>{m.rawPhone || 'On crazzychat'}</Text>
            </View>
            {busy ? <ActivityIndicator color={colors.primary} accessibilityLabel={`Calling ${who}`} /> : (['voice', 'video'] as const).map(kind => (
              <TouchableOpacity key={kind} style={S.callBtn} onPress={() => openChat(m, kind)} disabled={!!openingId}
                accessibilityRole="button" accessibilityLabel={`${kind === 'video' ? 'Video' : 'Voice'} call ${who}`}
                accessibilityState={{ disabled: !!openingId }}>
                <Ionicons name={kind === 'video' ? 'videocam-outline' : 'call-outline'} size={22} color={colors.primary} />
              </TouchableOpacity>
            ))}
          </View>
        );
      }
      return (
        <TouchableOpacity style={S.row} onPress={() => openChat(m)} activeOpacity={0.7} disabled={openingId === m.id}
          accessibilityRole="button"
          accessibilityLabel={`${who}. Message`}
          accessibilityState={{ busy: openingId === m.id }}>
          <View style={[S.avatar, S.avatarOnApp]}><Text style={S.avatarTxt}>{initial}</Text></View>
          <View style={S.rowBody}>
            <Text style={S.rowName} numberOfLines={1}>{who}</Text>
            <Text style={S.rowSub} numberOfLines={1}>{m.rawPhone || 'On crazzychat'}</Text>
          </View>
          {openingId === m.id
            ? <ActivityIndicator color={colors.primary} />
            : <Text style={S.action}>Message →</Text>}
        </TouchableOpacity>
      );
    }
    const r = item as InviteRow;
    const initial = initialOf(r.contactName);
    return (
      <TouchableOpacity style={S.row} onPress={() => sendInvite(r)} activeOpacity={0.7}
        accessibilityRole="button" accessibilityLabel={`${r.contactName}. Invite to crazzychat`}>
        <View style={[S.avatar, S.avatarInvite]}><Text style={[S.avatarTxt, S.avatarInviteTxt]}>{initial}</Text></View>
        <View style={S.rowBody}>
          <Text style={S.rowName} numberOfLines={1}>{r.contactName}</Text>
          <Text style={S.rowSub} numberOfLines={1}>{r.rawPhone}</Text>
        </View>
        <Text style={[S.action, S.actionInvite]}>Invite</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={S.screen}>
      <AuroraBackground />
      <View style={S.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={S.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={S.title} accessibilityRole="header">{callMode ? 'New call' : 'Contacts'}</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Rescan contacts" onPress={scan} disabled={scanning} style={S.refreshBtn} activeOpacity={0.7}
          accessibilityState={{ disabled: scanning, busy: scanning }}>
          {scanning ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="refresh" size={22} color={colors.primary} />}
        </TouchableOpacity>
      </View>

      {scannedAt != null && !scanning && sections.length > 0 && (
        <Text style={S.scannedAt}>
          Checked {new Date(scannedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · tap refresh to rescan
        </Text>
      )}

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
          <Text style={S.icon} accessible={false} importantForAccessibility="no">📇</Text>
          <Text style={S.heading} accessibilityRole="header">Contacts permission needed</Text>
          <Text style={S.sub}>{error ?? 'Allow crazzychat to read your contacts so you can find friends who are on the app.'}</Text>
          <TouchableOpacity style={S.ctaBtn} onPress={blocked ? () => { Linking.openSettings().catch(() => {}); } : scan} activeOpacity={0.85} accessibilityRole="button">
            <Text style={S.ctaTxt}>{blocked ? 'Open settings' : 'Try again'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* The bar is the retry itself (its copy used to point at the refresh button). */}
      {error && permission === 'granted' && (
        <TouchableOpacity style={S.errorBar} onPress={scan} disabled={scanning} accessibilityLiveRegion="polite"
          accessibilityRole="button" accessibilityLabel={`${error} Tap to scan again`} accessibilityState={{ disabled: scanning, busy: scanning }}>
          <Text style={S.errorTxt}>{error} Tap to scan again.</Text>
        </TouchableOpacity>
      )}

      {sections.length > 0 && (
        <SectionList<MatchedRow | InviteRow, Section>
          sections={sections}
          keyExtractor={(it, idx) => ('id' in it ? `m-${it.id}` : `i-${it.contactId}`) + `-${idx}`}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => <Text numberOfLines={1} style={S.sectionHeader} accessibilityRole="header">{section.title}</Text>}
          stickySectionHeadersEnabled={false}
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
  backBtn:       { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title:         { color: c.text, fontSize: 18, fontWeight: '700', flex: 1 },
  refreshBtn:    { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scannedAt:     { color: c.textFaint, fontSize: 12, paddingHorizontal: 20, paddingTop: 8 },

  center:        { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 12 },
  icon:          { fontSize: 56, marginBottom: 8 },
  heading:       { color: c.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  sub:           { color: c.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 8 },
  scanHint:      { color: c.textDim, fontSize: 13, marginTop: 8 },

  errorBar:      { backgroundColor: tint(c.danger, 0.12), borderColor: tint(c.danger, 0.4), borderWidth: 1, marginHorizontal: 16, marginTop: 8, padding: 10, minHeight: 44, justifyContent: 'center', borderRadius: 10 },
  errorTxt:      { color: c.danger, fontSize: 12 },

  sectionHeader: { color: c.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8 },

  row:           { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 8, paddingHorizontal: 14, paddingVertical: 12, gap: 12, borderRadius: 16, backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: c.glassStroke },
  avatar:        { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarOnApp:   { backgroundColor: c.primary },
  avatarInvite:  { backgroundColor: c.glassSoft, borderWidth: 1, borderColor: c.glassStroke },
  avatarTxt:     { color: c.onPrimary, fontSize: 16, fontWeight: '700' },
  // The invite disc is glass, not accent: white initials vanished on it in light mode.
  avatarInviteTxt: { color: c.text },
  rowBody:       { flex: 1 },
  rowName:       { color: c.text, fontSize: 15, fontWeight: '600' },
  rowSub:        { color: c.textDim, fontSize: 12, marginTop: 2 },
  action:        { color: c.primary, fontSize: 13, fontWeight: '600' },
  actionInvite:  { color: c.textDim },
  callBtn:       { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  ctaBtn:        { marginTop: 16, backgroundColor: c.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  ctaTxt:        { color: c.onPrimary, fontWeight: '700', fontSize: 14 },
});
