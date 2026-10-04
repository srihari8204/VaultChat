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
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { Buffer } from 'buffer';

import { SPACING } from '../constants/theme';
import { IMPORT_SOURCES, IMPORT_SOURCE, type ImportOrigin } from '../constants/importSources';
import { useTheme } from '../lib/theme';
import { Header, Card, Button, AuroraBackground } from '../components/ui';
import {
  readExport, extractEntries, withDedupeKeys, parsedFail,
  type ArchiveSource, type WaFailure,
} from '../lib/waImport';
import { importMessages, getMeta, setMeta, type ImportRow } from '../lib/localDb';
import { getChat, listChats, normalizePhoneForHash, type ChatDetail, type ChatSummary } from '../lib/chatService';
import { getCachedContacts, findContactByVaultId } from '../lib/contactSync';
import { APP_DOCS, ensureDir, toUri } from '../lib/storageRoots';
import { getCurrentUserAsync } from './(constants)/authService';
import {
  Done, PickChat, Preview, PrivacyNote, Step, makeImportStyles,
  type MatchLevel, type Outcome, type Parsed,
} from '../components/chattools/importChatsParts';

// The source list and its icons/tints come from constants/importSources, so the
// picker and the mark drawn on every imported message can never disagree about
// what WhatsApp (or Telegram, or Snapchat) looks like.

// ─── Flow ────────────────────────────────────────────────────────────

type Stage =
  | 'pick-chat' | 'pick-source' | 'pick-file'
  | 'reading' | 'matching' | 'preview' | 'importing'
  | 'done' | 'failed';

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
  const s = useMemo(() => makeImportStyles(colors), [colors]);
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
  // listChats failed: shown with a retry, never as "No conversations yet".
  const [chatsErr, setChatsErr] = useState(false);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [match, setMatch] = useState<{ level: MatchLevel; because: string } | null>(null);
  const [ackMismatch, setAckMismatch] = useState(false);
  // Only meaningful when the export is ambiguous: which order the USER says it
  // uses, and whether they have said so yet. Changing it re-reads the archive —
  // the dates have to be re-derived from the raw lines, not patched afterwards.
  const [dateOrder, setDateOrder] = useState<'DMY' | 'MDY'>('DMY');
  const [dateOrderAnswered, setDateOrderAnswered] = useState(true);

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  // The live count for the cancel/error outcome. Reading `progress.done` from
  // a useCallback closure reported the value from when the callback was made.
  const doneRef = useRef(0);
  // Bumped to abandon an in-flight parse (Cancel while reading/matching).
  const parseGen = useRef(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resumable, setResumable] = useState<{ total: number } | null>(null);

  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const fileRef = useRef<{ uri: string; name: string; size: number } | null>(null);

  useEffect(() => () => { cancelRef.current.cancelled = true; }, []);

  // ── target chat ──
  // Returns whether it loaded, so the Import button can say why it cannot run
  // instead of silently doing nothing.
  const loadChat = useCallback(async (): Promise<boolean> => {
    if (!chatId) return false;
    try {
      const c = await getChat(chatId);
      setChat(c);
      const me = await getCurrentUserAsync();
      const peer = c.members.find(m => m.userId !== me?.id && !m.leftAt);
      setPeerName(peer?.name || peer?.email || c.name || 'this contact');
      const raw = await getMeta(SESSION_KEY(chatId));
      if (raw) { try { const j = JSON.parse(raw); if (j?.state === 'running') setResumable({ total: j.total ?? 0 }); } catch {} }
      return true;
    } catch { return false; }
  }, [chatId]);
  useEffect(() => { loadChat(); }, [loadChat]);

  // ── the contact picker: single selection, by construction ──
  useEffect(() => {
    if (stage !== 'pick-chat' || directChats || chatsErr) return;
    listChats()
      .then(all => setDirectChats(all.filter(c => c.type === 'direct')))
      .catch(() => setChatsErr(true));
  }, [stage, directChats, chatsErr]);

  // ── reading the export ────────────────────────────────────────────
  const runParse = useCallback(async (path: string, size: number, forceOrder?: 'DMY' | 'MDY') => {
    const gen = ++parseGen.current;
    const stale = () => gen !== parseGen.current;
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

    // Everything below can throw (a file that vanished, a parser fault). A
    // throw from a parse the user already cancelled is ignored; any other
    // becomes the 'failed' stage rather than an unhandled rejection that
    // strands the spinner (the date-order re-read has no other catch).
    try {
      const r = await readExport(src, forceOrder ? { forceOrder } : undefined);
      if (stale()) return;
      if (parsedFail(r)) { setFailure({ reason: r.reason, detail: r.detail }); setStage('failed'); return; }

      setStage('matching');
      setBusyNote('Matching contact…');

      const me = await getCurrentUserAsync();
      if (stale()) return;
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
      const verdict = await verifyContact(chatId, peerName, counterpart);
      if (stale()) return;
      setMatch(verdict);
      setAckMismatch(false);
      setStage('preview');
    } catch (e: any) {
      if (stale()) return;
      setFailure({ reason: 'not-an-archive', detail: String(e?.message ?? e) });
      setStage('failed');
    }
  }, [chatId, peerName]);

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
  }, [runParse]);

  // Reading has no abort hook in the parser, so Cancel abandons the result:
  // the in-flight parse sees a newer generation and drops what it read.
  const cancelParse = useCallback(() => {
    parseGen.current++;
    setStage('pick-file');
  }, []);

  // ── writing ───────────────────────────────────────────────────────
  const finishCancelled = useCallback(async () => {
    await setMeta(SESSION_KEY(chatId), JSON.stringify({
      state: 'partial', source, at: new Date().toISOString(),
    })).catch(() => {});
    setOutcome({ imported: doneRef.current, duplicates: 0, unsupported: 0,
                 mediaCopied: 0, mediaSkipped: 0, partial: true });
    setStage('done');
  }, [chatId, source]);

  const runImport = useCallback(async () => {
    if (!parsed) return;
    if (!chat) {
      Alert.alert('Chat not loaded', 'This chat could not be loaded, so nothing can be imported into it yet.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: async () => {
            if (!(await loadChat())) Alert.alert('Still unavailable', 'Check your connection and try again.');
          } },
      ]);
      return;
    }
    const file = fileRef.current;
    cancelRef.current = { cancelled: false };
    setStage('importing');
    setProgress({ done: 0, total: parsed.messages.length });
    doneRef.current = 0;

    let mediaCopied = 0, mediaSkipped = 0;
    const localByName = new Map<string, string>();

    // Inside the try, so a throw here lands in the catch below instead of
    // leaving the screen on 'importing' forever.
    try {
      const me = await getCurrentUserAsync();
      const myId = String(me?.id ?? '');
      const peerId = chat.members.find(m => m.userId !== myId && !m.leftAt)?.userId ?? '';
      const sessionId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
      const conv = parsed.counterpart || peerName;

      await setMeta(SESSION_KEY(chatId), JSON.stringify({
        state: 'running', source, total: parsed.messages.length, sessionId, at: new Date().toISOString(),
      })).catch(() => {});

      // 1. Media first, so a message row never points at a file that is not there
      //    yet. Only what the transcript actually references.
      const referenced = new Set<string>();
      for (const m of parsed.messages) {
        if (m.media?.filename && parsed.mediaNames.has(m.media.filename)) referenced.add(m.media.filename);
      }
      if (referenced.size && file) {
        setBusyNote(`Copying ${referenced.size} media file${referenced.size === 1 ? '' : 's'}…`);
        // ponytail: imported media is written unencrypted to private app storage,
        // the same at-rest treatment as received chat media (MEDIA_ROOT): the OS
        // sandbox protects it and uninstall deletes it. Seal it when chat media
        // at rest is sealed (lib/cacheCrypto, VAULT_CACHE_ENCRYPTED), not before.
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
        onProgress: (done, total) => { doneRef.current = done; setProgress({ done, total }); },
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
      setOutcome({ imported: doneRef.current, duplicates: 0, unsupported: parsed.unsupported,
                   mediaCopied, mediaSkipped, partial: true });
      setStage('done');
    }
  }, [parsed, chat, chatId, peerName, source, loadChat, finishCancelled]);


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
            error={chatsErr} onRetry={() => { setChatsErr(false); setDirectChats(null); }}
            onPick={(c, name) => { setChatId(c); setPeerName(name); setStage('pick-source'); }}
          />
        )}

        {stage === 'pick-source' && (
          <>
            <Text style={s.h1}>Import one conversation at a time</Text>
            <Text style={s.sub}>
              Bringing <Text style={s.strong} numberOfLines={1}>{peerName}</Text>’s history into crazzychat.
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
                accessibilityRole="button"
                accessibilityLabel={src.ready ? src.label : `${src.label}, coming next`}
                accessibilityState={{ disabled: !src.ready }}
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
            <Button title="Cancel" variant="ghost" style={s.gap} onPress={cancelParse} />
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
              if (f) void runParse(f.uri, f.size, o);   // failures land in its own catch
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
                <View
                  style={s.bar}
                  accessible
                  accessibilityRole="progressbar"
                  accessibilityLabel="Import progress"
                  accessibilityValue={{ min: 0, max: progress.total, now: progress.done }}
                >
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
/** Case-, accent- and whitespace-insensitive comparison for human names. */
function fold(s: string): string {
  return (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
