// app/invite-link.tsx — Generate & manage group invite links (Postgres-backed).
//
// Backed by /chats/:id/invite-links (create/list/revoke) and POST /chats/join/:code.
// Links look like https://vaultchat.app/join/CODE. Admins set an optional
// expiry and revoke anytime. No Firestore.

import { HEADER_TOP } from '../constants/layout';
import { brandAlpha, type Palette } from '../constants/theme';
import React, { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, TouchableOpacity, StyleSheet, FlatList, Alert, Share, ActivityIndicator, Modal, RefreshControl } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { QR_COLORS } from '../constants/qrPalette';
import { useTheme } from '../lib/theme';
import { copyAndAutoClear } from '../lib/clipboardSafe';
import { listInviteLinks, createInviteLink, revokeInviteLink, type InviteLink } from '../lib/chatService';
import { AuroraBackground } from '../components/ui';
import { AppText as Text } from '../components/ui/Text';
import { tint } from '../lib/tintColor';
import { userErrorText } from '../lib/userErrorText';

const JOIN_BASE = 'https://vaultchat.app/join/';
const EXPIRY_OPTS = [
  { label: 'Permanent', hours: 0 },
  { label: '1 hour', hours: 1 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 168 },
];

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

const isExpired = (l: InviteLink) => !!l.expiresAt && new Date(l.expiresAt).getTime() < Date.now();

function formatExpiry(iso: string | null): string {
  if (!iso) return 'Never expires';
  const d = new Date(iso);
  if (d.getTime() < Date.now()) return 'Expired';
  const hrs = Math.round((d.getTime() - Date.now()) / 3600000);
  return hrs < 24 ? `${hrs}h remaining` : `${Math.round(hrs / 24)}d remaining`;
}

type LinkAction = (link: InviteLink) => void;

/** One invite link. Hoisted and memoised: the screen passes stable handlers. */
/** The screen's styles are passed in: one StyleSheet per screen, not per row. */
const LinkRow = memo(function LinkRow({ item, revokeBusy, onCopy, onShare, onQr, onRevoke, s }: {
  item: InviteLink; revokeBusy: boolean;
  onCopy: LinkAction; onShare: LinkAction; onQr: LinkAction; onRevoke: LinkAction;
  s: ReturnType<typeof makeStyles>;
}) {
  const { colors } = useTheme();
  // An expired link no longer works either: nothing to copy, share or show.
  const dead = item.revoked || isExpired(item);
  return (
    <View style={[s.linkRow, dead && { opacity: 0.45 }]}>
      <Text style={s.linkCode} numberOfLines={1}>vaultchat.app/join/{item.code}</Text>
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
        <Text style={s.linkMeta}>{item.uses} joins</Text>
        <Text style={s.linkMeta}>{formatExpiry(item.expiresAt)}</Text>
        {item.revoked && <Text style={[s.linkMeta, { color: colors.danger }]}>Revoked</Text>}
      </View>
      {!dead && (
        <View style={s.linkBtns}>
          <TouchableOpacity style={s.linkBtn} accessibilityRole="button" accessibilityLabel={`Copy link ${item.code}`} onPress={() => onCopy(item)}>
            <Ionicons name="copy-outline" size={15} color={colors.text} />
            <Text style={s.linkBtnTxt}>Copy</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.linkBtn} accessibilityRole="button" accessibilityLabel={`Share link ${item.code}`} onPress={() => onShare(item)}>
            <Ionicons name="share-social-outline" size={15} color={colors.text} />
            <Text style={s.linkBtnTxt}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.linkBtn} accessibilityRole="button" accessibilityLabel={`Show QR code for link ${item.code}`} onPress={() => onQr(item)}>
            <Ionicons name="qr-code-outline" size={15} color={colors.text} />
            <Text style={s.linkBtnTxt}>QR</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.linkBtn} accessibilityRole="button" accessibilityLabel={`Revoke link ${item.code}`} onPress={() => onRevoke(item)}
            disabled={revokeBusy} accessibilityState={{ disabled: revokeBusy }}>
            <Ionicons name="trash-outline" size={15} color={colors.danger} />
            <Text style={[s.linkBtnTxt, { color: colors.danger }]}>Revoke</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

export default function InviteLinkScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const { chatId, groupName } = useLocalSearchParams<{ chatId: string; groupName: string }>();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // One revoke request at a time: a second row's Revoke waits for the first.
  const [revokingId, setRevokingId] = useState<InviteLink['id'] | null>(null);

  const load = useCallback(async () => {
    // A missing id used to render an empty list, indistinguishable from "no links".
    if (!chatId) { setError('This screen did not say which group to show.'); setLoading(false); return; }
    try { setLinks(await listInviteLinks(chatId)); setError(null); }
    catch (e: unknown) { setError(userErrorText(e, 'Failed to load links')); }
    finally { setLoading(false); }
  }, [chatId]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const createLink = async (hours: number, confirmed = false) => {
    if (!chatId || creating) return;
    // A permanent link is a credential that never expires and lets anyone in.
    if (hours <= 0 && !confirmed) {
      Alert.alert(
        'Create a permanent link?',
        'Anyone who gets this link can join until you revoke it. A link with an expiry is safer.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Create permanent link', style: 'destructive', onPress: () => { createLink(hours, true); } },
        ],
      );
      return;
    }
    setCreating(true);
    try {
      const link = await createInviteLink(chatId, { expiresInHours: hours });
      setLinks(prev => [link, ...prev]);
      Alert.alert('Link created', JOIN_BASE + link.code);
    } catch (e: unknown) {
      Alert.alert('Error', userErrorText(e, 'Could not create link'));
    } finally {
      setCreating(false);
    }
  };

  const shareLink = useCallback(async ({ code }: InviteLink) => {
    try {
      await Share.share({ message: `Join ${groupName || 'our group'} on crazzychat!\n${JOIN_BASE}${code}` });
    } catch {
      Alert.alert('Could not share', 'Try again, or use Copy.');
    }
  }, [groupName]);

  const copyLink = useCallback(async ({ code }: InviteLink) => {
    try {
      await copyAndAutoClear(JOIN_BASE + code);
      Alert.alert('Copied', 'Invite link copied to clipboard');
    } catch {
      Alert.alert('Could not copy', 'Try again, or use Share.');
    }
  }, []);

  const showQr = useCallback(({ code }: InviteLink) => setQrCode(code), []);

  // Read through a ref so `revoke` stays stable for the memoised rows, and the
  // guard is re-checked at confirm time (another revoke may have started).
  const revokingRef = useRef(revokingId);
  revokingRef.current = revokingId;
  const revoke = useCallback((link: InviteLink) => {
    if (revokingRef.current != null) return;
    Alert.alert('Revoke link?', 'This link will no longer work.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Revoke', style: 'destructive', onPress: async () => {
        if (revokingRef.current != null) return;
        revokingRef.current = link.id;
        setRevokingId(link.id);
        setLinks(list => list.map(l => l.id === link.id ? { ...l, revoked: true } : l));
        try { await revokeInviteLink(chatId!, link.id); }
        catch (e: unknown) {
          // Undo only this row: restoring a snapshot taken at the tap would also
          // undo anything else that changed meanwhile (a new link, another revoke).
          setLinks(list => list.map(l => l.id === link.id ? { ...l, revoked: link.revoked } : l));
          Alert.alert('Error', userErrorText(e, 'Revoke failed'));
        } finally {
          setRevokingId(null);
        }
      } },
    ]);
  }, [chatId]);

  // Expired links still list (with "Expired") but are not active.
  const activeCount = useMemo(() => links.filter(l => !l.revoked && !isExpired(l)).length, [links]);

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.title} accessibilityRole="header">Invite Links</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="link-outline" size={22} color={colors.text} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>{groupName || 'Group'} Invite Links</Text>
            <Text style={s.infoDesc}>Anyone with this link can join. Set an expiry or revoke anytime.</Text>
          </View>
        </View>

        {error && (
          <TouchableOpacity style={s.errorBar} onPress={() => { if (chatId) { setLoading(true); load(); } }} disabled={!chatId}
            accessibilityRole={chatId ? 'button' : 'text'} accessibilityLabel={chatId ? `${error}. Tap to retry` : error}>
            <Text style={s.errorTxt}>{error}{chatId ? ' Tap to retry.' : ''}</Text>
          </TouchableOpacity>
        )}

        <Text style={s.sectionTitle}>CREATE NEW LINK</Text>
        <View style={s.createRow}>
          {EXPIRY_OPTS.map(opt => (
            <TouchableOpacity key={opt.label} style={s.createOpt} onPress={() => createLink(opt.hours)} disabled={creating || !chatId}
              accessibilityRole="button" accessibilityLabel={`Create ${opt.label.toLowerCase()} link`} accessibilityState={{ disabled: creating || !chatId }}>
              <Text style={s.createOptTxt}>{opt.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {creating && <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />}

        {/* The list holds revoked and expired links too, so the title counts
            only the ones that still work. */}
        <Text style={[s.sectionTitle, { marginTop: 16 }]}>LINKS · {activeCount} ACTIVE</Text>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
        ) : (
          <FlatList
            data={links}
            keyExtractor={l => String(l.id)}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
            renderItem={({ item }) => (
              <LinkRow item={item} revokeBusy={revokingId != null} s={s}
                onCopy={copyLink} onShare={shareLink} onQr={showQr} onRevoke={revoke} />
            )}
            ListEmptyComponent={<View style={{ alignItems: 'center', padding: 30 }}><Text style={s.empty}>No invite links yet</Text></View>}
          />
        )}
      </View>

      {/* QR for an invite link — scannable from the other device's camera */}
      <Modal visible={qrCode != null} transparent animationType="fade" onRequestClose={() => setQrCode(null)}>
        <View style={s.qrBackdrop}>
          <View style={s.qrCard} accessibilityViewIsModal>
            <Text style={s.qrTitle} accessibilityRole="header">Scan to join {groupName || 'group'}</Text>
            <View style={s.qrBox} accessible accessibilityRole="image" accessibilityLabel={`QR code for the invite link vaultchat.app/join/${qrCode ?? ''}`}>
              {qrCode && <QRCode value={JOIN_BASE + qrCode} size={220} {...QR_COLORS} quietZone={20} />}
            </View>
            <Text style={s.qrCode} numberOfLines={1}>vaultchat.app/join/{qrCode}</Text>
            <TouchableOpacity style={s.qrClose} onPress={() => setQrCode(null)} accessibilityRole="button">
              <Text style={s.qrCloseTxt}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 12 },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: c.glassStroke },
  infoTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  infoDesc: { color: c.textDim, fontSize: 12, marginTop: 2 },
  errorBar: { backgroundColor: tint(c.danger, 0.12), borderColor: tint(c.danger, 0.4), borderWidth: 1, padding: 10, borderRadius: 10, marginBottom: 12 },
  errorTxt: { color: c.danger, fontSize: 12 },
  sectionTitle: { color: c.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
  createRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  createOpt: { backgroundColor: brandAlpha(0.13), borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center', borderWidth: 1, borderColor: brandAlpha(0.3) },
  createOptTxt: { color: c.primary, fontSize: 12, fontWeight: '700' },
  linkRow: { backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: c.glassStroke },
  linkCode: { color: c.text, fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  linkMeta: { color: c.textDim, fontSize: 11 },
  linkBtns: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7, minHeight: 44, borderRadius: 8, borderWidth: 1, borderColor: c.glassStroke, backgroundColor: c.glassSoft },
  linkBtnTxt: { color: c.text, fontSize: 11, fontWeight: '700' },
  empty: { color: c.textDim, fontSize: 13 },
  // Scrim behind the modal: dark in both themes so the QR card stands out.
  qrBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  qrCard: { backgroundColor: c.glassSoft, borderRadius: 24, padding: 24, alignItems: 'center', width: '100%', maxWidth: 320, borderWidth: 1, borderColor: c.glassStroke },
  qrTitle: { color: c.text, fontSize: 16, fontWeight: '800', marginBottom: 16, textAlign: 'center' },
  // The QR draws its own white quiet zone (quietZone={20}, about 3-4 modules):
  // this box is the theme's surface, dark in dark mode, and scanners need light round the code.
  qrBox: { backgroundColor: c.glassSoft, padding: 16, borderRadius: 16 },
  qrCode: { color: c.textDim, fontSize: 12, fontFamily: 'monospace', marginTop: 16 },
  qrClose: { marginTop: 20, paddingVertical: 12, paddingHorizontal: 40, borderRadius: 14, backgroundColor: c.primary },
  qrCloseTxt: { color: c.onPrimary, fontSize: 15, fontWeight: '800' },
});
