// components/chattools/useImportFlow.ts — the Exit Kit's flow: the target
// chat, reading and matching the export, and writing it into the local store.
// Moved out of app/import-chats.tsx unchanged (the screen keeps the render).
//
// Nothing here touches the network either: the parser is pure, and this file
// imports neither lib/api nor a socket. lib/waImport.selftest.ts scans the
// screen and its parts for a way off the device (see the handoff in R5C2.md to
// add this file to that list).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { Buffer } from 'buffer';

import { IMPORT_SOURCE, type ImportOrigin } from '../../constants/importSources';
import {
  readExport, extractEntries, withDedupeKeys, parsedFail,
  type ArchiveSource, type WaFailure,
} from '../../lib/waImport';
import { importMessages, getMeta, setMeta, type ImportRow } from '../../lib/localDb';
import { getChat, listChats, normalizePhoneForHash, type ChatDetail, type ChatSummary } from '../../lib/chatService';
import { getCachedContacts, findContactByVaultId } from '../../lib/contactSync';
import { APP_DOCS, ensureDir, toUri } from '../../lib/storageRoots';
import { getCurrentUserAsync } from '../../app/(constants)/authService';
import { type MatchLevel, type Outcome, type Parsed } from './importChatsParts';

export type ImportStage =
  | 'pick-chat' | 'pick-source' | 'pick-file'
  | 'reading' | 'matching' | 'preview' | 'importing'
  | 'done' | 'failed';
type Stage = ImportStage;

const SESSION_KEY = (chatId: string) => `vc_import_session_${chatId}`;

export function useImportFlow(initial: { chatId: string; peerName: string }) {
  // ONE target, always. Held in state only so the picker can fill it in when the
  // screen was opened without one (from Settings or onboarding) — never a list.
  const [chatId, setChatId] = useState<string>(initial.chatId);
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [peerName, setPeerName] = useState<string>(initial.peerName);

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

  return {
    chatId, setChatId, peerName, setPeerName, stage, setStage, source, setSource,
    busyNote, failure, directChats, setDirectChats, chatsErr, setChatsErr,
    parsed, match, ackMismatch, setAckMismatch,
    dateOrder, setDateOrder, dateOrderAnswered, setDateOrderAnswered,
    progress, outcome, resumable, fileRef,
    runParse, pickFile, cancelParse, runImport, cancel,
  };
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
