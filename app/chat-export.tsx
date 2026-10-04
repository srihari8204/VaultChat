// app/chat-export.tsx — Export Chat as Text/HTML (Postgres-backed).
//
// Pulls the full message history via GET /chats/:id/messages (keyset
// pagination), unions it with the device's own history, decrypts it through
// the same hydrateMessages funnel the chat screen uses, formats it on-device,
// and shares via the system sheet. The file is written to the cache directory
// and deleted once the share sheet returns. Nothing leaves the device except
// through the user-initiated share.

import { HEADER_TOP } from '../constants/layout';
import React, { useEffect, useState , useMemo, useRef} from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Modal, TextInput } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
// BRAND_ACCENT styles the exported HTML file only (a fixed dark document), not the app UI.
import { type Palette, BRAND_ACCENT } from '../constants/theme';
import { useTheme } from '../lib/theme';
import { getChat, getMessages, hydrateMessages, looksEncrypted, type Message } from '../lib/chatService';
import { unionWithLocalHistoryAsc } from '../lib/messageHistory';
import {
  exportBody, exportHtmlHead, exportHtmlLine, exportTextHead, exportTextLine, EXPORT_HTML_TAIL, type ExportLineCtx,
} from '../lib/chatExportFormat';
import { ExportCancelled, shareExportFile, writeExportFile } from '../components/chattools/chatExportFile';
import { getCurrentUserAsync } from './(constants)/authService';
import { getLock, pinRetryAfterMs, verifyBiometric, verifyPin, type LockedChat } from '../lib/chatLock';
import { AuroraBackground } from '../components/ui';
import { KeyboardSafe } from '../components/ui/KeyboardSafe';

const PAGE = 200;
const MAX_PAGES = 500;

// Fetch every message (oldest→newest) by walking the keyset cursor, then
// UNION the device's own cache.
//
// The server is not the whole history. delete-on-delivery sets content = NULL
// once every recipient acks, so an export built from /chats/:id/messages
// alone silently omits everything past the retention window — and an export
// is exactly where a silent omission is worst, because the user believes
// they now hold a complete archive. The local cache still has those bodies.
//
// Server rows are E2EE envelopes. The union prefers our readable local copy
// over an envelope (isCipher), and whatever is still an envelope afterwards
// goes through hydrateMessages — the chat screen's decrypt path — so the
// export never contains ciphertext (exportBody also refuses to print it).
// `cancelled` is checked between pages, so Cancel (or leaving) stops the walk.
async function fetchAll(
  chatId: string,
  on: { count: (n: number) => void; phase: (p: string) => void; cancelled: () => boolean },
): Promise<{ msgs: Message[]; truncated: boolean }> {
  const all: Message[] = [];
  let before: number | undefined;
  let truncated = true;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (on.cancelled()) throw new ExportCancelled();
    const page = await getMessages(chatId, { before, limit: PAGE });
    all.push(...page);
    on.count(all.length);
    if (page.length < PAGE) { truncated = false; break; }
    before = page[page.length - 1].id; // oldest id in this (desc) page
  }
  if (on.cancelled()) throw new ExportCancelled();
  const merged = await unionWithLocalHistoryAsc(chatId, all, undefined, looksEncrypted);
  on.phase('Decrypting messages…');
  // hydrateMessages expects newest-first.
  const hydrated = (await hydrateMessages(chatId, [...merged].reverse())).reverse();
  on.count(hydrated.length);
  return { msgs: hydrated, truncated };
}

const fmtTime = (iso: string) => { try { return new Date(iso).toLocaleString(); } catch { return ''; } };
const bodyOf = (m: Message): string => exportBody(m, looksEncrypted);
const fileName = (peerName: string, ext: string) =>
  'crazzychat_' + peerName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.' + ext;

function useS() {
  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function ChatExportScreen() {
  const { colors } = useTheme();
  const s = useS();
  const router = useRouter();
  const params = useLocalSearchParams<{ chatId?: string; id?: string; peerName?: string }>();
  const chatId = String(params.chatId ?? params.id ?? '');
  const peerName = (params.peerName as string) || 'Chat';

  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [msgCount, setMsgCount] = useState(0);
  // Synchronous re-entry guard: `exporting` state is only set after the
  // (async) lock/confirm gate, so a double tap could start two exports.
  const busyRef = useRef(false);

  // Cancel button and unmount both stop a running export between pages/chunks;
  // `mounted` keeps a late step from setting state on a closed screen.
  const cancelRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; cancelRef.current = true; }, []);
  const cancelled = () => cancelRef.current;
  const live = <T,>(set: (v: T) => void) => (v: T) => { if (mounted.current) set(v); };

  // Group exports name each sender; filled per export from the chat's members.
  const namesRef = useRef<Map<string, string>>(new Map());
  const lineCtx = (myId: string): ExportLineCtx<Message> => ({
    label: (m) => (m.senderId === myId ? 'You' : namesRef.current.get(m.senderId) || peerName),
    mine: (m) => m.senderId === myId,
    time: fmtTime,
    body: bodyOf,
  });

  // ── Export gate ───────────────────────────────────────────────────
  // An export turns a chat that is protected by biometrics/PIN into a plain
  // .txt or .html on the shared filesystem, and it was reachable in two taps
  // with no check at all — including for a chat the user had explicitly locked.
  // So: a locked chat must satisfy its OWN lock (the same method app/chat.tsx
  // enforces) every time, and an unlocked chat gets an explicit confirmation of
  // what is about to leave the vault. Normal exports still work in two taps
  // plus a confirm.
  const [pinPrompt, setPinPrompt] = useState<LockedChat | null>(null);
  const [pin, setPin] = useState('');
  // The message, not a flag: during the wrong-PIN backoff verifyPin refuses
  // even a correct PIN, and "Incorrect PIN" would be untrue then.
  const [pinErr, setPinErr] = useState<string | null>(null);
  const pinResolve = useRef<((ok: boolean) => void) | null>(null);

  const askPin = (lock: LockedChat) => new Promise<boolean>(resolve => {
    pinResolve.current = resolve;
    setPin(''); setPinErr(null); setPinPrompt(lock);
  });
  const closePin = (ok: boolean) => {
    setPinPrompt(null); setPin(''); setPinErr(null);
    pinResolve.current?.(ok); pinResolve.current = null;
  };
  const submitPin = () => {
    if (!pinPrompt) return;
    if (verifyPin(pinPrompt, pin)) { closePin(true); return; }
    const wait = pinRetryAfterMs(pinPrompt);
    setPin('');
    setPinErr(wait > 0 ? `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.` : 'Incorrect PIN.');
  };

  const confirm = (title: string, message: string) => new Promise<boolean>(resolve => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Export', style: 'destructive', onPress: () => resolve(true) },
    ], { onDismiss: () => resolve(false) });
  });

  const authorizeExport = async (): Promise<boolean> => {
    // FAIL CLOSED. getAllLocks now throws when the lock table cannot be read,
    // instead of reporting "nothing is locked". An export is a full plaintext
    // dump of the conversation, so an unreadable lock table must block it, not
    // wave it through (2026-09-17).
    let lock: LockedChat | null = null;
    try {
      lock = await getLock(chatId);
    } catch {
      Alert.alert('Export blocked', 'The chat lock settings could not be read, so this export cannot be authorised.');
      return false;
    }
    if (!lock) {
      return confirm(
        'Export this chat?',
        'The exported file is NOT encrypted. Anyone who can open the file can read the whole conversation.',
      );
    }
    // Locked chat — satisfy the lock first, then still confirm.
    //
    // 'both' MEANS BOTH. This used to take the first factor that passed: a
    // biometric OR a PIN, whichever answered, was enough for a full plaintext
    // dump. The user who picked the strongest setting was getting the weakest
    // enforcement (2026-09-17).
    const deny = () => {
      Alert.alert('Export blocked', 'This chat is locked. Unlock it to export.');
      return false;
    };
    const m = lock.lockMethod;
    const bioOk = (m === 'biometric' || m === 'both')
      ? await verifyBiometric('Unlock to export this chat')
      : false;
    if (m === 'both' && !bioOk) return deny();
    // The PIN is REQUIRED for 'pin' and 'both' (for 'both' it is a second
    // factor, never a substitute for the fingerprint above). For 'biometric' it
    // stays what it always was — the fallback when the sensor says no, which is
    // also the only route left on web now that verifyBiometric fails closed there.
    if (m !== 'biometric' || !bioOk) {
      if (!lock.pinHash) return deny();
      if (!(await askPin(lock))) return deny();
    }
    return confirm(
      'Export a LOCKED chat?',
      'This chat is protected by a lock. The exported file is NOT encrypted and is not protected by that lock.',
    );
  };

  const guard = async (fn: (msgs: Message[], myId: string) => Promise<void>) => {
    if (!chatId) { Alert.alert('Export failed', 'Missing chat id.'); return; }
    if (busyRef.current) return;
    busyRef.current = true;
    cancelRef.current = false;
    try {
      if (!(await authorizeExport())) return;
      setExporting(true);
      setProgress('Fetching messages…');
      setMsgCount(0);
      const me = await getCurrentUserAsync();
      try {
        const detail = await getChat(chatId);
        namesRef.current = new Map(detail.members.map(mm => [mm.userId, mm.name || mm.email || '']));
      } catch { namesRef.current = new Map(); }   // names are cosmetic; peerName is the fallback
      const { msgs, truncated } = await fetchAll(chatId, {
        count: live(setMsgCount), phase: live(setProgress), cancelled,
      });
      // Say so BEFORE the file is shared, while the user can still decide.
      if (truncated && !(await confirm(
        'Export incomplete',
        `Only the newest ${MAX_PAGES * PAGE} messages from the server can be included, plus older ones saved on this device. Export anyway?`,
      ))) return;
      if (cancelled()) return;
      live(setProgress)('Writing ' + msgs.length + ' messages…');
      await fn(msgs, me?.id ?? '');
      live(setProgress)('');
    } catch (e: any) {
      if (!(e instanceof ExportCancelled) && mounted.current) Alert.alert('Export failed', e?.message ?? 'Something went wrong');
    } finally {
      busyRef.current = false;
      live(setExporting)(false);
    }
  };

  const exportAsText = () => guard(async (msgs, myId) => {
    const ctx = lineCtx(myId);
    const uri = await writeExportFile(
      fileName(peerName, 'txt'), exportTextHead(peerName, msgs.length, new Date().toLocaleString()),
      msgs, (m) => exportTextLine(m, ctx), '', { cancelled },
    );
    // ponytail: the no-Sharing fallback (web) shares only a title now that the
    // text is never one string; Sharing is available on Android and iOS.
    await shareExportFile(uri, 'text/plain', 'crazzychat export');
  });

  const exportAsHTML = () => guard(async (msgs, myId) => {
    const ctx = lineCtx(myId);
    const uri = await writeExportFile(
      fileName(peerName, 'html'), exportHtmlHead(peerName, msgs.length, new Date().toLocaleString(), BRAND_ACCENT),
      msgs, (m) => exportHtmlLine(m, ctx), EXPORT_HTML_TAIL, { cancelled },
    );
    await shareExportFile(uri, 'text/html', 'crazzychat export');
  });

  return (
    <View style={s.container}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={s.backBtn} hitSlop={10}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle} accessibilityRole="header">Export Chat</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={s.body}>
        <View style={s.infoCard}>
          <Ionicons name="share-outline" size={26} color={colors.primary} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={s.infoTitle}>Export {peerName}</Text>
            <Text style={s.infoDesc}>Save your conversation as a file you can share or keep as backup.</Text>
          </View>
        </View>

        <TouchableOpacity style={s.exportBtn} onPress={exportAsText} disabled={exporting} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Export as text" accessibilityState={{ disabled: exporting }}>
          <View style={s.exportIcon}><Ionicons name="document-text-outline" size={22} color={colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.exportTitle}>Export as Text</Text>
            <Text style={s.exportDesc}>Plain text file (.txt) — lightweight, universal</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={s.exportBtn} onPress={exportAsHTML} disabled={exporting} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Export as HTML" accessibilityState={{ disabled: exporting }}>
          <View style={s.exportIcon}><Ionicons name="globe-outline" size={22} color={colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.exportTitle}>Export as HTML</Text>
            <Text style={s.exportDesc}>Styled web page (.html) — looks like a real chat</Text>
          </View>
        </TouchableOpacity>

        {exporting && (
          <View style={s.progressBox}>
            <ActivityIndicator color={colors.primary} />
            <Text style={s.progressTxt}>{progress}</Text>
            {msgCount > 0 && <Text style={s.progressCount}>{msgCount} messages</Text>}
            <TouchableOpacity style={s.cancelBtn} onPress={() => { cancelRef.current = true; setProgress('Cancelling…'); }} accessibilityRole="button" accessibilityLabel="Cancel export">
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.noteBox}>
          <Text style={s.noteTitle}>Privacy Note</Text>
          <Text style={s.noteDesc}>Exported files are NOT encrypted. Only export chats you&apos;re comfortable saving in plain text. The export happens entirely on your device. A locked chat asks for its lock first.</Text>
        </View>
      </View>

      {/* Chat-lock PIN — same PIN the chat itself requires. */}
      <Modal visible={!!pinPrompt} transparent animationType="fade" onRequestClose={() => closePin(false)}>
        <KeyboardSafe keyboardOnly>
        <View style={s.pinOverlay}>
          <View style={s.pinPanel}>
            <Text style={s.pinTitle} accessibilityRole="header">Chat locked</Text>
            <Text style={s.pinDesc}>Enter this chat&apos;s PIN to export it.</Text>
            <TextInput
              style={[s.pinInput, !!pinErr && { borderColor: colors.danger }]}
              value={pin}
              onChangeText={(t) => { setPin(t.replace(/\D/g, '').slice(0, 8)); setPinErr(null); }}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              autoFocus
              accessibilityLabel="Chat lock PIN"
              onSubmitEditing={submitPin}
            />
            {!!pinErr && <Text style={{ color: colors.danger, fontSize: 11, marginBottom: 8 }} accessibilityRole="alert" accessibilityLiveRegion="polite">{pinErr}</Text>}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={s.pinCancel} onPress={() => closePin(false)} accessibilityRole="button">
                <Text style={{ color: colors.textDim, fontWeight: '700' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.pinOk, pin.length < 4 && { opacity: 0.5 }]}
                onPress={submitPin}
                disabled={pin.length < 4}
                accessibilityRole="button"
                accessibilityState={{ disabled: pin.length < 4 }}
              >
                <Text style={{ color: colors.onPrimary, fontWeight: '700' }}>Unlock</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardSafe>
      </Modal>
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: HEADER_TOP, paddingHorizontal: 16, paddingBottom: 8 },
  backBtn: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center' },
  headerTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  body: { flex: 1, padding: 16 },
  infoCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: c.glassStroke },
  infoTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  infoDesc: { color: c.textDim, fontSize: 12, marginTop: 2, lineHeight: 18 },
  exportBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.glassSoft, borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: c.glassStroke },
  exportIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: c.glassSoft, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  exportTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  exportDesc: { color: c.textDim, fontSize: 12, marginTop: 2 },
  progressBox: { alignItems: 'center', padding: 20, marginTop: 10 },
  progressTxt: { color: c.textDim, fontSize: 13, marginTop: 8 },
  progressCount: { color: c.textFaint, fontSize: 11, marginTop: 4 },
  cancelBtn: { minHeight: 44, minWidth: 120, marginTop: 8, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: c.glassStroke },
  cancelTxt: { color: c.text, fontWeight: '700' },
  noteBox: { marginTop: 24, backgroundColor: c.glassSoft, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: c.glassStroke },
  noteTitle: { color: c.danger, fontSize: 12, fontWeight: '800', marginBottom: 4 },
  noteDesc: { color: c.textDim, fontSize: 11, lineHeight: 18 },
  // Fixed scrim: dims whatever is behind the dialog the same way in both themes.
  pinOverlay: { flex: 1, backgroundColor: c.scrim, justifyContent: 'center', padding: 28 },
  pinPanel: { backgroundColor: c.surfaceSolid, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: c.glassStroke },
  pinTitle: { color: c.text, fontSize: 16, fontWeight: '800' },
  pinDesc: { color: c.textDim, fontSize: 12, marginTop: 4, marginBottom: 14 },
  pinInput: { backgroundColor: c.glassSoft, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke, color: c.text, fontSize: 20, letterSpacing: 6, textAlign: 'center', paddingVertical: 10, marginBottom: 10 },
  pinCancel: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: c.glassStroke },
  pinOk: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary },
});
