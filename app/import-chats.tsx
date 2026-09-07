// app/import-chats.tsx — Exit Kit. Bring ONE conversation across, on this device.
//
// Design: openspec/changes/whatsapp-exit-kit.
//
// The product rule is the architecture here, not a label on it: this screen is
// built around a single target chatId and there is no code path that iterates
// conversations. That is deliberate. A bulk importer has to guess which export
// belongs to which contact, and a wrong guess writes one person's private history
// into another person's chat — silently, and irreversibly as far as the user is
// concerned. One conversation, one export, one confirmation, every time.
//
// Nothing here touches the network. The parser is pure and unreachable from the
// API layer, this file imports neither, and lib/waImport.selftest.ts fails the
// build's check if either ever gains a way off the device.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { Buffer } from 'buffer';

import { type Palette, SPACING, RADIUS, brandAlpha } from '../constants/theme';
import { IMPORT_SOURCES, IMPORT_SOURCE, type ImportOrigin } from '../constants/importSources';
import { useTheme } from '../lib/theme';
import { Header, Card, Button, AuroraBackground } from '../components/ui';
import {
  readExport, extractEntries, withDedupeKeys, parsedFail,
  type ArchiveSource, type WaMessage, type WaFormat, type WaFailure,
} from '../lib/waImport';
import { importMessages, getMeta, setMeta, type ImportRow } from '../lib/localDb';
import { getChat, listChats, normalizePhoneForHash, type ChatDetail, type ChatSummary } from '../lib/chatService';
import { getCachedContacts, findContactByVaultId } from '../lib/contactSync';
import { APP_DOCS, ensureDir, toUri } from '../lib/storageRoots';
import { getCurrentUserAsync } from './(constants)/authService';

// The source list and its icons/tints come from constants/importSources, so the
// picker and the mark drawn on every imported message can never disagree about
// what WhatsApp (or Telegram, or Snapchat) looks like.

// ─── Flow ────────────────────────────────────────────────────────────

type Stage =
  | 'pick-chat' | 'pick-source' | 'pick-file'
  | 'reading' | 'matching' | 'preview' | 'importing'
  | 'done' | 'failed';

/** How confident we are that this export belongs to the selected contact. */
type MatchLevel = 'phone' | 'name' | 'unverified';

interface Parsed {
  messages: WaMessage[];
  participants: string[];
  format: WaFormat;
  unsupported: number;
  missingMedia: number;
  mediaNames: Set<string>;
  /** The export's counterpart — the person who is NOT the user. */
  counterpart: string;
  /** Sender label the user sends under, so alignment is right. */
  selfLabel: string;
}

interface Outcome {
  imported: number; duplicates: number; unsupported: number;
  mediaCopied: number; mediaSkipped: number; partial: boolean;
}

const FAIL_COPY: Record<WaFailure, { title: string; body: string }> = {
  'not-an-archive':     { title: 'That file could not be read',
                          body: 'It does not look like a WhatsApp export. Pick the .zip WhatsApp produced, not a screenshot or a renamed file.' },
  'no-transcript':      { title: 'No conversation in that file',
                          body: 'The archive opened, but there is no chat transcript inside it.' },
  'unsupported-format': { title: 'Unrecognised export format',
                          body: 'The transcript did not match any WhatsApp format this version knows. Nothing was imported.' },
  'empty':              { title: 'Nothing to import',
                          body: 'That export contains no messages.' },
  'group-export':       { title: 'That is a group export',
                          body: 'It contains messages from more than two people, so it cannot go into a one-to-one chat. Importing it here would put other people’s messages in this conversation.' },
  'too-large':          { title: 'That export is too large',
                          body: 'The transcript exceeds the size this can safely read on a phone.' },
  'suspicious-archive': { title: 'That archive was refused',
                          body: 'It contains entries that are malformed or unsafe to open. Nothing was read from it.' },
};

const SESSION_KEY = (chatId: string) => `vc_import_session_${chatId}`;

// ─── Screen ──────────────────────────────────────────────────────────

export default function ImportChatsScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ chatId?: string; peerName?: string }>();

  // ONE target, always. Held in state only so the picker can fill it in when the
  // screen was opened without one (from Settings or onboarding) — never a list.
  const [chatId, setChatId] = useState<string>(String(params.chatId ?? ''));
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [peerName, setPeerName] = useState<string>(String(params.peerName ?? ''));

  const [stage, setStage] = useState<Stage>(chatId ? 'pick-source' : 'pick-chat');
  const [source, setSource] = useState<ImportOrigin>('wa-import');
  const [busyNote, setBusyNote] = useState('');
  const [failure, setFailure] = useState<{ reason: WaFailure; detail?: string } | null>(null);

  const [directChats, setDirectChats] = useState<ChatSummary[] | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [match, setMatch] = useState<{ level: MatchLevel; because: string } | null>(null);
  const [ackMismatch, setAckMismatch] = useState(false);
  // Only meaningful when the export is ambiguous: which order the USER says it
  // uses, and whether they have said so yet. Changing it re-reads the archive —
  // the dates have to be re-derived from the raw lines, not patched afterwards.
  const [dateOrder, setDateOrder] = useState<'DMY' | 'MDY'>('DMY');
  const [dateOrderAnswered, setDateOrderAnswered] = useState(true);

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resumable, setResumable] = useState<{ total: number } | null>(null);

  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const fileRef = useRef<{ uri: string; name: string; size: number } | null>(null);

  useEffect(() => () => { cancelRef.current.cancelled = true; }, []);

  // ── target chat ──
  useEffect(() => {
    if (!chatId) return;
    getChat(chatId)
      .then(async (c) => {
        setChat(c);
        const me = await getCurrentUserAsync();
        const peer = c.members.find(m => m.userId !== me?.id && !m.leftAt);
        setPeerName(peer?.name || peer?.email || c.name || 'this contact');
        const raw = await getMeta(SESSION_KEY(chatId));
        if (raw) { try { const j = JSON.parse(raw); if (j?.state === 'running') setResumable({ total: j.total ?? 0 }); } catch {} }
      })
      .catch(() => {});
  }, [chatId]);

  // ── the contact picker: single selection, by construction ──
  useEffect(() => {
    if (stage !== 'pick-chat' || directChats) return;
    listChats()
      .then(all => setDirectChats(all.filter(c => c.type === 'direct')))
      .catch(() => setDirectChats([]));
  }, [stage, directChats]);

  // ── reading the export ────────────────────────────────────────────
  const pickFile = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        // copyToCacheDirectory:false — a WhatsApp export can be gigabytes, and
        // copying one to make a second copy we then stream is exactly the waste
        // this whole file is shaped to avoid.
        type: ['application/zip', 'application/octet-stream', '*/*'],
        multiple: false, copyToCacheDirectory: false,
      });
      if (res.canceled || !res.assets?.length) return;
      const a = res.assets[0];
      const path = decodeURI(String(a.uri).replace(/^file:\/\//, ''));
      const st = await RNFS.stat(path).catch(() => null);
      const size = Number(a.size ?? st?.size ?? 0);
      if (!size) { setFailure({ reason: 'not-an-archive', detail: 'empty file' }); setStage('failed'); return; }
      fileRef.current = { uri: path, name: a.name ?? 'export.zip', size };
      await runParse(path, size);
    } catch (e: any) {
      setFailure({ reason: 'not-an-archive', detail: String(e?.message ?? e) });
      setStage('failed');
    }
  }, [chatId, peerName]);

  const runParse = useCallback(async (path: string, size: number, forceOrder?: 'DMY' | 'MDY') => {
    setStage('reading');
    setBusyNote(forceOrder ? 'Re-reading dates…' : 'Finding conversation…');
    setFailure(null);

    // The one place the device's filesystem meets the pure parser: positional
    // reads, so the archive is never resident. base64 is the only lossless
    // encoding RNFS.read offers; the 4/3 cost per 512 KiB chunk is nothing next
    // to holding gigabytes.
    const src: ArchiveSource = {
      size,
      read: async (offset, length) =>
        new Uint8Array(Buffer.from(await RNFS.read(path, length, offset, 'base64'), 'base64')),
    };

    const r = await readExport(src, forceOrder ? { forceOrder } : undefined);
    if (parsedFail(r)) { setFailure({ reason: r.reason, detail: r.detail }); setStage('failed'); return; }

    setStage('matching');
    setBusyNote('Matching contact…');

    const me = await getCurrentUserAsync();
    const myName = String(me?.displayName ?? me?.name ?? '').trim();

    // Which participant is the user? Prefer their own display name; otherwise the
    // one that does NOT look like the peer. With two participants this is always
    // decidable; with one (a monologue export) both sides collapse and we treat
    // the single label as the counterpart.
    const ppl = r.participants;
    const selfLabel =
      ppl.find(p => myName && fold(p) === fold(myName))
      ?? ppl.find(p => fold(p) !== fold(peerName))
      ?? (ppl.length > 1 ? ppl[1] : '');
    const counterpart = ppl.find(p => p !== selfLabel) ?? ppl[0] ?? '';

    setParsed({
      messages: r.messages, participants: ppl, format: r.format,
      unsupported: r.unsupported, missingMedia: r.missingMedia,
      mediaNames: new Set(r.media.map(m => m.name.slice(m.name.lastIndexOf('/') + 1))),
      counterpart, selfLabel,
    });
    setDateOrder(r.format.order === 'MDY' ? 'MDY' : 'DMY');
    setDateOrderAnswered(!r.format.ambiguous);
    setMatch(await verifyContact(chatId, peerName, counterpart));
    setAckMismatch(false);
    setStage('preview');
  }, [chatId, peerName]);

  // ── writing ───────────────────────────────────────────────────────
  const runImport = useCallback(async () => {
    if (!parsed || !chat) return;
    const file = fileRef.current;
    cancelRef.current = { cancelled: false };
    setStage('importing');
    setProgress({ done: 0, total: parsed.messages.length });

    const me = await getCurrentUserAsync();
    const myId = String(me?.id ?? '');
    const peerId = chat.members.find(m => m.userId !== myId && !m.leftAt)?.userId ?? '';
    const sessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const conv = parsed.counterpart || peerName;

    await setMeta(SESSION_KEY(chatId), JSON.stringify({
      state: 'running', source, total: parsed.messages.length, sessionId, at: new Date().toISOString(),
    })).catch(() => {});

    let mediaCopied = 0, mediaSkipped = 0;
    const localByName = new Map<string, string>();

    try {
      // 1. Media first, so a message row never points at a file that is not there
      //    yet. Only what the transcript actually references.
      const referenced = new Set<string>();
      for (const m of parsed.messages) {
        if (m.media?.filename && parsed.mediaNames.has(m.media.filename)) referenced.add(m.media.filename);
      }
      if (referenced.size && file) {
        setBusyNote(`Copying ${referenced.size} media file${referenced.size === 1 ? '' : 's'}…`);
        const dir = `${APP_DOCS}/VaultChat/Imported/${sessionId}`;
        await ensureDir(dir);
        const src: ArchiveSource = {
          size: file.size,
          read: async (offset, length) =>
            new Uint8Array(Buffer.from(await RNFS.read(file.uri, length, offset, 'base64'), 'base64')),
        };
        const res = await extractEntries(src, referenced, async (name, bytes) => {
          const dest = `${dir}/${name}`;
          await RNFS.writeFile(dest, Buffer.from(bytes).toString('base64'), 'base64');
          localByName.set(name, toUri(dest));
        }, { signal: cancelRef.current });
        mediaCopied = res.written;
        mediaSkipped = res.skipped;
      }

      if (cancelRef.current.cancelled) { await finishCancelled(); return; }

      // 2. Messages.
      setBusyNote(`Importing ${parsed.messages.length.toLocaleString()} messages…`);
      const keyed = withDedupeKeys(parsed.messages, { source, chatId, conv });
      const rows: ImportRow[] = keyed.map(m => {
        const mine = !m.system && !!m.sender && fold(m.sender) === fold(parsed.selfLabel);
        const localUri = m.media?.filename ? localByName.get(m.media.filename) : undefined;
        return {
          importKey: m.importKey,
          senderId: m.system ? null : (mine ? myId : peerId),
          type: m.system ? 'system' : (m.media ? m.media.kind : 'text'),
          // The body, exactly as exported. Provenance lives in meta — writing it
          // into the text would corrupt search, change the dedupe key's meaning,
          // and make the transformation irreversible.
          content: m.body,
          meta: {
            origin: source,
            importId: sessionId,
            importedAt: new Date().toISOString(),
            source: { app: IMPORT_SOURCE[source]?.label ?? source, contact: conv, conv },
            orig: { sender: m.sender, ts: new Date(m.tsMs).toISOString(), raw: m.tsRaw },
            ...(m.media ? { media: { filename: m.media.filename, kind: m.media.kind,
                                     present: !!localUri } } : {}),
            ...(localUri ? { localUri } : {}),
          },
          tsMs: m.tsMs,
          createdAt: new Date(m.tsMs).toISOString(),
        };
      });

      const { inserted, skipped } = await importMessages(chatId, rows, {
        onProgress: (done, total) => setProgress({ done, total }),
        signal: cancelRef.current,
      });

      const partial = cancelRef.current.cancelled || inserted + skipped < rows.length;
      await setMeta(SESSION_KEY(chatId), JSON.stringify({
        state: partial ? 'partial' : 'done', source, total: rows.length,
        sessionId, at: new Date().toISOString(),
      })).catch(() => {});

      setOutcome({
        imported: inserted, duplicates: skipped, unsupported: parsed.unsupported + parsed.missingMedia,
        mediaCopied, mediaSkipped, partial,
      });
      setStage('done');
    } catch (e: any) {
      // Batches already committed are intact and consistent — that is what the
      // batching is for. The session row keeps this identifiable, and the unique
      // index makes the retry land only what is missing.
      await setMeta(SESSION_KEY(chatId), JSON.stringify({
        state: 'partial', source, total: parsed.messages.length, at: new Date().toISOString(),
      })).catch(() => {});
      const low = /no space|ENOSPC|disk|storage/i.test(String(e?.message ?? e));
      Alert.alert(
        low ? 'Not enough space' : 'Import interrupted',
        low ? 'Free some space and try again. Messages already imported are safe, and retrying will not duplicate them.'
            : 'Messages already imported are safe. Retrying will not duplicate them.',
      );
      setOutcome({ imported: progress.done, duplicates: 0, unsupported: parsed.unsupported,
                   mediaCopied, mediaSkipped, partial: true });
      setStage('done');
    }
  }, [parsed, chat, chatId, peerName, source, progress.done]);

  const finishCancelled = useCallback(async () => {
    await setMeta(SESSION_KEY(chatId), JSON.stringify({
      state: 'partial', source, at: new Date().toISOString(),
    })).catch(() => {});
    setOutcome({ imported: progress.done, duplicates: 0, unsupported: 0,
                 mediaCopied: 0, mediaSkipped: 0, partial: true });
    setStage('done');
  }, [chatId, source, progress.done]);

  const cancel = useCallback(() => {
    cancelRef.current.cancelled = true;
    setBusyNote('Stopping…');
  }, []);

  // ── render ────────────────────────────────────────────────────────

  const title = stage === 'pick-chat' ? 'Import a conversation' : 'Exit Kit';

  return (
    <View style={s.screen}>
      <AuroraBackground />
      <Stack.Screen options={{ headerShown: false }} />
      <Header title={title} border />
      <ScrollView
        style={s.flex}
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + SPACING.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {stage === 'pick-chat' && (
          <PickChat
            s={s} colors={colors} chats={directChats}
            onPick={(c, name) => { setChatId(c); setPeerName(name); setStage('pick-source'); }}
          />
        )}

        {stage === 'pick-source' && (
          <>
            <Text style={s.h1}>Import one conversation at a time</Text>
            <Text style={s.sub}>
              Bringing <Text style={s.strong} numberOfLines={1}>{peerName}</Text>’s history into VaultChat.
              To import someone else, come back and do it separately.
            </Text>
            <PrivacyNote s={s} colors={colors} />

            {resumable && (
              <Card style={s.warnCard}>
                <Text style={s.warnTitle}>Import incomplete</Text>
                <Text style={s.warnBody}>
                  A previous import of this conversation did not finish. Running it again is safe —
                  messages already imported will not be duplicated.
                </Text>
              </Card>
            )}

            <Text style={s.label}>WHERE ARE THE MESSAGES NOW?</Text>
            {IMPORT_SOURCES.map(src => (
              <TouchableOpacity
                key={src.origin}
                activeOpacity={src.ready ? 0.7 : 1}
                disabled={!src.ready}
                onPress={() => { setSource(src.origin); setStage('pick-file'); }}
                style={[s.srcRow, !src.ready && s.srcRowOff]}
              >
                <View style={[s.srcIcon, { backgroundColor: src.tint + '22' }]}>
                  <Ionicons name={src.icon} size={22} color={src.ready ? src.tint : colors.textFaint} />
                </View>
                <View style={s.flex}>
                  <Text style={[s.srcLabel, !src.ready && { color: colors.textDim }]} numberOfLines={1}>
                    {src.label}
                  </Text>
                  <Text style={s.srcHint} numberOfLines={2}>{src.hint}</Text>
                </View>
                {src.ready
                  ? <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                  : <View style={s.soon}><Text style={s.soonTxt}>Coming next</Text></View>}
              </TouchableOpacity>
            ))}
          </>
        )}

        {stage === 'pick-file' && (
          <>
            <Text style={s.h1}>Select your WhatsApp export</Text>
            <Card style={s.stepCard}>
              <Step s={s} n={1} text="In WhatsApp, open your chat with this contact." />
              <Step s={s} n={2} text="Tap ⋮ → More → Export chat." />
              <Step s={s} n={3} text="Choose “With media” or “Without media”, then save the .zip." />
              <Step s={s} n={4} text="Come back here and pick that file." last />
            </Card>
            <PrivacyNote s={s} colors={colors} />
            <Button title="Choose export file" icon="document-attach-outline" fullWidth onPress={pickFile} />
            <Button title="Back" variant="ghost" fullWidth style={s.gap} onPress={() => setStage('pick-source')} />
          </>
        )}

        {(stage === 'reading' || stage === 'matching') && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={s.busySrc}>WhatsApp export</Text>
            <Text style={s.busyNote}>{busyNote}</Text>
          </View>
        )}

        {stage === 'preview' && parsed && (
          <Preview
            s={s} colors={colors} parsed={parsed} peerName={peerName} match={match}
            ack={ackMismatch} setAck={setAckMismatch}
            dateOrder={dateOrder} answered={dateOrderAnswered}
            onPickOrder={(o) => {
              setDateOrder(o); setDateOrderAnswered(true);
              const f = fileRef.current;
              if (f) runParse(f.uri, f.size, o);
            }}
            onConfirm={runImport} onCancel={() => setStage('pick-source')}
          />
        )}

        {stage === 'importing' && (
          <View style={s.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={s.busySrc} numberOfLines={1}>{peerName}</Text>
            <Text style={s.busyNote}>{busyNote}</Text>
            {progress.total > 0 && (
              <>
                <View style={s.bar}>
                  <View style={[s.barFill, { width: `${Math.round((progress.done / progress.total) * 100)}%` }]} />
                </View>
                <Text style={s.busyCount}>
                  {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
                </Text>
              </>
            )}
            <Button title="Cancel" variant="ghost" style={s.gap} onPress={cancel} />
          </View>
        )}

        {stage === 'done' && outcome && (
          <Done
            s={s} colors={colors} outcome={outcome} peerName={peerName}
            onOpen={() => router.replace({ pathname: '/chat' as any, params: { chatId } })}
            onRetry={() => setStage('pick-file')}
          />
        )}

        {stage === 'failed' && failure && (
          <View style={s.center}>
            <View style={s.failIcon}><Ionicons name="alert-circle-outline" size={34} color={colors.danger} /></View>
            <Text numberOfLines={1} style={s.h1}>{FAIL_COPY[failure.reason].title}</Text>
            <Text style={s.sub}>{FAIL_COPY[failure.reason].body}</Text>
            {!!failure.detail && <Text style={s.detail} numberOfLines={3}>{failure.detail}</Text>}
            <Text style={s.reassure}>Nothing was imported and nothing was uploaded.</Text>
            <Button title="Choose a different file" fullWidth style={s.gap} onPress={() => setStage('pick-file')} />
            <Button title="Back" variant="ghost" fullWidth onPress={() => setStage('pick-source')} />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Contact verification ────────────────────────────────────────────
//
// This is a VERIFICATION, not a search: the user already chose the conversation.
// The job is to catch the case where the export is somebody else's.
//
// Tier 1 is the peer's phone number — which is NOT in ChatMember. The server
// stores numbers only as hashes and never returns them, so the only local source
// is the device's synced contacts. That is a correctness boundary, not an
// oversight: asking the server for it would be both a new endpoint and a privacy
// regression, to win a check the local cache usually answers anyway.

async function verifyContact(
  chatId: string, peerName: string, counterpart: string,
): Promise<{ level: MatchLevel; because: string }> {
  try {
    const chat = await getChat(chatId);
    const me = await getCurrentUserAsync();
    const peer = chat.members.find(m => m.userId !== me?.id && !m.leftAt);
    if (peer) {
      const contact = await findContactByVaultId(peer.userId, await getCachedContacts());
      if (contact?.phone) {
        const mine = normalizePhoneForHash(contact.phone);
        const theirs = normalizePhoneForHash(counterpart);
        if (mine && theirs && mine === theirs) {
          return { level: 'phone', because: `Phone number matches ${contact.phone}` };
        }
      }
      const names = [peer.name, peer.email, chat.name].filter(Boolean) as string[];
      if (counterpart && names.some(n => fold(n) === fold(counterpart))) {
        return { level: 'name', because: 'Matched on name only — no phone number for this contact on this device' };
      }
    }
  } catch { /* fall through to unverified — never guess */ }
  return { level: 'unverified', because: 'Could not confirm this export belongs to this contact' };
}

/** The person on the other side of a direct chat, however the row spells it. */
function peerLabel(c: ChatSummary): string {
  return (c.peerName?.trim() || c.name?.trim() || 'Unnamed contact');
}

/** Case-, accent- and whitespace-insensitive comparison for human names. */
function fold(s: string): string {
  return (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── Pieces ──────────────────────────────────────────────────────────

function PrivacyNote({ s, colors }: { s: any; colors: Palette }) {
  return (
    <View style={s.privacy}>
      <Ionicons name="lock-closed" size={14} color={colors.success} />
      <Text style={s.privacyTxt}>Your data stays on this device. Nothing is uploaded.</Text>
    </View>
  );
}

function Step({ s, n, text, last }: { s: any; n: number; text: string; last?: boolean }) {
  return (
    <View style={[s.step, last && { borderBottomWidth: 0 }]}>
      <View style={s.stepNum}><Text style={s.stepNumTxt}>{n}</Text></View>
      <Text style={s.stepTxt}>{text}</Text>
    </View>
  );
}

function Row({ s, k, v }: { s: any; k: string; v: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      <Text style={s.kvV} numberOfLines={2}>{v}</Text>
    </View>
  );
}

function PickChat({ s, colors, chats, onPick }: {
  s: any; colors: Palette; chats: ChatSummary[] | null;
  onPick: (chatId: string, name: string) => void;
}) {
  if (!chats) return <View style={s.center}><ActivityIndicator color={colors.primary} /></View>;
  if (!chats.length) {
    return (
      <View style={s.center}>
        <Text style={s.h1}>No conversations yet</Text>
        <Text style={s.sub}>Start a chat with someone first, then import your history with them.</Text>
      </View>
    );
  }
  return (
    <>
      <Text style={s.h1}>Which conversation?</Text>
      <Text style={s.sub}>Pick the contact whose history you want to bring across. One at a time.</Text>
      <PrivacyNote s={s} colors={colors} />
      {chats.map(c => {
        // A DIRECT chat carries the other person in `peerName`; `name` is for
        // groups and is null here. Reading `name` first made every row in this
        // picker read "Unnamed" on a real device — a contact list with no
        // contacts in it. Verified on the Honor before and after.
        const who = peerLabel(c);
        return (
          <TouchableOpacity key={c.id} style={s.srcRow} activeOpacity={0.7}
            onPress={() => onPick(c.id, who)}>
            <View style={[s.srcIcon, { backgroundColor: brandAlpha(0.15) }]}>
              <Ionicons name="person" size={20} color={colors.primary} />
            </View>
            <Text style={[s.srcLabel, s.flex]} numberOfLines={1}>{who}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        );
      })}
    </>
  );
}

function Preview({
  s, colors, parsed, peerName, match, ack, setAck, dateOrder, answered, onPickOrder, onConfirm, onCancel,
}: {
  s: any; colors: Palette; parsed: Parsed; peerName: string;
  match: { level: MatchLevel; because: string } | null;
  ack: boolean; setAck: (v: boolean) => void;
  dateOrder: 'DMY' | 'MDY'; answered: boolean; onPickOrder: (o: 'DMY' | 'MDY') => void;
  onConfirm: () => void; onCancel: () => void;
}) {
  const times = parsed.messages.map(m => m.tsMs);
  const range = times.length
    ? `${fmtMonth(Math.min(...times))} – ${fmtMonth(Math.max(...times))}`
    : '—';

  // Two gates, and neither can be waved through by pressing the primary button:
  // an unverified contact, and a date order the export itself could not settle.
  const needsAck = match?.level === 'unverified';
  const blocked = (needsAck && !ack) || (parsed.format.ambiguous && !answered);

  return (
    <>
      <Text style={s.h1}>Import this conversation?</Text>

      <Card style={s.summary}>
        <Row s={s} k="Source" v="WhatsApp" />
        <Row s={s} k="Contact" v={parsed.counterpart || peerName} />
        <Row s={s} k="Messages" v={parsed.messages.length.toLocaleString()} />
        <Row s={s} k="Time range" v={range} />
        <Row s={s} k="Into" v={peerName} />
      </Card>

      {match && (
        <View style={[s.match, match.level === 'phone' ? s.matchOk
                    : match.level === 'name' ? s.matchMeh : s.matchBad]}>
          <Ionicons
            name={match.level === 'phone' ? 'checkmark-circle'
                : match.level === 'name' ? 'information-circle' : 'alert-circle'}
            size={16}
            color={match.level === 'phone' ? colors.success
                 : match.level === 'name' ? colors.primary : colors.danger}
          />
          <Text style={s.matchTxt}>{match.because}</Text>
        </View>
      )}

      {needsAck && (
        <TouchableOpacity style={s.ackRow} activeOpacity={0.8} onPress={() => setAck(!ack)}>
          <View style={[s.check, ack && s.checkOn]}>
            {ack && <Ionicons name="checkmark" size={14} color="#fff" />}
          </View>
          <Text style={s.ackTxt}>
            Yes — this WhatsApp conversation with{' '}
            <Text style={s.strong}>{parsed.counterpart || 'this person'}</Text> belongs in my
            VaultChat chat with <Text numberOfLines={1} style={s.strong}>{peerName}</Text>.
          </Text>
        </TouchableOpacity>
      )}

      {parsed.format.ambiguous && (
        <Card style={s.warnCard}>
          <Text style={s.warnTitle}>Which date order does this export use?</Text>
          <Text style={s.warnBody}>
            Every date in this export could be read either way (e.g. 03/04 as 3 April or March 4),
            so it cannot be worked out from the file. Choosing wrong shifts every message by months.
          </Text>
          <View style={s.pillRow}>
            {([['DMY', 'Day first (03/04 = 3 Apr)'], ['MDY', 'Month first (03/04 = 4 Mar)']] as const).map(([o, label]) => {
              const on = answered && dateOrder === o;
              return (
                <TouchableOpacity key={o} style={[s.pill, on && s.pillOn]} onPress={() => onPickOrder(o)}>
                  <Text style={[s.pillTxt, on && s.pillTxtOn]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Card>
      )}

      {(parsed.unsupported > 0 || parsed.missingMedia > 0) && (
        <Text style={s.note}>
          {parsed.missingMedia > 0 && `${parsed.missingMedia} media file${parsed.missingMedia === 1 ? '' : 's'} referenced but not in this export`}
          {parsed.missingMedia > 0 && parsed.unsupported > 0 && ' · '}
          {parsed.unsupported > 0 && `${parsed.unsupported} line${parsed.unsupported === 1 ? '' : 's'} could not be read`}
        </Text>
      )}

      <View style={s.privacy}>
        <Ionicons name="lock-closed" size={14} color={colors.success} />
        <Text style={s.privacyTxt}>Nothing will be uploaded. Import happens on this device.</Text>
      </View>

      <Button title="Import conversation" fullWidth disabled={blocked} onPress={onConfirm} />
      <Button title="Cancel" variant="ghost" fullWidth style={s.gap} onPress={onCancel} />
    </>
  );
}

function Done({ s, colors, outcome, peerName, onOpen, onRetry }: {
  s: any; colors: Palette; outcome: Outcome; peerName: string;
  onOpen: () => void; onRetry: () => void;
}) {
  return (
    <View style={s.center}>
      <View style={[s.tick, outcome.partial && { borderColor: colors.primary }]}>
        <Ionicons name={outcome.partial ? 'pause' : 'checkmark'} size={34} color={colors.primary} />
      </View>
      <Text style={s.h1}>{outcome.partial ? 'Import incomplete' : 'Conversation imported'}</Text>
      <Text style={s.sub} numberOfLines={2}>{peerName} · WhatsApp</Text>

      <Card style={s.summary}>
        <Row s={s} k="Messages imported" v={outcome.imported.toLocaleString()} />
        <Row s={s} k="Duplicates skipped" v={outcome.duplicates.toLocaleString()} />
        <Row s={s} k="Unsupported items" v={outcome.unsupported.toLocaleString()} />
        <Row s={s} k="Media copied" v={`${outcome.mediaCopied}${outcome.mediaSkipped ? ` (${outcome.mediaSkipped} too large)` : ''}`} />
        <Row s={s} k="Timestamps" v="Preserved as exported" />
      </Card>

      {outcome.partial && (
        <Text style={s.note}>
          Everything imported so far is safe. Running the import again will only add what is missing.
        </Text>
      )}

      <Button title="Open conversation" fullWidth onPress={onOpen} />
      {outcome.partial && <Button title="Resume import" variant="ghost" fullWidth style={s.gap} onPress={onRetry} />}
    </View>
  );
}

function fmtMonth(ms: number): string {
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// ─── Styles ──────────────────────────────────────────────────────────
//
// No fixed heights on anything that holds text: the whole screen scrolls, rows
// grow with dynamic type, and every name truncates rather than shoving the
// primary action off a small display.

const makeStyles = (c: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: 'transparent' },
  flex:     { flex: 1 },
  body:     { paddingHorizontal: SPACING.lg, paddingTop: SPACING.md },
  center:   { alignItems: 'center', paddingTop: SPACING.xl },

  h1:       { color: c.text, fontSize: 22, fontWeight: '900', textAlign: 'center', marginBottom: SPACING.sm },
  sub:      { color: c.textDim, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: SPACING.md },
  strong:   { color: c.text, fontWeight: '800' },
  label:    { color: c.textFaint, fontSize: 11, fontWeight: '800', letterSpacing: 0.8,
              marginTop: SPACING.lg, marginBottom: SPACING.sm },
  note:     { color: c.textFaint, fontSize: 12, lineHeight: 17, textAlign: 'center', marginBottom: SPACING.md },
  detail:   { color: c.textFaint, fontSize: 11, textAlign: 'center', marginBottom: SPACING.sm },
  reassure: { color: c.success, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: SPACING.md },
  gap:      { marginTop: SPACING.sm },

  privacy:    { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs, alignSelf: 'center',
                backgroundColor: c.glassSoft, borderRadius: RADIUS.pill ?? 999,
                paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs, marginBottom: SPACING.lg },
  privacyTxt: { color: c.textDim, fontSize: 12, flexShrink: 1 },

  srcRow:   { flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
              backgroundColor: c.glassSoft, borderRadius: RADIUS.lg ?? 16, borderWidth: 1, borderColor: c.glassStroke,
              paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, marginBottom: SPACING.sm },
  srcRowOff:{ opacity: 0.55 },
  srcIcon:  { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  srcLabel: { color: c.text, fontSize: 16, fontWeight: '800' },
  srcHint:  { color: c.textFaint, fontSize: 12, marginTop: 2, lineHeight: 16 },
  soon:     { backgroundColor: c.glassSoft, borderRadius: 999, paddingHorizontal: SPACING.sm, paddingVertical: 3 },
  soonTxt:  { color: c.textDim, fontSize: 11, fontWeight: '700' },

  stepCard: { marginBottom: SPACING.lg },
  step:     { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md,
              paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: c.hairline },
  stepNum:  { width: 22, height: 22, borderRadius: 11, backgroundColor: brandAlpha(0.18),
              alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  stepNumTxt:{ color: c.primary, fontSize: 11, fontWeight: '900' },
  stepTxt:  { color: c.text, fontSize: 14, lineHeight: 20, flex: 1 },

  busySrc:  { color: c.text, fontSize: 18, fontWeight: '800', marginTop: SPACING.lg },
  busyNote: { color: c.textDim, fontSize: 14, marginTop: SPACING.xs, textAlign: 'center' },
  busyCount:{ color: c.textFaint, fontSize: 12, marginTop: SPACING.xs },
  bar:      { height: 6, borderRadius: 3, backgroundColor: c.glassSoft, width: '100%',
              marginTop: SPACING.md, overflow: 'hidden' },
  barFill:  { height: 6, borderRadius: 3, backgroundColor: c.primary },

  summary:  { marginBottom: SPACING.md },
  kv:       { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
              gap: SPACING.md, paddingVertical: SPACING.sm },
  kvK:      { color: c.textDim, fontSize: 13, flexShrink: 0 },
  kvV:      { color: c.text, fontSize: 13, fontWeight: '700', flexShrink: 1, textAlign: 'right' },

  match:    { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.xs, borderRadius: RADIUS.md ?? 12,
              padding: SPACING.md, marginBottom: SPACING.md, borderWidth: 1 },
  matchOk:  { backgroundColor: 'rgba(34,197,94,0.10)',  borderColor: 'rgba(34,197,94,0.35)' },
  matchMeh: { backgroundColor: brandAlpha(0.10),        borderColor: brandAlpha(0.35) },
  matchBad: { backgroundColor: 'rgba(239,68,68,0.10)',  borderColor: 'rgba(239,68,68,0.35)' },
  matchTxt: { color: c.text, fontSize: 13, lineHeight: 18, flex: 1 },

  ackRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md, marginBottom: SPACING.md },
  check:    { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: c.glassStroke,
              alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkOn:  { backgroundColor: c.primary, borderColor: c.primary },
  ackTxt:   { color: c.text, fontSize: 13, lineHeight: 19, flex: 1 },

  warnCard: { marginBottom: SPACING.md, borderColor: brandAlpha(0.4) },
  warnTitle:{ color: c.text, fontSize: 14, fontWeight: '800', marginBottom: SPACING.xs },
  warnBody: { color: c.textDim, fontSize: 13, lineHeight: 19 },
  pillRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md },
  pill:     { borderWidth: 1, borderColor: c.glassStroke, borderRadius: 999,
              paddingHorizontal: SPACING.md, paddingVertical: SPACING.xs },
  pillOn:   { borderColor: c.primary, backgroundColor: brandAlpha(0.15) },
  pillTxt:  { color: c.textDim, fontSize: 12, fontWeight: '700' },
  pillTxtOn:{ color: c.text },

  tick:     { width: 76, height: 76, borderRadius: 38, backgroundColor: brandAlpha(0.15),
              borderWidth: 2, borderColor: c.success, alignItems: 'center', justifyContent: 'center',
              marginBottom: SPACING.md },
  failIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(239,68,68,0.12)',
              alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.md },
});
