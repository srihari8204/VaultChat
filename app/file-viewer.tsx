// app/file-viewer.tsx — Universal File Viewer for crazzychat
// View ANY file without leaving the app: images, videos, PDFs, Office docs,
// code/text files, audio — all rendered inline with premium UI.
//
// This file owns LOADING (authenticated download, windowed text reads, the
// two-phase document parse, audio) and the hand-off to other apps. What each
// file type looks like lives in components/fileviewer/Panes.tsx; file-type
// detection in components/fileviewer/fileTypes.ts; palette and styles in
// components/fileviewer/styles.ts.

import { Ionicons } from '@expo/vector-icons';
import { ErrorBoundary } from '../components/ErrorBoundary';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, Easing, InteractionManager, Platform,
  StatusBar, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import * as IntentLauncher from 'expo-intent-launcher';
import { getAccessToken } from '../lib/api';
import { isOwnServerUrl } from '../lib/serverOrigin';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VIEWER_TEMP_PREFIX } from '../lib/mediaCacheGC';
import { Buffer } from 'buffer';
import { docKind, MAX_DOC_BYTES } from '../lib/docText';
import { decodeWindow, WINDOW_BYTES } from '../lib/textWindow';
import type { Block } from '../lib/docBlocks';
import { PdfView } from '../components/PdfView';
import { detectType, formatBytes, formatOf, resolveMime } from '../components/fileviewer/fileTypes';
import { C, CTA_GRADIENT, s } from '../components/fileviewer/styles';
import {
  AudioPane, DocActionBar, DocEmpty, DocReader, DocumentCard, ErrorPane, ImagePane,
  LoadingPane, TextPane, UnknownPane,
} from '../components/fileviewer/Panes';

/**
 * Ceiling for the plain-text viewer — now an ACCUMULATION cap, not a refusal.
 *
 * This used to reject the file outright, because readAsStringAsync materialises
 * the whole thing as one JS string and a multi-hundred-MB .log took the app down
 * with it. The file is now read in WINDOW_BYTES windows (lib/textWindow), so
 * opening a huge log and reading its first screens costs one window — refusing it
 * bought nothing and cost the user the file. What still has to be bounded is the
 * string we have ACCUMULATED, so windowing stops here and the footer says so.
 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Units of a document parsed before the first paint — see readDoc. */
const PREVIEW_UNITS = 3;
/** Word has no pages, so its unit is a block; 3 paragraphs is not a screen. */
const PREVIEW_DOCX_BLOCKS = 60;

// ══════════════════════════════════════════════════════════════════
// ██  MAIN SCREEN
// ══════════════════════════════════════════════════════════════════
function FileViewerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ uri: string; filename: string; mimeType?: string }>();
  const fileUri = (params.uri || '') + '';
  const fileName = (params.filename || 'file') + '';
  const fileType = detectType(fileName, params.mimeType || undefined);
  const fmt = formatOf(fileName, fileType);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [textContent, setTextContent] = useState('');
  // Office-document reading state. Kept separate from `textContent` so a failed
  // extraction can fall back to the hand-off card without blanking a text file.
  const [docText, setDocText] = useState('');
  // The STRUCTURED read (headings, tables, sheets, slides, pages). Kept beside
  // docText rather than replacing it: if the structured pass ever returns
  // nothing useful, the flat text is still a working document view.
  const [docBlocks, setDocBlocks] = useState<Block[] | null>(null);
  const [docEmpty, setDocEmpty] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(true);
  // Where the document actually landed on disk. The PDF page renderer needs the
  // FILE — the extracted text is no use to it.
  const [docLocalUri, setDocLocalUri] = useState<string | null>(null);
  // Set when pdf.js cannot render this file, which drops it back to the text
  // reader rather than leaving a blank grey screen.
  // Windowed plain-text reading. The cursor lives in a ref, not state: it is
  // advanced from inside the read and must not re-render or re-trigger the list.
  // `size` 0 means UNKNOWN, not empty: some content:// providers report no size,
  // and windowing works without one — a short read is end of file either way.
  // `carry` is annotated because Uint8Array is generic in the repo's TS lib and
  // an inferred Uint8Array<ArrayBuffer> will not accept a Uint8Array<ArrayBufferLike>.
  const textWin = useRef<{
    uri: string; size: number; pos: number; carry: Uint8Array; busy: boolean; done: boolean;
  }>({ uri: '', size: 0, pos: 0, carry: new Uint8Array(0), busy: false, done: false });
  /**
   * Which load this is. A BOOLEAN "is this screen dead" cannot express "a newer
   * load started": React runs the previous effect's cleanup and the next effect
   * body back to back in one commit, so a flag set true in cleanup is already
   * false again by the time a deferred callback from the old run fires — and it
   * would then write the PREVIOUS document's blocks over the new one's. A
   * counter can express it: capture it, compare it, bail if it moved.
   */
  const runRef = useRef(0);
  /** More of the file exists and has not been read yet. */
  const [textMore, setTextMore] = useState(false);
  /** Windowing stopped at MAX_TEXT_BYTES rather than at end of file. */
  const [textCapped, setTextCapped] = useState(false);
  /** A window AFTER the first one failed. Not a load failure — see readTextWindow. */
  const [textFailed, setTextFailed] = useState(false);
  /** The rest of the document is still being parsed behind the first page. */
  const [docMore, setDocMore] = useState(false);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [openingExternally, setOpeningExternally] = useState(false);
  // Measured, not assumed: the content starts below the header, whose height
  // follows the font scale (it was assumed to be 64).
  const [headerH, setHeaderH] = useState(0);

  // Audio state
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  // The loader effect below unloads the previous sound on cleanup. It cannot
  // read `sound` for that without listing it as a dependency, and listing it is
  // an infinite loop: the effect CREATES a sound and calls setSound, which
  // changes the dependency, which re-runs the effect, which creates another one.
  // A ref carries the handle to the cleanup without feeding the dependency list.
  const soundRef = useRef<Audio.Sound | null>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioPosition, setAudioPosition] = useState(0);

  // Animations
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;

  // Fetch a remote file to a local path WITH the bearer token.
  //
  // /uploads/{id} is RequireAuth on the server. The three loaders below each
  // called FileSystem.downloadAsync with no headers, so for any http source
  // they wrote the 401 JSON body to disk and then parsed it — "this file is not
  // a readable document" for a document that was perfectly fine. Only
  // openInDeviceApp sent the token, which is why handing the file to another
  // app worked while reading it in-app did not.
  const downloadAuthed = useCallback(async (url: string, dest: string): Promise<string> => {
    // The url comes from route params (deep links too): the token goes to our
    // own server only, never to whatever host a link names.
    const token = isOwnServerUrl(url) ? await getAccessToken() : null;
    const dl = await FileSystem.downloadAsync(
      url, dest, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
    if (dl.status >= 400) {
      throw new Error(dl.status === 401 || dl.status === 403
        ? 'You do not have access to this file.'
        : `Could not download this file (${dl.status}).`);
    }
    return dl.uri;
  }, []);

  // Plaintext this screen downloads only for itself (text/doc reading) is
  // deleted when it closes. Hand-off copies are not — another app may still be
  // reading them — and are caught by lib/mediaCacheGC's VIEWER_TEMP_PREFIX
  // sweep at boot and logout instead.
  const ownTemps = useRef<string[]>([]);
  const ownTemp = (tag: string) => {
    const p = (FileSystem.cacheDirectory || '') + VIEWER_TEMP_PREFIX + tag + '_' + Date.now();
    ownTemps.current.push(p);
    return p;
  };
  useEffect(() => () => {
    for (const p of ownTemps.current) FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
    ownTemps.current = [];
  }, []);
  /** A cache path for an external hand-off that keeps the real filename. */
  const handoffPath = async () => {
    const dir = (FileSystem.cacheDirectory || '') + VIEWER_TEMP_PREFIX + 'share_' + Date.now() + '/';
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return dir + (fileName || 'file').replace(/[/\\:*?"<>|]/g, '_');
  };

  // Read the NEXT window of a plain-text file and append it.
  //
  // readAsStringAsync only honours `position`/`length` under base64 encoding
  // (expo-file-system/build/legacy/FileSystem.types.d.ts:232), so a window comes
  // back as base64 -> bytes, and a BYTE window can cut a multi-byte character in
  // half. Telugu and Hindi are 3 bytes per character, emoji 4 — decoding each
  // window on its own corrupts one character at every boundary. lib/textWindow
  // carries the cut bytes across; this only drives it.
  // Split ONCE per window, not once per render. This used to run a full
  // regex-replace and split over the whole accumulated string on every single
  // render — including renders nothing to do with the text (the fade animation,
  // the share button's spinner) — and the string now grows by a window at a
  // time, so the cost compounded across a paging session. It is a hook at
  // component scope because renderText is called conditionally.
  const textLines = useMemo(
    () => textContent.replace(/^\uFEFF/, '').split(/\r?\n/),
    [textContent],
  );

  const readTextWindow = useCallback(async () => {
    const st = textWin.current;
    if (st.busy || !st.uri || st.done) return;
    st.busy = true;
    const first = st.pos === 0;
    try {
      const len = st.size ? Math.min(WINDOW_BYTES, st.size - st.pos) : WINDOW_BYTES;
      const b64 = await FileSystem.readAsStringAsync(
        st.uri, { encoding: FileSystem.EncodingType.Base64, position: st.pos, length: len },
      );
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
      // Advance by what CAME BACK, not by what was asked for. A file still being
      // written, or a provider that short-reads, would otherwise leave the cursor
      // past bytes nothing decoded — and this window's carry would then be glued
      // to bytes that do not follow it, so the seam decodes to garbage.
      st.pos += bytes.length;
      const atEof = bytes.length < len || (!!st.size && st.pos >= st.size);
      const { text, carry } = decodeWindow(bytes, st.carry, atEof);
      st.carry = carry;
      setTextContent(prev => prev + text);
      // Gate on BYTES CONSUMED — st.pos already is exactly that. Deciding inside
      // a setTextContent updater and reading the result back on the next line
      // was wrong twice over: React only computes an updater eagerly when no
      // other update is pending on the fiber, so the flag read false and the cap
      // silently never engaged; and an updater with a side effect runs twice
      // under StrictMode. Bytes also make the footer's "5 MB" honest, which
      // counting UTF-16 code units did not — 5M code units of Telugu is ~15 MB.
      const capped = st.pos >= MAX_TEXT_BYTES;
      if (capped) setTextCapped(true);
      st.done = atEof || capped;
      setTextMore(!st.done);
    } catch {
      // A failure PAGING is not a failure LOADING. `error` replaces the whole
      // viewer with the error card, so using it here threw away every window the
      // user had already read — six screens of a log gone because window seven
      // hiccuped. Only the FIRST window failing means the file did not open.
      if (first) setError('Could not read file contents');
      else setTextFailed(true);
      st.done = true;
      setTextMore(false);
    } finally {
      st.busy = false;
    }
  }, []);

  // Read the document's TEXT. Split out of the loader effect so a PDF can defer
  // it: pdf.js renders from the FILE (components/PdfView), so extracting text up
  // front was pure waste — it loaded the whole document into memory as base64
  // (~2.3x its size, before the Buffer and the Uint8Array) and parsed it TWICE,
  // on the JS thread, every single time a PDF was opened. For a 30 MB scan on a
  // mid-range phone that is a visible freeze for a result nothing displays.
  // Office formats still read eagerly: for them the text IS the renderer.
  const readDoc = useCallback(async (local: string) => {
    // Everything below sits behind awaits, and the screen is reused for the next
    // file and for Retry. Without this, a slow read for file A lands on file B's
    // screen and writes A's document into it.
    const run = runRef.current;
    const stale = () => runRef.current !== run;
    try {
      const b64 = await FileSystem.readAsStringAsync(local, { encoding: FileSystem.EncodingType.Base64 });
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
      if (stale()) return;
      // BLOCKS FIRST. Both passes unzip and re-parse the SAME bytes in full, and
      // the render path only ever shows docText when docBlocks is null — so
      // running extractDocText first was a second full parse of a document
      // nothing was going to display. Structure is still a bonus, never a
      // precondition: if the richer pass trips over some XML shape, or finds
      // nothing, the flat text below is exactly the fallback it always was.
      //
      // TWO PHASES. Phase one parses only the first few units — slides, sheets,
      // PDF pages, or (docx, which has no pages) blocks — so the first screen
      // paints without waiting on a 200-slide deck. fflate's filter runs per
      // entry BEFORE inflating, so for pptx/xlsx the skipped slides and sheets
      // are never decompressed at all; that is real saved work, not skipped
      // parsing. Phase two then parses the whole document and replaces the
      // preview, deferred past the first paint so the long parse cannot eat the
      // frame the user is waiting for.
      //
      // Phase two re-does phase one's work rather than merging into it. That is
      // deliberate: parsing on demand per unit would re-unzip on every request
      // (O(n^2) over a document), and merging needs the shared parts — xlsx's
      // sharedStrings above all — held and reconciled. One extra pass off the
      // critical path is the smaller, duller cost.
      let blocked = false;
      try {
        const { extractDocBlocks } = await import('../lib/docBlocks');
        // PDF is deliberately NOT limited. pdfPageStreams (lib/docText.ts) builds a
        // latin1 string of the whole file and inflates every content stream BEFORE
        // a page limit can apply, so a limited pass costs what a full one costs —
        // and phase two would then pay it a second time. One full parse is
        // cheaper than two, and this path is already the degraded one (it is only
        // reached when the native page renderer gave up).
        const k = docKind(fileName);
        const limit = k === 'pdf' ? undefined
          : k === 'docx' ? PREVIEW_DOCX_BLOCKS
          : PREVIEW_UNITS;
        const r = extractDocBlocks(bytes, fileName, { limit });
        if (!r.empty) {
          setDocBlocks(r.blocks);
          setDocEmpty(false);
          blocked = true;
          setDocMore(r.partial);
          if (r.partial) {
            // After the interactions, not on this tick: the whole point is that
            // the first paint happens before the full parse starts.
            InteractionManager.runAfterInteractions(() => {
              if (stale()) return;
              try {
                const full = extractDocBlocks(bytes, fileName);
                if (stale() || full.empty) return;
                setDocBlocks(full.blocks);
              } catch (fe: any) {
                // The preview is already on screen and stays there. A failure
                // here costs the tail of the document, never the head.
                console.warn('[docBlocks] full parse failed, keeping the preview —', fe?.message ?? fe);
              } finally {
                if (!stale()) setDocMore(false);
              }
            });
          }
        }
      } catch (be: any) {
        console.warn('[docBlocks] structured read failed, showing plain text —', be?.message ?? be);
        setDocBlocks(null);
      }
      if (!blocked) {
        setDocBlocks(null);
        const { extractDocText } = await import('../lib/docText');
        const { text, empty } = extractDocText(bytes, fileName);
        setDocText(empty ? '' : text);
        setDocEmpty(empty);
      }
    } catch (e: any) {
      // Fall back to the hand-off card rather than a dead end — but say WHY.
      // Silently showing "open in another app" is indistinguishable from the
      // feature not existing, which is exactly how it was reported.
      //
      // extractDocText's own messages are written FOR the user ("This file is
      // not a readable document."). The filesystem's are not: a file the app
      // cannot read put this on screen, verbatim —
      //   Call to function 'ExponentFileSystem.readAsStringAsync' has been
      //   rejected. → Caused by: java.io.IOException: Location
      //   'file:///sdcard/...' isn't readable.
      // — which tells the person holding the phone nothing and leaks an
      // internal path. Anything that names a native module or a Java class is
      // ours to explain, not theirs to read.
      const raw = String(e?.message ?? '');
      const internal = /ExponentFileSystem|java\.io\.|java\.lang\.|rejected|ENOENT|EACCES/i.test(raw);
      console.warn('[docText] could not read', fileName, '—', raw || e);
      if (stale()) return;
      setDocError(internal || !raw
        ? 'This file could not be opened from where it is stored. Try opening it in another app.'
        : raw);
    } finally {
      if (!stale()) setDocLoading(false);
    }
  }, [fileName]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
    const loadTextContentInEffect = async () => {
      try {
        let local = fileUri;
        if (fileUri.startsWith('http')) {
          local = await downloadAuthed(fileUri, ownTemp('view'));
        }
        // WINDOWED, not whole-file. readAsStringAsync materialises everything it
        // reads as one JS string, so reading a multi-hundred-MB .log in one call
        // took the app down — which is why this used to REFUSE anything over
        // MAX_TEXT_BYTES and send the user to another app. Reading a window at a
        // time makes the refusal unnecessary: the first screen costs one window
        // whatever the file weighs, and the cap now bounds what we accumulate.
        const info = await FileSystem.getInfoAsync(local);
        // A missing size is not a reason to fall back to one whole-file read:
        // that is exactly what killed the app on a big file, and slicing AFTER
        // readAsStringAsync bounds nothing — the process dies inside the read.
        // Windowing does not need the size; a short read is end of file. The
        // size is only a second, cheaper EOF signal when we do have it.
        const size = info.exists ? Number(info.size ?? 0) : 0;
        textWin.current = { uri: local, size, pos: 0, carry: new Uint8Array(0), busy: false, done: false };
        await readTextWindow();
      } catch {
        setError('Could not read file contents');
      }
    };

    // Office documents: read the TEXT out of them in-app instead of handing the
    // file to another app. docx/xlsx/pptx are ZIPs of XML and fflate unzips them
    // in pure JS, so this needs no native module and no page rendering — which
    // is all a reader needs. Anything else (legacy .doc, PDF) still hands off.
    const loadDocTextInEffect = async () => {
      try {
        let local = fileUri;
        if (fileUri.startsWith('http')) {
          local = await downloadAuthed(fileUri, ownTemp('doc'));
        }
        setDocLocalUri(local);
        // SIZE CHECK BEFORE READING, not after.
        //
        // readDoc materialises the document about three times over — a base64
        // JS string (~1.33x), the Buffer it decodes to, and the Uint8Array
        // copied out of that — and only THEN does extractDocText compare
        // byteLength against MAX_DOC_BYTES. So that 32 MB guard could never
        // actually stop anything: a 400 MB .docx runs out of memory at the
        // readAsStringAsync, long before reaching the check meant to refuse it.
        // The plain-text path already probes getInfoAsync first; this one did not.
        const dinfo = await FileSystem.getInfoAsync(local);
        if (dinfo.exists && dinfo.size > MAX_DOC_BYTES) {
          setDocError('This document is too large to open here. Try opening it in another app.');
          setDocLoading(false);
          return;
        }
        // A PDF renders from this file; its text is only ever the fallback, so
        // it is read when pdf.js actually gives up — see the effect below.
        if (fileType === 'pdf') { setDocLoading(false); return; }
        await readDoc(local);
      } catch (e: any) {
        console.warn('[docText] could not reach', fileName, '—', e?.message ?? e);
        setDocError('This file could not be opened from where it is stored. Try opening it in another app.');
        setDocLoading(false);
      }
    };
    const loadAudioInEffect = async () => {
      const run = runRef.current;
      try {
        // No staysActiveInBackground: this player has no notification or
        // lock-screen control, so audio that kept going after the app left the
        // foreground could not be stopped from anywhere.
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true, staysActiveInBackground: false });
        // Remote audio needs the token (our server only), like every other loader.
        const token = /^https?:/i.test(fileUri) && isOwnServerUrl(fileUri) ? await getAccessToken() : null;
        const { sound: snd } = await Audio.Sound.createAsync(
          token ? { uri: fileUri, headers: { Authorization: `Bearer ${token}` } } : { uri: fileUri },
          { shouldPlay: false },
          (status) => {
            if (status.isLoaded) {
              setAudioPosition(status.positionMillis || 0);
              setAudioDuration(status.durationMillis || 0);
              setAudioPlaying(status.isPlaying);
            }
          }
        );
        // The screen closed or moved to another file while loading: a sound
        // created now would play with no controls left to stop it.
        if (runRef.current !== run) { snd.unloadAsync().catch(() => {}); return; }
        soundRef.current = snd;
        setSound(snd);
      } catch {
        if (runRef.current === run) setError("This audio couldn't be played. It may be damaged or in an unsupported format.");
      }
    };
    const loadFileMeta = async () => {
      try {
        if (fileUri.startsWith('file://') || fileUri.startsWith(FileSystem.documentDirectory || '')) {
          const info = await FileSystem.getInfoAsync(fileUri);
          if (info.exists && info.size) setFileSize(info.size);
        }
        if (fileType === 'text') await loadTextContentInEffect();
        if (fileType === 'audio') await loadAudioInEffect();
        if ((fileType === 'office' || fileType === 'pdf') && docKind(fileName) !== 'unsupported') await loadDocTextInEffect();
        else if (fileType === 'office' || fileType === 'pdf') setDocLoading(false);
        setLoading(false);
      } catch (e: any) {
        console.warn('[file-viewer] load failed:', e?.message ?? e);
        setError('This file could not be loaded. Check your connection and try again.');
        setLoading(false);
      }
    };
    // A new load. Everything the previous one left behind is reset HERE, on the
    // one path every load goes through — synchronously, before any await, so a
    // stale footer or cursor can never be seen or acted on. Missing these is how
    // one file's contents got appended to another's: textWin still named the old
    // file while textMore was still true, so the list happily paged file A into
    // file B's screen.
    runRef.current += 1;
    textWin.current = { uri: '', size: 0, pos: 0, carry: new Uint8Array(0), busy: false, done: false };
    setTextContent(''); setTextMore(false); setTextCapped(false); setTextFailed(false);
    setDocMore(false);
    setPdfFailed(false);
    loadFileMeta();
    return () => {
      // Bump again so anything still in flight from THIS run is stale too — the
      // next effect body will bump past it either way.
      runRef.current += 1;
      soundRef.current?.unloadAsync(); soundRef.current = null;
    };
    // reloadKey: Retry re-runs THIS loader (see handleRetry) instead of the
    // component-scope duplicate, so first load and retry share one code path.
  }, [fadeIn, slideUp, fileUri, fileType, fileName, readDoc, reloadKey, downloadAuthed, readTextWindow]);

  // pdf.js could not render this file, so the text reader is about to be shown.
  // NOW the extraction is worth doing — and only now.
  useEffect(() => {
    if (fileType !== 'pdf' || !pdfFailed || !docLocalUri) return;
    setDocLoading(true);
    readDoc(docLocalUri);
  }, [fileType, pdfFailed, docLocalUri, reloadKey, readDoc]);

  // Redirect to dedicated video player when file type is video
  useEffect(() => {
    if (fileType === 'video') {
      router.replace({ pathname: '/media-viewer', params: { uri: fileUri, filename: fileName, msgType: 'video' } });
    }
  }, [fileType, fileName, fileUri, router]);

  // The component-scope loadFileMeta/loadTextContent/loadAudio trio that used to
  // sit here is GONE. It was an older duplicate of the loader inside the effect
  // above, it knew nothing about documents, and nothing called it — handleRetry
  // bumps reloadKey to re-run the real one. Two loaders that must agree is how
  // "Retry did nothing on a .docx" happened; there is now exactly one.

  // A sound unloaded under the tap (screen closing, next file) rejects; that is
  // not an error worth surfacing, and must not be an unhandled rejection.
  const toggleAudio = () => {
    if (!sound) return;
    (audioPlaying ? sound.pauseAsync() : sound.playAsync()).catch(() => {});
  };

  const seekAudio = (ratio: number) => {
    if (!sound || !audioDuration) return;
    sound.setPositionAsync(Math.floor(ratio * audioDuration)).catch(() => {});
  };

  // ── Open a document in the device's own viewer ─────────────────
  // Mirrors the chat file bubble (components/chat/MessageBubble.tsx): the file
  // is copied into the app cache — the OS FileProvider is configured over that
  // directory — then handed to ACTION_VIEW on Android, or the open-in sheet on
  // iOS, which has no ACTION_VIEW equivalent. Nothing is uploaded anywhere.
  const openInDeviceApp = async () => {
    if (openingExternally) return;
    setOpeningExternally(true);
    try {
      let localUri = fileUri;
      if (fileUri.startsWith('http')) {
        // Attachment endpoints are authenticated: without the Bearer token this
        // downloads a 401 body and then "opens" it as a PDF. downloadAuthed
        // sends it to our own server only.
        localUri = await downloadAuthed(fileUri, await handoffPath());
      }
      // Guess from the extension when the caller gave no mime — an intent with
      // no type matches no activity, and the hand-off then does nothing at all.
      const mime = resolveMime(fileName, params.mimeType || undefined);

      if (Platform.OS === 'android') {
        try {
          const contentUri = await FileSystem.getContentUriAsync(localUri);
          await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
            data: contentUri,
            // 1 = GRANT_READ_URI_PERMISSION (without it the target app cannot
            // read the file), 0x10000000 = NEW_TASK. Launching from a non-
            // Activity context without NEW_TASK is the other way this silently
            // fails to start anything.
            flags: 1 | 0x10000000,
            type: mime,
          });
        } catch {
          // Nothing installed can VIEW this type → offer share/save instead.
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(localUri, { mimeType: mime, dialogTitle: fileName });
          } else {
            setError('No app on this device can open this file type.');
          }
        }
      } else if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(localUri, { mimeType: mime, dialogTitle: fileName });
      } else {
        setError('No app on this device can open this file type.');
      }
    } catch (e: any) {
      console.warn('[file-viewer] hand-off failed:', e?.message ?? e);
      setError('This file could not be handed to another app. Check your connection and try again.');
    } finally {
      setOpeningExternally(false);
    }
  };

  // ── Share / open externally ────────────────────────────────────
  const handleShare = async () => {
    try {
      let localUri = fileUri;
      if (fileUri.startsWith('http')) {
        localUri = await downloadAuthed(fileUri, await handoffPath());
      }
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'No app on this device can receive this file.');
        return;
      }
      await Sharing.shareAsync(localUri);
    } catch (e: any) {
      console.warn('[file-viewer] share failed:', e?.message ?? e);
      Alert.alert('Could not share', 'This file could not be shared. Check your connection and try again.');
    }
  };

  // ── Retry handler ──────────────────────────────────────────────
  // Bumps a key the load effect depends on, rather than calling the
  // component-scope loadFileMeta(). That function is an older DUPLICATE of the
  // loader inside the effect and knows nothing about documents, so retrying a
  // failed .docx cleared the error and then loaded nothing — a Retry button
  // that visibly did nothing. Re-running the effect uses one loader for both
  // the first attempt and every retry, so they cannot drift again.
  const handleRetry = () => {
    setError('');
    setLoading(true);
    setDocError(null);
    setDocBlocks(null);
    setDocLoading(true);
    setReloadKey(k => k + 1);
  };

  // ── Determine background color ─────────────────────────────────
  const bgColor = fileType === 'image' || fileType === 'video' ? C.bgPure : C.bg;

  // ── Pick renderer ──────────────────────────────────────────────
  const openProps = { opening: openingExternally, onOpen: openInDeviceApp };

  // A PDF is PAGES (components/PdfView). The text reader stays as the fallback
  // for anything the page renderer cannot open, and the device hand-off stays
  // under both of them.
  const renderOffice = () => {
    if (docLoading) return <LoadingPane fileType={fileType} />;
    if (docError || docKind(fileName) === 'unsupported') {
      return <DocumentCard icon={fmt.icon} fileName={fileName} label={fmt.label} reason={docError ?? undefined} {...openProps} />;
    }
    if (docEmpty) return <DocEmpty icon={fmt.icon} fileName={fileName} isPdf={fileType === 'pdf'} onOpen={openInDeviceApp} />;
    return <DocReader blocks={docBlocks} text={docText} more={docMore} {...openProps} />;
  };

  const renderPDF = () => {
    if (pdfFailed) return renderOffice();
    if (!docLocalUri) return <LoadingPane fileType={fileType} />;
    return (
      <View style={s.contentFill}>
        <PdfView
          uri={docLocalUri}
          onFail={why => {
            console.warn('[PdfView] falling back to the text reader —', why);
            setPdfFailed(true);
          }}
        />
        <DocActionBar hint="Pinch to zoom · scroll to read" {...openProps} />
      </View>
    );
  };

  const renderContent = () => {
    if (error) return <ErrorPane message={error} onRetry={handleRetry} />;
    if (loading && fileType !== 'image' && fileType !== 'pdf' && fileType !== 'office') return <LoadingPane fileType={fileType} />;
    switch (fileType) {
      case 'image':
        return (
          <ImagePane uri={fileUri} fileName={fileName}
            onLoaded={() => setLoading(false)}
            onFail={msg => { setError(msg); setLoading(false); }} />
        );
      case 'video':
        // Redirected to media-viewer by the effect above.
        return (
          <View style={[s.centered, s.flex]}>
            <Text style={s.loadingText}>Opening video player...</Text>
          </View>
        );
      case 'pdf': return renderPDF();
      case 'office': return renderOffice();
      case 'text':
        return (
          <TextPane
            lines={textLines}
            ext={fileName.split('.').pop()?.toLowerCase() || ''}
            more={textMore} failed={textFailed} capped={textCapped}
            onEndReached={readTextWindow}
            onRetryRest={() => { textWin.current.done = false; setTextFailed(false); setTextMore(true); }}
            {...openProps}
          />
        );
      case 'audio':
        return (
          <AudioPane fileName={fileName} fileSize={fileSize} position={audioPosition} duration={audioDuration}
            playing={audioPlaying} onToggle={toggleAudio} onSeek={seekAudio} />
        );
      default: return <UnknownPane fileName={fileName} fileSize={fileSize} />;
    }
  };

  // ══════════════════════════════════════════════════════════════
  // ██  MAIN LAYOUT
  // ══════════════════════════════════════════════════════════════
  return (
    <View style={[s.root, { backgroundColor: bgColor }]}>
      <StatusBar barStyle="light-content" backgroundColor={bgColor} />
      <Stack.Screen options={{ headerShown: false, animation: 'slide_from_bottom' }} />

      {/* ── Header ─────────────────────────────────────────────── */}
      <Animated.View
        onLayout={e => setHeaderH(e.nativeEvent.layout.height)}
        style={[s.header, { paddingTop: insets.top + 8, opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
        {fileType === 'image' && (
          <LinearGradient colors={['rgba(0,0,0,0.7)', 'transparent']} style={StyleSheet.absoluteFillObject} />
        )}
        <View style={s.headerInner}>
          <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back" style={s.headerBtn}>
            <Ionicons name="arrow-back" size={20} color={C.text} />
          </TouchableOpacity>

          <View style={s.headerCenter}>
            <View style={s.headerFilenameRow}>
              <Text style={s.headerIcon} importantForAccessibility="no" accessibilityElementsHidden>{fmt.icon}</Text>
              <Text style={s.headerFilename} numberOfLines={1} accessibilityRole="header">{fileName}</Text>
            </View>
            {fileSize > 0 && (
              <Text style={s.headerSize}>{formatBytes(fileSize)} · {fmt.label.toUpperCase()}</Text>
            )}
          </View>

          <TouchableOpacity onPress={handleShare} accessibilityRole="button" accessibilityLabel="Share this file" style={s.headerBtn}>
            <Ionicons name="share-outline" size={20} color={C.text} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* ── Content area ───────────────────────────────────────── */}
      <Animated.View style={[s.content, { paddingTop: headerH || insets.top + 64, opacity: fadeIn }]}>
        {renderContent()}
      </Animated.View>

      {/* ── Bottom bar ─────────────────────────────────────────── */}
      {/* Only where the content has no "Open in another app" of its own: PDF,
          documents and text carry one in their action bar, and a second button
          here that merely re-opened the share sheet was a duplicate. Share is
          the header button. */}
      {(fileType === 'image' || fileType === 'audio' || fileType === 'unknown') && !error && (
        <Animated.View style={[s.bottomBar, { paddingBottom: insets.bottom + 12, opacity: fadeIn, transform: [{ translateY: Animated.multiply(slideUp, -1) }] }]}>
          <TouchableOpacity onPress={openInDeviceApp} disabled={openingExternally} style={s.bottomBtn}
            accessibilityRole="button" accessibilityLabel="Open in another app"
            accessibilityState={{ busy: openingExternally, disabled: openingExternally }}>
            <LinearGradient colors={CTA_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.bottomBtnGradient}>
              {openingExternally ? <ActivityIndicator color={C.onFill} /> : <Text style={s.bottomBtnText}>Open in another app</Text>}
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

// A render fault in a viewer used to take the WHOLE app down: these screens
// render untrusted, arbitrary media (a truncated video, a malformed PDF, an
// office file with a codec this device lacks) and none of them were wrapped.
// The boundary turns that crash into a dismissable screen with the chat intact.
export default function FileViewerScreenBoundary() {
  return (
    <ErrorBoundary screen="FileViewerScreen" fallbackTitle="File Viewer Error" fallbackMessage="This document could not be displayed.">
      <FileViewerScreen />
    </ErrorBoundary>
  );
}
