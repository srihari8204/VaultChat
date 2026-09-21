// app/file-viewer.tsx — Universal File Viewer for crazzychat
// View ANY file without leaving the app: images, videos, PDFs, Office docs,
// code/text files, audio — all rendered inline with premium UI.

import { Ionicons } from '@expo/vector-icons';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { BRAND_ACCENT } from '../constants/theme';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  PanResponder,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import * as IntentLauncher from 'expo-intent-launcher';
import { getAccessToken } from '../lib/api';
import { Buffer } from 'buffer';
import { docKind, MAX_DOC_BYTES } from '../lib/docText';
import type { Block } from '../lib/docBlocks';
import { DocView } from '../components/DocView';
import { PdfView } from '../components/PdfView';
import type { Palette } from '../constants/theme';


/**
 * Ceiling for the plain-text viewer. Generous — 5 MB of text is well over a
 * hundred thousand lines — but finite, which is the point.
 */
const MAX_TEXT_BYTES = 5 * 1024 * 1024;

// ── Design tokens ────────────────────────────────────────────────
const C = {
  // bg WAS '#FFFFFF' while every foreground here is white (text, dims, the
  // card fills) — the screen rendered white-on-white and was unusable on a
  // device. The rest of this palette is unmistakably a dark navy design
  // (white text, rgba(255,255,255,..) dims, near-black glass), so the
  // background is what was wrong, not the foregrounds.
  bg: '#020B18',
  bgPure: '#000000',
  primary: '#4A9FFF',
  secondary: '#7C3AED',
  accent: BRAND_ACCENT,
  danger: '#EF4444',
  warning: '#F59E0B',
  text: '#FFFFFF',
  textDim: 'rgba(255,255,255,0.55)',
  textFaint: 'rgba(255,255,255,0.25)',
  border: 'rgba(74,159,255,0.15)',
  glass: 'rgba(2,11,24,0.72)',
  glassBorder: 'rgba(255,255,255,0.08)',
};

/**
 * The document reader's palette: INK ON PAPER.
 *
 * The rest of this screen is a dark media surface, and the tokens above are all
 * written for it — `text` is #FFFFFF, `textDim` is white at 55%. But `bgColor`
 * below gives a document a WHITE page (only image and video get the black one),
 * so every one of those tokens was near-white on near-white: the document text
 * was there, correctly parsed, and effectively invisible. A photo of the phone is
 * the only way that shows up — a dump reports the text either way.
 *
 * Paper is the right surface for the content (it is what a document looks like,
 * and it is what reads well over pages of text) so the fix is dark ink, not a
 * dark page. The chrome above and below stays dark, which is exactly how every
 * document reader frames a page.
 */
const paperColors = {
  primary: '#2563EB', accent: C.accent, purple: C.secondary,
  danger: '#DC2626', success: '#16A34A', online: '#16A34A',
  bg: '#FFFFFF', surface: '#F1F3F5', surfaceSolid: '#FFFFFF',
  card: '#FFFFFF', border: '#D8DDE3', separator: '#E8ECEF',
  text: '#111827', textDim: '#4B5563', textFaint: '#8A94A0',
  chatBg: '#FFFFFF', bubbleIn: '#F1F3F5', bubbleOut: '#DCF8C6',
  bubbleInText: '#111827', bubbleOutText: '#111827',
  bubbleMetaIn: '#6B7280', bubbleMetaOut: '#6B7280',
  tickRead: '#2563EB', headerBar: '#FFFFFF',
  glass: 'rgba(17,24,39,0.06)', glassSoft: '#F8FAFC',
  glassStroke: 'rgba(17,24,39,0.12)', hairline: '#E5E7EB',
  groundDisc: '#FFFFFF', accentLight: '#60A5FA', accentDeep: '#2563EB',
  accentOn: '#1D4ED8', brandOnLight: '#1552E0',
} as Palette;

// ── File type detection ──────────────────────────────────────────
const EXT_MAP: Record<string, string> = {};
['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg'].forEach(e => (EXT_MAP[e] = 'image'));
['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'].forEach(e => (EXT_MAP[e] = 'video'));
['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'].forEach(e => (EXT_MAP[e] = 'audio'));
['pdf'].forEach(e => (EXT_MAP[e] = 'pdf'));
['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx'].forEach(e => (EXT_MAP[e] = 'office'));
// tsv and conf are in lib/docOpen.ts's DOCUMENT list, which routes them HERE.
// They were missing from this map, so detectType returned 'unknown' and a file
// the router had just promised to render showed the hand-off card instead —
// exactly the mismatch docOpen's "extend BOTH or neither" note warns about.
['txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'md', 'csv', 'tsv', 'xml', 'html', 'css', 'sql', 'sh', 'yaml', 'yml', 'toml', 'ini', 'conf', 'log', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'swift', 'kt', 'dart', 'php'].forEach(e => (EXT_MAP[e] = 'text'));

/**
 * MIME for the Android VIEW intent, derived from the extension.
 *
 * An intent carrying a content:// URI and NO type resolves to no activity on
 * most devices: Android matches on the type, not the file name. The hand-off
 * then does nothing at all — no chooser, no error, no crash — which is exactly
 * how "open in another app" appeared broken.
 *
 * The caller does not reliably supply one. Chat bubbles pass whatever mime the
 * attachment row carried, and for anything sent before that was recorded (or
 * sent by a client that never set it) that is empty. Guessing from the
 * extension is what every file manager does, and it costs one lookup.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', html: 'text/html', md: 'text/markdown',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
};

/** The caller's mime if it gave one, else guessed from the name. */
function resolveMime(filename: string, mimeType?: string): string | undefined {
  if (mimeType) return mimeType;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  // Last resort: */* still shows a chooser, which beats silently doing nothing.
  return MIME_BY_EXT[ext] ?? (ext ? '*/*' : undefined);
}

function detectType(filename: string, mimeType?: string): string {
  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'office';
    if (mimeType.includes('document') || mimeType.includes('word')) return 'office';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'office';
    if (mimeType.startsWith('text/')) return 'text';
  }
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  return EXT_MAP[ext] || 'unknown';
}

// ── Helpers ──────────────────────────────────────────────────────
function formatBytes(b: number): string {
  if (!b || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

function formatDuration(ms: number): string {
  if (!ms) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

const SYNTAX_COLORS: Record<string, string> = {
  keyword: '#C678DD',
  string: '#98C379',
  comment: '#5C6370',
  number: '#D19A66',
  function: '#61AFEF',
  operator: '#56B6C2',
  default: '#ABB2BF',
};

const FILE_ICONS: Record<string, string> = {
  image: '🖼️', video: '🎬', audio: '🎵', pdf: '📄',
  office: '📊', text: '📝', unknown: '📎',
};

/**
 * What the USER calls this file, and an icon that matches it.
 *
 * `fileType` above is an internal bucket for choosing a renderer — 'office'
 * covers Word, Excel and PowerPoint alike. Printing it raw put "36.1 KB · OFFICE"
 * under a Word document and gave all three the same bar-chart icon, so a report
 * and a spreadsheet were indistinguishable at a glance. The bucket is right for
 * picking code paths and wrong for showing a person.
 *
 * Keyed by extension because that is what actually determines the format; the
 * bucket is the fallback for everything with no specific name.
 */
const FORMAT: Record<string, { label: string; icon: string }> = {
  docx: { label: 'Word',       icon: '📘' },
  doc:  { label: 'Word',       icon: '📘' },
  xlsx: { label: 'Excel',      icon: '📗' },
  xls:  { label: 'Excel',      icon: '📗' },
  csv:  { label: 'CSV',        icon: '📗' },
  pptx: { label: 'PowerPoint', icon: '📙' },
  ppt:  { label: 'PowerPoint', icon: '📙' },
  pdf:  { label: 'PDF',        icon: '📕' },
};

function formatOf(filename: string, fileType: string): { label: string; icon: string } {
  const ext = (filename || '').split('.').pop()?.toLowerCase() || '';
  return FORMAT[ext] ?? {
    label: (ext || fileType).toUpperCase(),
    icon: FILE_ICONS[fileType] ?? '📎',
  };
}

// ── Skeleton shimmer component ───────────────────────────────────
function SkeletonShimmer({
 width: w, height: h, style }: any) {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const { width: SW } = useWindowDimensions();

  const shimmer = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.timing(shimmer, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: true })
    ).start();
  }, [shimmer]);
  const translateX = shimmer.interpolate({ inputRange: [0, 1], outputRange: [-(w || SW), (w || SW)] });
  return (
    <View style={[{ width: w || SW, height: h || 200, borderRadius: 8, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.04)' }, style]}>
      <Animated.View style={{ ...StyleSheet.absoluteFillObject, transform: [{ translateX }] }}>
        <LinearGradient colors={['transparent', 'rgba(255,255,255,0.06)', 'transparent']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFillObject} />
      </Animated.View>
    </View>
  );
}

// ── Waveform bars for audio ──────────────────────────────────────
function WaveformBars({ progress, barCount = 48 }: { progress: number; barCount?: number }) {
  const heights = useRef(Array.from({ length: barCount }, () => 0.15 + Math.random() * 0.85)).current;
  return (
    <View style={s.waveContainer}>
      {heights.map((h, i) => {
        const filled = i / barCount <= progress;
        return (
          <View
            key={i}
            style={[
              s.waveBar,
              { height: h * 56, backgroundColor: filled ? C.primary : 'rgba(255,255,255,0.12)' },
            ]}
          />
        );
      })}
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════
// ██  MAIN SCREEN
// ══════════════════════════════════════════════════════════════════
function FileViewerScreen() {
  // Own the live metrics here: the hook further up belongs to
  // SkeletonShimmer, a different component, and this screen previously
  // read a frozen module-level Dimensions.get().
  const { width: SW, height: SH } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ uri: string; filename: string; mimeType?: string }>();
  const fileUri = (params.uri || '') + '';
  const fileName = (params.filename || 'file') + '';
  const fileType = detectType(fileName, params.mimeType as string | undefined);
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
  const [pdfFailed, setPdfFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [openingExternally, setOpeningExternally] = useState(false);
  // Live width of the audio seek bar, from onLayout — see the seek handler.
  const [seekW, setSeekW] = useState(0);

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

  // Image zoom state
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const lastScale = useRef(1);
  const lastDx = useRef(0);
  const lastDy = useRef(0);
  const lastTap = useRef(0);

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
    const token = await getAccessToken();
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

  // Read the document's TEXT. Split out of the loader effect so a PDF can defer
  // it: pdf.js renders from the FILE (components/PdfView), so extracting text up
  // front was pure waste — it loaded the whole document into memory as base64
  // (~2.3x its size, before the Buffer and the Uint8Array) and parsed it TWICE,
  // on the JS thread, every single time a PDF was opened. For a 30 MB scan on a
  // mid-range phone that is a visible freeze for a result nothing displays.
  // Office formats still read eagerly: for them the text IS the renderer.
  const readDoc = useCallback(async (local: string) => {
    try {
      const b64 = await FileSystem.readAsStringAsync(local, { encoding: 'base64' as any });
      const bytes = Uint8Array.from(Buffer.from(b64, 'base64'));
      const { extractDocText } = await import('../lib/docText');
      const { text, empty } = extractDocText(bytes, fileName);
      setDocText(empty ? '' : text);
      setDocEmpty(empty);
      // Structure is a bonus on top of the text, never a precondition for it:
      // a document that reads fine flat must not become unreadable because the
      // richer pass tripped over some XML shape.
      try {
        const { extractDocBlocks } = await import('../lib/docBlocks');
        const r = extractDocBlocks(bytes, fileName);
        setDocBlocks(r.empty ? null : r.blocks);
      } catch (be: any) {
        console.warn('[docBlocks] structured read failed, showing plain text —', be?.message ?? be);
        setDocBlocks(null);
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
      setDocError(internal || !raw
        ? 'This file could not be opened from where it is stored. Try opening it in another app.'
        : raw);
    } finally {
      setDocLoading(false);
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
          local = await downloadAuthed(fileUri, FileSystem.cacheDirectory + 'temp_view_' + Date.now());
        }
        // Documents are capped at MAX_DOC_BYTES; plain text had no ceiling at
        // all, and readAsStringAsync materialises the WHOLE file as one JS
        // string. A multi-hundred-MB .log — the exact thing someone opens from
        // a chat "just to look" — takes the app down with it. Refuse it and
        // point at the hand-off, which is what the device is better at anyway.
        const info = await FileSystem.getInfoAsync(local);
        if (info.exists && (info as any).size > MAX_TEXT_BYTES) {
          setError('This file is too large to open here. Try opening it in another app.');
          return;
        }
        setTextContent(await FileSystem.readAsStringAsync(local));
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
          local = await downloadAuthed(fileUri, FileSystem.cacheDirectory + 'temp_doc_' + Date.now());
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
        if (dinfo.exists && (dinfo as any).size > MAX_DOC_BYTES) {
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
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true, staysActiveInBackground: true });
        const { sound: snd } = await Audio.Sound.createAsync(
          { uri: fileUri },
          { shouldPlay: false },
          (status) => {
            if (status.isLoaded) {
              setAudioPosition(status.positionMillis || 0);
              setAudioDuration(status.durationMillis || 0);
              setAudioPlaying(status.isPlaying);
            }
          }
        );
        soundRef.current = snd;
        setSound(snd);
      } catch {
        setError('Could not load audio');
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
        setError(e.message || 'Failed to load file');
        setLoading(false);
      }
    };
    loadFileMeta();
    return () => { soundRef.current?.unloadAsync(); soundRef.current = null; };
    // reloadKey: Retry re-runs THIS loader (see handleRetry) instead of the
    // component-scope duplicate, so first load and retry share one code path.
  }, [fadeIn, slideUp, fileUri, fileType, fileName, readDoc, reloadKey, downloadAuthed]);

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

  const toggleAudio = async () => {
    if (!sound) return;
    if (audioPlaying) {
      await sound.pauseAsync();
    } else {
      await sound.playAsync();
    }
  };

  const seekAudio = async (ratio: number) => {
    if (!sound || !audioDuration) return;
    await sound.setPositionAsync(Math.floor(ratio * audioDuration));
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
        // downloads a 401 body and then "opens" it as a PDF.
        const token = await getAccessToken();
        const safeName = (fileName || 'file').replace(/[/\\:*?"<>|]/g, '_');
        const dl = await FileSystem.downloadAsync(
          fileUri,
          (FileSystem.cacheDirectory || '') + safeName,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
        );
        if (dl.status >= 400) throw new Error(`Download failed (${dl.status})`);
        localUri = dl.uri;
      }
      // Guess from the extension when the caller gave no mime — an intent with
      // no type matches no activity, and the hand-off then does nothing at all.
      const mime = resolveMime(fileName, (params.mimeType as string | undefined) || undefined);

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
      setError(e?.message ?? 'Could not open this file');
    } finally {
      setOpeningExternally(false);
    }
  };

  // ── Share / open externally ────────────────────────────────────
  const handleShare = async () => {
    try {
      let localUri = fileUri;
      if (fileUri.startsWith('http')) {
        const safeName = (fileName || 'file').replace(/[/\:*?"<>|]/g, '_');
        localUri = await downloadAuthed(fileUri, (FileSystem.cacheDirectory || '') + safeName);
      }
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(localUri);
      }
    } catch { /* silently fail */ }
  };

  // ── Double-tap to zoom (images) ────────────────────────────────
  const handleDoubleTap = () => {
    if (lastScale.current > 1) {
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
      ]).start();
      lastScale.current = 1;
      lastDx.current = 0;
      lastDy.current = 0;
    } else {
      Animated.spring(scale, { toValue: 2.5, useNativeDriver: true }).start();
      lastScale.current = 2.5;
    }
  };

  // ── Pan responder for image gestures ───────────────────────────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) > 2 || Math.abs(gs.dy) > 2,
      onPanResponderGrant: () => {
        const now = Date.now();
        if (now - lastTap.current < 280) {
          handleDoubleTap();
        }
        lastTap.current = now;
      },
      onPanResponderMove: (_, gs) => {
        if (lastScale.current > 1) {
          translateX.setValue(lastDx.current + gs.dx);
          translateY.setValue(lastDy.current + gs.dy);
        }
      },
      onPanResponderRelease: (_, gs) => {
        lastDx.current += gs.dx;
        lastDy.current += gs.dy;
      },
    })
  ).current;

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

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Image viewer
  // ══════════════════════════════════════════════════════════════
  const renderImage = () => (
    <View style={[s.contentFill, { backgroundColor: C.bgPure }]}>
      <Animated.View
        {...panResponder.panHandlers}
        style={[s.contentFill, { transform: [{ scale }, { translateX }, { translateY }] }]}
      >
        <Image
          source={{ uri: fileUri }}
          style={s.contentFill}
          contentFit="contain"
          onLoadEnd={() => setLoading(false)}
          onError={() => { setError('Failed to load image'); setLoading(false); }}
        />
      </Animated.View>
      {/* Glassmorphic filename overlay */}
      <View style={s.imageOverlay}>
        <View style={s.glassChip}>
          <Text style={s.glassChipText} numberOfLines={1}>{fileName}</Text>
        </View>
      </View>
    </View>
  );

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Video — route to dedicated player
  // ══════════════════════════════════════════════════════════════
  const renderVideo = () => (
    <View style={[s.centered, { flex: 1 }]}>
      <Text style={s.loadingText}>Opening video player...</Text>
    </View>
  );

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: PDF — handed to the device's own viewer
  // ══════════════════════════════════════════════════════════════
  //
  // This used to be `https://docs.google.com/gview?url=<fileUri>` in a WebView,
  // which meant GOOGLE FETCHED AND READ THE DOCUMENT: for an https attachment
  // that handed Google a working (often presigned) URL to the user's private
  // file, and for a local file:// path Google could not reach it at all, so the
  // viewer just span forever. Either way it defeated the point of an app whose
  // media is E2EE and whose attachments are sealed at rest.
  //
  // The file now never leaves the device. Same mechanism the chat file bubble
  // already uses (components/chat/MessageBubble.tsx): copy into the app cache
  // so the OS FileProvider can share it, then ACTION_VIEW on Android / the
  // share-open sheet on iOS, and let whatever PDF app the user has render it.
  const renderDocument = (label: string, reason?: string) => (
    <View style={[s.centered, s.contentFill]}>
      <Text style={s.fileIcon}>{fmt.icon}</Text>
      <Text style={s.loadingText}>{fileName}</Text>
      <Text style={[s.loadingText, { fontSize: 12, opacity: 0.7, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 }]}>
        {reason ? reason : `Opens in your ${label} app. The file stays on this device.`}
      </Text>
      <TouchableOpacity
        style={s.openBtn}
        onPress={openInDeviceApp}
        disabled={openingExternally}
        activeOpacity={0.85}
      >
        {openingExternally
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.openBtnTxt}>Open</Text>}
      </TouchableOpacity>
    </View>
  );

  // A PDF is PAGES. The text reader stays as the fallback for anything pdf.js
  // cannot open, and the device hand-off stays under both of them.
  const renderPDF = () => {
    if (pdfFailed) return renderOffice();
    if (!docLocalUri) return renderLoading();
    return (
      <View style={s.contentFill}>
        <PdfView
          uri={docLocalUri}
          onFail={why => {
            console.warn('[PdfView] falling back to the text reader —', why);
            setPdfFailed(true);
          }}
        />
        <View style={s.docActionBar}>
          <Text style={s.docActionHint} numberOfLines={1}>Pinch to zoom</Text>
          <TouchableOpacity
            onPress={openInDeviceApp}
            disabled={openingExternally}
            style={s.docActionBtn}
            activeOpacity={0.85}
          >
            {openingExternally
              ? <ActivityIndicator color={C.primary} size="small" />
              : <>
                  <Ionicons name="open-outline" size={16} color={C.primary} />
                  <Text style={s.docActionTxt}>Open in another app</Text>
                </>}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Office docs — same on-device path as PDF above
  // ══════════════════════════════════════════════════════════════
  //
  // .docx/.xlsx/.pptx are read IN-APP as plain text (lib/docText). No page
  // rendering, no layout, no native dependency — a reader only needs the words.
  // Anything that cannot be read that way (legacy .doc/.xls/.ppt, a corrupt
  // file) still falls back to the device hand-off rather than a dead end.
  const renderOffice = () => {
    if (docLoading) return renderLoading();
    if (docError || docKind(fileName) === 'unsupported') return renderDocument(fmt.label, docError ?? undefined);
    if (docEmpty) {
      return (
        <View style={[s.centered, s.contentFill]}>
          <Text style={s.fileIcon}>{fmt.icon}</Text>
          <Text style={s.loadingText}>{fileName}</Text>
          <Text style={[s.loadingText, { fontSize: 12, opacity: 0.7, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 }]}>
            {fileType === 'pdf'
              // The overwhelmingly common cause for a PDF: it is a scan, so there
              // is no text layer to read — only an image of one.
              ? 'This PDF has no text layer (it may be a scan). Open it in a PDF app to view the pages.'
              : 'No readable text in this document.'}
          </Text>
          <TouchableOpacity style={s.openBtn} onPress={openInDeviceApp} activeOpacity={0.85}>
            <Text style={s.openBtnTxt}>Open in another app</Text>
          </TouchableOpacity>
        </View>
      );
    }
    // Reading in-app and opening elsewhere are both offered, always. In-app is
    // the default because it is instant and the file never leaves the device;
    // the external app is one tap away for anything this plain-text view cannot
    // show (formatting, images, charts, a spreadsheet's real grid).
    return (
      <View style={s.contentFill}>
        {docBlocks ? (
          <DocView blocks={docBlocks} colors={paperColors} />
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 18, paddingBottom: 24 }}
            showsVerticalScrollIndicator
            indicatorStyle="white"
          >
            {/* Ink, not near-white: this sits on the same white page as the
                reader above, where #E5E7EB was invisible. */}
            <Text selectable style={{ color: paperColors.text, fontSize: 16, lineHeight: 25 }}>
              {docText}
            </Text>
          </ScrollView>
        )}
        <View style={s.docActionBar}>
          <Text style={s.docActionHint} numberOfLines={1}>
            {docBlocks ? 'Reader view — no images or charts' : 'Text only — no formatting'}
          </Text>
          <TouchableOpacity
            onPress={openInDeviceApp}
            disabled={openingExternally}
            style={s.docActionBtn}
            activeOpacity={0.85}
          >
            {openingExternally
              ? <ActivityIndicator color={C.primary} size="small" />
              : <>
                  <Ionicons name="open-outline" size={16} color={C.primary} />
                  <Text style={s.docActionTxt}>Open in another app</Text>
                </>}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Text / Code viewer
  // ══════════════════════════════════════════════════════════════
  const renderText = () => {
    // split on a bare \n left a trailing CR on every line of a CRLF file — a
    // Windows .csv or .log rendered with an invisible stray character at each
    // line end, which shifts the last column and corrupts any copy-paste out of
    // it. A BOM does the same at the start: U+FEFF printed as a stray glyph
    // before the first character of line 1.
    const lines = textContent.replace(/^\uFEFF/, '').split(/\r?\n/);
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    return (
      <View style={s.contentFill}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.codeContainer}
        showsVerticalScrollIndicator
        indicatorStyle="white"
      >
        <View style={s.codeHeader}>
          <View style={s.codeLangBadge}>
            <Text style={s.codeLangText}>{ext.toUpperCase()}</Text>
          </View>
          <Text style={s.codeLineCount}>{lines.length} lines</Text>
        </View>
        {lines.map((line, idx) => (
          <View key={idx} style={s.codeLine}>
            <Text style={s.lineNumber}>{idx + 1}</Text>
            <Text style={s.lineText}>{line || ' '}</Text>
          </View>
        ))}
      </ScrollView>
      {/* Same choice as documents get: read here, or hand the file to whatever
          app the user prefers. Consistent across every readable type. */}
      <View style={s.docActionBar}>
        <Text style={s.docActionHint} numberOfLines={1}>{lines.length} lines</Text>
        <TouchableOpacity
          onPress={openInDeviceApp}
          disabled={openingExternally}
          style={s.docActionBtn}
          activeOpacity={0.85}
        >
          {openingExternally
            ? <ActivityIndicator color={C.primary} size="small" />
            : <>
                <Ionicons name="open-outline" size={16} color={C.primary} />
                <Text style={s.docActionTxt}>Open in another app</Text>
              </>}
        </TouchableOpacity>
      </View>
      </View>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Audio player
  // ══════════════════════════════════════════════════════════════
  const renderAudio = () => {
    const progress = audioDuration > 0 ? audioPosition / audioDuration : 0;
    return (
      <View style={[s.centered, { flex: 1, paddingHorizontal: 24 }]}>
        {/* Album art placeholder */}
        <View style={s.audioArtCircle}>
          <LinearGradient
            colors={[C.primary, C.secondary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={s.audioGradient}
          >
            <Text style={s.audioIcon}>🎵</Text>
          </LinearGradient>
        </View>

        <Text style={s.audioTitle} numberOfLines={2}>{fileName}</Text>
        {fileSize > 0 && <Text style={s.audioMeta}>{formatBytes(fileSize)}</Text>}

        {/* Waveform */}
        <View style={{ marginTop: 32, width: '100%' }}>
          <WaveformBars progress={progress} />
          {/* Seek touch area */}
          <TouchableOpacity
            activeOpacity={1}
            style={s.seekTouchArea}
            onLayout={(e) => setSeekW(e.nativeEvent.layout.width)}
            onPress={(e) => {
              // Measured width, not (SW - 48). SW came from a module-level
              // Dimensions.get captured ONCE at import, so after a rotation or
              // a split-screen resize the divisor was the old screen width and
              // every tap on the seek bar jumped to the wrong position — worse
              // the further from the start you tapped. locationX is relative to
              // this view, so the view's own width is the only correct divisor.
              const x = e.nativeEvent.locationX;
              const ratio = x / (seekW || 1);
              seekAudio(Math.max(0, Math.min(1, ratio)));
            }}
          />
        </View>

        {/* Time labels */}
        <View style={s.audioTimeRow}>
          <Text style={s.audioTime}>{formatDuration(audioPosition)}</Text>
          <Text style={s.audioTime}>{formatDuration(audioDuration)}</Text>
        </View>

        {/* Controls */}
        <View style={s.audioControls}>
          <TouchableOpacity
            onPress={() => seekAudio(Math.max(0, (audioPosition - 15000) / (audioDuration || 1)))}
            style={s.audioBtn}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Ionicons name="play-back" size={14} color={C.textDim} />
              <Text style={s.audioBtnText}>15s</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity onPress={toggleAudio} accessibilityLabel={audioPlaying ? "Pause" : "Play"} style={s.audioPlayBtn}>
            <LinearGradient
              colors={[C.primary, '#3B82F6']}
              style={s.audioPlayGradient}
            >
              <Ionicons name={audioPlaying ? 'pause' : 'play'} size={24} color="#fff" />
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => seekAudio(Math.min(1, (audioPosition + 15000) / (audioDuration || 1)))}
            style={s.audioBtn}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={s.audioBtnText}>15s</Text>
              <Ionicons name="play-forward" size={14} color={C.textDim} />
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Unknown file type
  // ══════════════════════════════════════════════════════════════
  const renderUnknown = () => (
    <View style={[s.centered, { flex: 1, paddingHorizontal: 32 }]}>
      <Text style={{ fontSize: 64 }}>📎</Text>
      <Text style={[s.errorTitle, { marginTop: 16 }]}>{fileName}</Text>
      {fileSize > 0 && <Text style={s.audioMeta}>{formatBytes(fileSize)}</Text>}
      <Text style={[s.loadingText, { marginTop: 12, textAlign: 'center' }]}>
        This file type cannot be previewed in-app.{'\n'}Use &quot;Open With...&quot; to view it externally.
      </Text>
    </View>
  );

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Error state
  // ══════════════════════════════════════════════════════════════
  const renderError = () => (
    <View style={[s.centered, { flex: 1 }]}>
      <View style={s.errorCircle}>
        <Text style={{ fontSize: 36 }}>⚠️</Text>
      </View>
      <Text style={s.errorTitle}>Unable to load file</Text>
      <Text style={s.errorDesc}>{error}</Text>
      <TouchableOpacity onPress={handleRetry} style={s.retryBtn}>
        <LinearGradient colors={[C.primary, '#3B82F6']} style={s.retryGradient}>
          <Text style={s.retryText}>Retry</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Loading state
  // ══════════════════════════════════════════════════════════════
  const renderLoading = () => (
    <View style={[s.centered, { flex: 1, gap: 16 }]}>
      <SkeletonShimmer width={SW * 0.7} height={16} style={{ borderRadius: 8 }} />
      <SkeletonShimmer width={SW * 0.85} height={SH * 0.35} style={{ borderRadius: 12, marginTop: 8 }} />
      <SkeletonShimmer width={SW * 0.5} height={14} style={{ borderRadius: 8, marginTop: 8 }} />
      <SkeletonShimmer width={SW * 0.6} height={14} style={{ borderRadius: 8 }} />
      <Text style={[s.loadingText, { marginTop: 12 }]}>Loading {fileType}...</Text>
    </View>
  );

  // ── Pick renderer ──────────────────────────────────────────────
  const renderContent = () => {
    if (error) return renderError();
    if (loading && fileType !== 'image' && fileType !== 'pdf' && fileType !== 'office') return renderLoading();
    switch (fileType) {
      case 'image': return renderImage();
      case 'video': return renderVideo();
      case 'pdf': return renderPDF();
      case 'office': return renderOffice();
      case 'text': return renderText();
      case 'audio': return renderAudio();
      default: return renderUnknown();
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
      <Animated.View style={[s.header, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
        {fileType === 'image' && (
          <LinearGradient
            colors={['rgba(0,0,0,0.7)', 'transparent']}
            style={StyleSheet.absoluteFillObject}
          />
        )}
        <View style={s.headerInner}>
          {/* Back button */}
          <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Go back" style={s.headerBtn}>
            <Ionicons name="arrow-back" size={20} color={C.text} />
          </TouchableOpacity>

          {/* File info */}
          <View style={s.headerCenter}>
            <View style={s.headerFilenameRow}>
              <Text style={s.headerIcon}>{fmt.icon}</Text>
              <Text style={s.headerFilename} numberOfLines={1}>{fileName}</Text>
            </View>
            {fileSize > 0 && (
              <Text style={s.headerSize}>{formatBytes(fileSize)} · {fmt.label.toUpperCase()}</Text>
            )}
          </View>

          {/* Action buttons */}
          <TouchableOpacity onPress={handleShare} accessibilityLabel="Share this file" style={s.headerBtn}>
            <Ionicons name="share-outline" size={20} color={C.text} />
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* ── Content area ───────────────────────────────────────── */}
      <Animated.View style={[s.content, { opacity: fadeIn }]}>
        {renderContent()}
      </Animated.View>

      {/* ── Bottom bar ─────────────────────────────────────────── */}
      {fileType !== 'video' && (
        <Animated.View style={[s.bottomBar, { opacity: fadeIn, transform: [{ translateY: Animated.multiply(slideUp, -1) }] }]}>
          <TouchableOpacity onPress={handleShare} style={s.bottomBtn}>
            <LinearGradient
              colors={[C.primary, C.secondary]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={s.bottomBtnGradient}
            >
              <Text style={s.bottomBtnText}>Open With...</Text>
            </LinearGradient>
          </TouchableOpacity>
        </Animated.View>
      )}
    </View>
  );
}

// ══════════════════════════════════════════════════════════════════
// ██  STYLES
// ══════════════════════════════════════════════════════════════════
const s = StyleSheet.create({
  root: { flex: 1 },
  contentFill: { flex: 1, width: '100%', height: '100%' },
  centered: { alignItems: 'center', justifyContent: 'center' },

  // ── Header ──────────────────────────────────────────────────
  header: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
    paddingTop: Platform.OS === 'ios' ? 54 : 38,
    paddingBottom: 12, paddingHorizontal: 8,
    overflow: 'hidden',
  },
  headerInner: {
    flexDirection: 'row', alignItems: 'center',
  },
  headerBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerBtnIcon: { color: C.text, fontSize: 20, fontWeight: '600' },
  headerCenter: { flex: 1, marginHorizontal: 10 },
  headerFilenameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerIcon: { fontSize: 16 },
  headerFilename: { color: C.text, fontSize: 15, fontWeight: '600', flex: 1 },
  headerSize: { color: C.textDim, fontSize: 12, marginTop: 2, marginLeft: 22 },

  // ── Content ─────────────────────────────────────────────────
  content: {
    flex: 1, paddingTop: Platform.OS === 'ios' ? 100 : 84,
    paddingBottom: 80,
  },

  // ── Image overlay ───────────────────────────────────────────
  imageOverlay: {
    position: 'absolute', bottom: 24, left: 0, right: 0,
    alignItems: 'center',
  },
  glassChip: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(2,11,24,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
  },
  glassChipText: { color: C.text, fontSize: 13, fontWeight: '500' },

  // ── Loading ─────────────────────────────────────────────────
  loadingText: { color: C.textDim, fontSize: 14 },
  // Document (pdf/office) hand-off card — see renderDocument.
  fileIcon: { fontSize: 64, marginBottom: 12 },
  openBtn: {
    marginTop: 22, minWidth: 160, paddingVertical: 14, paddingHorizontal: 28,
    borderRadius: 14, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center',
  },
  openBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },

  // ── Document action bar: read here, or hand off — both always available ──
  docActionBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.glassBorder,
    backgroundColor: C.glass,
  },
  docActionHint: { color: C.textDim, fontSize: 12, flexShrink: 1 },
  docActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12,
    borderWidth: 1, borderColor: C.border,
  },
  docActionTxt: { color: C.primary, fontSize: 13, fontWeight: '700' },

  // ── Code / Text viewer ──────────────────────────────────────
  codeContainer: { padding: 16, paddingBottom: 40 },
  codeHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: C.border,
  },
  codeLangBadge: {
    backgroundColor: 'rgba(74,159,255,0.12)',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6,
  },
  codeLangText: { color: C.primary, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  codeLineCount: { color: C.textDim, fontSize: 12 },
  codeLine: { flexDirection: 'row', minHeight: 22 },
  lineNumber: {
    width: 40, textAlign: 'right', marginRight: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12, color: C.textFaint, lineHeight: 22,
  },
  lineText: {
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13, color: SYNTAX_COLORS.default, lineHeight: 22,
  },

  // ── Audio player ────────────────────────────────────────────
  audioArtCircle: {
    width: 160, height: 160, borderRadius: 80, overflow: 'hidden',
    marginBottom: 28,
  },
  audioGradient: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
  },
  audioIcon: { fontSize: 56 },
  audioTitle: { color: C.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  audioMeta: { color: C.textDim, fontSize: 13, marginTop: 6 },
  waveContainer: {
    // layout-exempt: draws fixed-width bars, no text — height is the drawing.
    flexDirection: 'row', alignItems: 'flex-end',
    height: 56, gap: 2, justifyContent: 'center',
  },
  waveBar: { width: 3, borderRadius: 1.5 },
  seekTouchArea: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  },
  audioTimeRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    width: '100%', marginTop: 8,
  },
  audioTime: { color: C.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
  audioControls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginTop: 28, gap: 28,
  },
  audioBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  audioBtnText: { color: C.textDim, fontSize: 14 },
  audioPlayBtn: { width: 68, height: 68, borderRadius: 34, overflow: 'hidden' },
  audioPlayGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  audioPlayIcon: { color: C.text, fontSize: 26 },

  // ── Error state ─────────────────────────────────────────────
  errorCircle: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(239,68,68,0.12)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 16,
  },
  errorTitle: { color: C.text, fontSize: 18, fontWeight: '700' },
  errorDesc: { color: C.textDim, fontSize: 14, marginTop: 6, textAlign: 'center', paddingHorizontal: 32 },
  retryBtn: { marginTop: 24, borderRadius: 12, overflow: 'hidden' },
  retryGradient: { paddingHorizontal: 32, paddingVertical: 12, borderRadius: 12 },
  retryText: { color: C.text, fontSize: 15, fontWeight: '600' },

  // ── Bottom bar ──────────────────────────────────────────────
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    backgroundColor: 'rgba(2,11,24,0.92)',
    borderTopWidth: 1, borderTopColor: C.glassBorder,
  },
  bottomBtn: { borderRadius: 14, overflow: 'hidden' },
  bottomBtnGradient: {
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center',
    borderRadius: 14,
  },
  bottomBtnText: { color: C.text, fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
});

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
