// app/camera.tsx — the ONE camera surface: SCAN · PHOTO · VIDEO.
//
// Mode is in-screen state, never a route and never three files. Switching mode
// does not remount the preview and does not re-ask for a permission — the
// CameraView stays mounted; only the capture behaviour and the shutter change.
//
//   PHOTO — default. Tap the shutter for a still. (Hold still records, the
//           WhatsApp gesture the composer taught users; the mic is requested
//           at that press, not before.)
//   VIDEO — tap to start, tap to stop. The elapsed timer replaces the tabs.
//           This is the ONLY mode that asks for the microphone, and it asks on
//           the first switch to it — never when the screen opens.
//   SCAN  — ML Kit does the edge detection and the perspective-correct crop
//           (see lib/docs/pdf.ts for why we don't reimplement either); pages
//           append, and the set is assembled into one PDF for the chat.
//
// Entry is the chat attachment sheet. Exit always addresses that chat BY ID —
// a chat reached from a notification deep link has no stack underneath it, so
// popping would land the user on the chats list instead of the conversation.
//
// The chrome is deliberately the dark palette in BOTH themes: a camera is a
// black surface, and inverting it in light mode would wash out the preview.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Animated, AppState, Image,
  KeyboardAvoidingView, Platform, Pressable, StatusBar, StyleSheet, TextInput, View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import * as ImagePicker from 'expo-image-picker';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/ui/Text';
import { AuroraDark, BRAND_ACCENT, MOTION, RADIUS, SPACING, TYPOGRAPHY, brandAlpha } from '../constants/theme';
import {
  type CameraMode, type Flash, captureModes, fileUri, needsMic, nextFlash,
  previewMode, returnParams,
} from '../lib/camera/cameraMode';
import {
  DEFAULT_STYLE, DOC_STYLES, type DocStyleId, defaultDocName, docFilename,
} from '../lib/docs/docStyle';
import { pagesToPdf } from '../lib/docs/pdf';

const MAX_VIDEO_SECONDS = 60;
const MAX_SCAN_PAGES = 15;

// Chrome that sits over a live preview: translucent black, not a palette
// surface — the app's surface tokens are tuned for a solid background.
const SCRIM = 'rgba(0,0,0,0.40)';
const SCRIM_STRONG = 'rgba(0,0,0,0.62)';

export default function CameraScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { chatId, peerUid, peerName, returnTo, startMode } = useLocalSearchParams<{
    chatId?: string; peerUid?: string; peerName?: string; returnTo?: string; startMode?: string;
  }>();
  // The composer's slide-up gesture opens straight into a round video note.
  const noteStart = startMode === 'note';

  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();

  const [mode, setMode] = useState<CameraMode>(
    noteStart ? 'VIDEO' : startMode === 'scan' ? 'SCAN' : 'PHOTO',
  );
  const [facing, setFacing] = useState<'front' | 'back'>(noteStart ? 'front' : 'back');
  const [flash, setFlash] = useState<Flash>('off');
  const [viewOnce, setViewOnce] = useState(false);
  const [isNote, setIsNote] = useState(noteStart);
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [lastAsset, setLastAsset] = useState<string | null>(null);
  const [scanPages, setScanPages] = useState<string[]>([]);
  // Review sheet: pick the paper the scan is printed onto, then name the file.
  const [reviewing, setReviewing] = useState(false);
  const [style, setStyle] = useState<DocStyleId>(DEFAULT_STYLE);
  const [docName, setDocName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Params are EMPTY on the first render of a cold deep link, so the useState
  // initialisers above miss startMode entirely. Apply it once, when it actually
  // arrives — and only once, so a later tab tap is never overridden.
  const startApplied = useRef(false);
  useEffect(() => {
    if (startApplied.current || !startMode) return;
    startApplied.current = true;
    if (startMode === 'scan') setMode('SCAN');
    else if (startMode === 'note') { setMode('VIDEO'); setIsNote(true); setFacing('front'); }
  }, [startMode]);

  const cameraRef = useRef<CameraView>(null);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdRef = useRef(false);   // recording was started by press-and-hold
  const scanningRef = useRef(false);  // ML Kit's activity is up; don't launch a second

  // ── Reduce motion ────────────────────────────────────────────────────
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (alive) setReduceMotion(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { alive = false; sub?.remove?.(); };
  }, []);
  const dur = reduceMotion ? 0 : MOTION.base;

  // Returning to the foreground means ML Kit's activity is gone, whether or not
  // it ever resolved — so the scan guard lifts here and SCAN can never wedge.
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') scanningRef.current = false;
    });
    return () => sub.remove();
  }, []);

  // Inline notices replace the system Alert this screen used to throw.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // ── Gallery thumbnail ────────────────────────────────────────────────
  // Read-only, and ONLY if the library permission was already granted. Asking
  // on open would put a storage prompt in front of someone who just wants to
  // take one photo; the ask happens when they tap the thumbnail.
  useEffect(() => {
    (async () => {
      try {
        const p = await MediaLibrary.getPermissionsAsync();
        if (!p.granted) return;
        const a = await MediaLibrary.getAssetsAsync({
          first: 1, sortBy: [['creationTime', false]], mediaType: ['photo', 'video'],
        });
        setLastAsset(a.assets[0]?.uri ?? null);
      } catch {}
    })();
    return () => { if (recTimer.current) clearInterval(recTimer.current); };
  }, []);

  // ── Leaving: always by chat id, never by popping the stack ────────────
  const leave = useCallback((capture?: Parameters<typeof returnParams>[1]) => {
    if (!chatId) { router.back(); return; }   // opened outside a chat — nothing to address
    // dismissTo = POP_TO: pops back to the chat already in the stack (no second
    // copy of it), and pushes it if the stack is shallow — which is exactly the
    // notification-deep-link case where a plain back() would land on the list.
    router.dismissTo({
      pathname: (returnTo || '/chat') as any,
      params: returnParams({ chatId, peerUid, peerName }, capture),
    });
  }, [router, returnTo, chatId, peerUid, peerName]);

  // ── Permissions, asked at the moment they are earned ──────────────────
  const ensureMic = useCallback(async () => {
    if (micPerm?.granted) return true;
    const r = await requestMic();
    if (!r.granted) setNotice('Microphone access is needed to record video.');
    return r.granted;
  }, [micPerm, requestMic]);

  const selectMode = useCallback(async (m: CameraMode) => {
    if (recording || m === mode) return;
    setMode(m);
    if (m !== 'VIDEO') setIsNote(false);
    if (needsMic(m)) ensureMic();
  }, [recording, mode, ensureMic]);

  // ── Capture ───────────────────────────────────────────────────────────
  const takePhoto = useCallback(async () => {
    if (busy || recording || !cameraRef.current) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85 });
      if (photo?.uri) leave({ uri: photo.uri, type: 'image', viewOnce });
    } catch { setNotice('Could not take the photo. Try again.'); }
    finally { setBusy(false); }
  }, [busy, recording, leave, viewOnce]);

  const startRecording = useCallback(async () => {
    if (recording || busy || !cameraRef.current) return;
    if (!(await ensureMic())) { holdRef.current = false; return; }
    // Hold-to-record from PHOTO: flip the preview to video, then back after.
    const revert = mode !== 'VIDEO';
    if (revert) { setMode('VIDEO'); await new Promise(r => setTimeout(r, 250)); }
    setRecording(true);
    setRecSecs(0);
    recTimer.current = setInterval(() => setRecSecs(s => s + 1), 1000);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
      if (video?.uri) leave({ uri: video.uri, type: isNote ? 'video-note' : 'video', viewOnce });
    } catch { /* cancelled */ }
    finally {
      setRecording(false);
      if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
      setRecSecs(0);
      if (revert) setMode('PHOTO');
    }
  }, [recording, busy, ensureMic, mode, isNote, leave, viewOnce]);

  const stopRecording = useCallback(() => {
    try { cameraRef.current?.stopRecording(); } catch {}
  }, []);

  // SCAN — ML Kit owns the capture UI, so the shutter hands off to it and the
  // cropped pages come back here to be appended.
  const scanPage = useCallback(async () => {
    if (busy || scanningRef.current) return;
    scanningRef.current = true;
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        maxNumDocuments: MAX_SCAN_PAGES, croppedImageQuality: 90,
      });
      if (scannedImages?.length) {
        setScanPages(prev => [...prev, ...scannedImages.map(fileUri)].slice(0, MAX_SCAN_PAGES));
      }
    } catch (e: any) {
      setNotice(e?.message ?? 'The document scanner needs Google Play Services.');
    } finally { scanningRef.current = false; }
  }, [busy]);

  const openReview = useCallback(() => {
    if (busy || !scanPages.length) return;
    // Prefill the name from the style, so a hurried send is still labelled.
    setDocName(defaultDocName(style, new Date()));
    setReviewing(true);
  }, [busy, scanPages, style]);

  // Changing the style re-prefills the name, but ONLY while the user has not
  // written their own — retyping it after every chip tap would be maddening.
  const chooseStyle = useCallback((next: DocStyleId) => {
    setDocName(prev => (prev === defaultDocName(style, new Date()) ? defaultDocName(next, new Date()) : prev));
    setStyle(next);
  }, [style]);

  const attachScan = useCallback(async () => {
    if (busy || !scanPages.length) return;
    setBusy(true);
    try {
      const uri = await pagesToPdf(scanPages, style);
      leave({ uri, type: 'file', filename: docFilename(docName, style, new Date()) });
    } catch (e: any) {
      setNotice(e?.message ?? 'Could not build the PDF.');
    } finally { setBusy(false); }
  }, [busy, scanPages, style, docName, leave]);

  const openPicker = useCallback(async () => {
    if (busy || recording) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setNotice('Allow photo access to pick from your gallery.'); return; }
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 1 });
    const a = r.assets?.[0];
    if (r.canceled || !a) return;
    leave({ uri: a.uri, type: a.type === 'video' ? 'video' : 'image', viewOnce });
  }, [busy, recording, leave, viewOnce]);

  const onShutter = useCallback(() => {
    if (mode === 'SCAN') return scanPage();
    if (mode === 'VIDEO') return recording ? stopRecording() : startRecording();
    if (!recording) takePhoto();
  }, [mode, recording, scanPage, stopRecording, startRecording, takePhoto]);

  // ── Motion ────────────────────────────────────────────────────────────
  const shutterScale = useRef(new Animated.Value(1)).current;
  const pressShutter = (down: boolean) => {
    if (reduceMotion) return;
    Animated.spring(shutterScale, {
      toValue: down ? 0.97 : 1, useNativeDriver: true, ...MOTION.springSnappy,
    }).start();
  };

  const [tabsWidth, setTabsWidth] = useState(0);
  const indicator = useRef(new Animated.Value(captureModes.indexOf(mode))).current;
  useEffect(() => {
    Animated.timing(indicator, {
      toValue: captureModes.indexOf(mode), duration: dur, useNativeDriver: true,
    }).start();
  }, [mode, dur, indicator]);
  const slot = tabsWidth / captureModes.length;

  // ── Permission gate — inline, brand components, never a system dialog ──
  if (!camPerm) return <View style={s.root} />;
  if (!camPerm.granted) {
    return (
      <View style={[s.root, s.gate]}>
        <View style={s.gateIcon}>
          <Ionicons name="camera-outline" size={34} color={BRAND_ACCENT} />
        </View>
        <Text variant="h2" color={AuroraDark.text} style={s.center}>Camera access</Text>
        <Text variant="callout" color={AuroraDark.textDim} style={[s.center, s.gateBody]}>
          VaultChat needs the camera to take photos, record video and scan documents.
          Nothing leaves your device until you send it.
        </Text>
        <Pressable onPress={requestCam} style={s.gateBtn} accessibilityRole="button">
          <Text variant="bodyStrong" color={BRAND_ACCENT}>Allow camera</Text>
        </Pressable>
        <Pressable onPress={() => leave()} style={s.gateSkip} accessibilityRole="button">
          <Text variant="callout" color={AuroraDark.textDim}>Not now</Text>
        </Pressable>
      </View>
    );
  }

  const mm = String(Math.floor(recSecs / 60)).padStart(2, '0');
  const ss = String(recSecs % 60).padStart(2, '0');
  const flashIcon = flash === 'on' ? 'flash' : flash === 'auto' ? 'flash-outline' : 'flash-off';
  const thumb = mode === 'SCAN' && scanPages.length ? scanPages[scanPages.length - 1] : lastAsset;
  const scanReady = mode === 'SCAN' && scanPages.length > 0;

  return (
    <View style={s.root}>
      <StatusBar hidden />

      {/* One preview, mounted once, for all three modes. */}
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        enableTorch={mode === 'VIDEO' && flash === 'on'}
        mode={previewMode(mode)}
        videoQuality="1080p"
      />

      {/* Round framing for the composer's video note. */}
      {isNote && <View pointerEvents="none" style={s.noteFrame} />}

      {/* Top rail — over the preview, no bar background. */}
      <View style={[s.rail, { top: Math.max(insets.top, SPACING.md) }]}>
        <Pressable onPress={() => leave()} style={s.railBtn} hitSlop={8}
          accessibilityRole="button" accessibilityLabel="Close camera">
          <Ionicons name="close" size={26} color={AuroraDark.text} />
        </Pressable>
        <Pressable onPress={() => setFlash(nextFlash)} style={s.railBtn} hitSlop={8}
          accessibilityRole="button" accessibilityLabel={`Flash ${flash}`}>
          <Ionicons name={flashIcon} size={22} color={flash === 'off' ? AuroraDark.text : BRAND_ACCENT} />
          {flash === 'auto' && (
            <Text variant="tiny" color={BRAND_ACCENT} style={s.flashTag}>A</Text>
          )}
        </Pressable>
        <Pressable onPress={() => setFacing(f => (f === 'back' ? 'front' : 'back'))}
          style={s.railBtn} hitSlop={8} disabled={recording}
          accessibilityRole="button" accessibilityLabel="Flip camera">
          <Ionicons name="camera-reverse-outline" size={24}
            color={recording ? AuroraDark.textFaint : AuroraDark.text} />
        </Pressable>
      </View>

      {notice && (
        <View style={[s.notice, { bottom: FOOTER_H + insets.bottom + SPACING.md }]}>
          <Ionicons name="alert-circle-outline" size={16} color={AuroraDark.text} />
          <Text variant="callout" color={AuroraDark.text} style={s.flex}>{notice}</Text>
        </View>
      )}

      {/* Bottom — opaque black footer. */}
      <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, SPACING.md) }]}>
        {recording ? (
          <View style={s.timerRow}>
            <View style={s.recDot} />
            <Text variant="bodyStrong" color={AuroraDark.text}>{mm}:{ss}</Text>
          </View>
        ) : (
          <View style={s.tabs} onLayout={e => setTabsWidth(e.nativeEvent.layout.width)}>
            {tabsWidth > 0 && (
              <Animated.View
                pointerEvents="none"
                style={[s.tabPill, {
                  width: slot,
                  transform: [{
                    translateX: indicator.interpolate({
                      inputRange: [0, captureModes.length - 1],
                      outputRange: [0, slot * (captureModes.length - 1)],
                    }),
                  }],
                }]}
              />
            )}
            {captureModes.map(m => (
              <Pressable key={m} onPress={() => selectMode(m)} style={s.tab}
                accessibilityRole="tab" accessibilityState={{ selected: m === mode }}>
                {/* Capped, like the tab bar's labels and for the same reason:
                    s.tabs is a fixed 260×32 pill that physically cannot grow,
                    so at a large system font scale these mode labels clip
                    instead of reflowing. Capping is only ever right for chrome
                    with a hard height — everywhere the container CAN grow, the
                    container grows and the user keeps their font size. */}
                <Text
                  variant="callout"
                  color={m === mode ? BRAND_ACCENT : AuroraDark.textDim}
                  maxFontSizeMultiplier={1.2}
                  numberOfLines={1}
                >
                  {m}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={s.shutterRow}>
          {/* left — last gallery item, or the scanned page count */}
          <Pressable onPress={openPicker} style={s.thumbSlot} hitSlop={6}
            accessibilityRole="button" accessibilityLabel="Open gallery">
            {thumb
              ? <Image source={{ uri: thumb }} style={s.thumb} />
              : <View style={[s.thumb, s.thumbEmpty]}>
                  <Ionicons name="images-outline" size={20} color={AuroraDark.textDim} />
                </View>}
            {mode === 'SCAN' && scanPages.length > 0 && (
              <View style={s.pageBadge}>
                <Text variant="tiny" color={AuroraDark.text}>{scanPages.length}</Text>
              </View>
            )}
          </Pressable>

          {/* centre — shutter */}
          <Pressable
            onPress={onShutter}
            onPressIn={() => pressShutter(true)}
            onPressOut={() => {
              pressShutter(false);
              if (holdRef.current && recording) { holdRef.current = false; stopRecording(); }
            }}
            onLongPress={() => {
              if (mode !== 'SCAN' && !recording) { holdRef.current = true; startRecording(); }
            }}
            delayLongPress={350}
            accessibilityRole="button"
            accessibilityLabel={mode === 'SCAN' ? 'Scan a page' : mode === 'VIDEO' ? (recording ? 'Stop recording' : 'Record') : 'Take photo'}
          >
            <Animated.View style={[s.shutterRing, recording && s.shutterRingRec,
              { transform: [{ scale: shutterScale }] }]}>
              {busy
                ? <ActivityIndicator color={AuroraDark.text} />
                : <View style={[
                    s.shutterCore,
                    recording && s.shutterCoreRec,
                    mode === 'SCAN' && s.shutterCoreScan,
                  ]}>
                    {mode === 'SCAN' && <Ionicons name="scan-outline" size={26} color={AuroraDark.bg} />}
                  </View>}
            </Animated.View>
          </Pressable>

          {/* right — view-once, or "done" once pages are stacked up in SCAN */}
          {scanReady ? (
            <Pressable onPress={openReview} style={[s.rightSlot, s.doneOn]} hitSlop={6}
              accessibilityRole="button" accessibilityLabel={`Review ${scanPages.length} scanned page${scanPages.length > 1 ? 's' : ''}`}>
              <Ionicons name="checkmark" size={26} color={AuroraDark.text} />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => setViewOnce(v => !v)}
              style={[s.rightSlot, viewOnce && s.viewOnceOn]}
              hitSlop={6}
              disabled={mode === 'SCAN'}
              accessibilityRole="switch"
              accessibilityState={{ checked: viewOnce, disabled: mode === 'SCAN' }}
              accessibilityLabel="View once"
            >
              <Ionicons
                name={viewOnce ? 'flame' : 'flame-outline'}
                size={24}
                color={mode === 'SCAN' ? AuroraDark.textFaint : viewOnce ? AuroraDark.text : AuroraDark.textDim}
              />
            </Pressable>
          )}
        </View>

        <Text variant="tiny" color={AuroraDark.textFaint} style={s.center}>
          {mode === 'SCAN'
            ? (scanPages.length ? `${scanPages.length} page${scanPages.length > 1 ? 's' : ''} — tap ✓ to attach as PDF` : 'Tap to scan a page')
            : mode === 'VIDEO'
              ? (recording ? 'Tap to stop' : isNote ? 'Tap to record a video note' : 'Tap to record')
              : 'Tap for a photo, hold to record'}
        </Text>
      </View>

      {reviewing && (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={s.sheetWrap}
        >
          <Pressable style={s.sheetScrim} onPress={() => setReviewing(false)}
            accessibilityRole="button" accessibilityLabel="Back to scanning" />
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, SPACING.lg) }]}>
            <View style={s.sheetHead}>
              <Text variant="h3" color={AuroraDark.text}>
                {scanPages.length} page{scanPages.length > 1 ? 's' : ''} scanned
              </Text>
              <Pressable onPress={() => setReviewing(false)} hitSlop={8} style={s.railBtn}
                accessibilityRole="button" accessibilityLabel="Add another page">
                <Ionicons name="add" size={22} color={AuroraDark.text} />
              </Pressable>
            </View>

            <Text variant="tiny" color={AuroraDark.textDim}>STYLE</Text>
            <View style={s.chips}>
              {DOC_STYLES.map(st => {
                const on = st.id === style;
                return (
                  <Pressable key={st.id} onPress={() => chooseStyle(st.id)}
                    style={[s.chip, on && s.chipOn]}
                    accessibilityRole="radio" accessibilityState={{ selected: on }}
                    accessibilityLabel={`${st.label} style`}>
                    <Ionicons name={st.icon as any} size={16}
                      color={on ? BRAND_ACCENT : AuroraDark.textDim} />
                    <Text variant="callout" color={on ? AuroraDark.text : AuroraDark.textDim}>
                      {st.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <Text variant="tiny" color={AuroraDark.textDim}>DOCUMENT NAME</Text>
            <TextInput
              value={docName}
              onChangeText={setDocName}
              placeholder={defaultDocName(style, new Date())}
              placeholderTextColor={AuroraDark.textFaint}
              style={s.nameInput}
              returnKeyType="done"
              accessibilityLabel="Document name"
            />

            <Pressable onPress={attachScan} disabled={busy}
              style={[s.attachBtn, busy && s.attachBusy]}
              accessibilityRole="button" accessibilityLabel="Attach the document">
              {busy
                ? <ActivityIndicator color={AuroraDark.text} />
                : <Text variant="bodyStrong" color={AuroraDark.text}>Attach</Text>}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const FOOTER_H = 176;
const SHUTTER = 76;

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: AuroraDark.bg },
  flex: { flex: 1 },
  center: { textAlign: 'center' },

  noteFrame: {
    position: 'absolute', top: '22%', alignSelf: 'center', width: 280, height: 280,
    borderRadius: 140, borderWidth: 3, borderColor: AuroraDark.text, opacity: 0.85,
  },

  rail: {
    position: 'absolute', left: 0, right: 0, paddingHorizontal: SPACING.lg,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  railBtn: {
    width: 44, height: 44, borderRadius: RADIUS.pill, backgroundColor: SCRIM,
    alignItems: 'center', justifyContent: 'center',
  },
  flashTag: { position: 'absolute', bottom: 4, right: 9 },

  notice: {
    position: 'absolute', left: SPACING.lg, right: SPACING.lg, flexDirection: 'row',
    alignItems: 'center', gap: SPACING.sm, backgroundColor: SCRIM_STRONG,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm, borderRadius: RADIUS.lg,
  },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: AuroraDark.bg,
    paddingTop: SPACING.md, gap: SPACING.md,
  },
  tabs: {
    // layout-exempt: a sliding indicator animates across this pill by
    // interpolating a fixed slot width, so the pill must be a known size — it
    // cannot grow with the font. The labels inside are capped and single-line
    // instead (see the mode Pressable), which is the right trade for chrome
    // with a hard height, and the same one the tab bar makes.
    flexDirection: 'row', alignSelf: 'center', width: 260, height: 32,
  },
  tabPill: {
    position: 'absolute', top: 0, bottom: 0, borderRadius: RADIUS.pill,
    backgroundColor: brandAlpha(0.16),
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  timerRow: {
    flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: SPACING.sm, height: 32,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: AuroraDark.danger },

  shutterRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACING.xxl,
  },
  thumbSlot: { width: 48, height: 48 },
  thumb: { width: 48, height: 48, borderRadius: RADIUS.md, backgroundColor: AuroraDark.surfaceSolid },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: AuroraDark.border },
  pageBadge: {
    position: 'absolute', top: -4, right: -4, minWidth: 20, height: 20, paddingHorizontal: 5,
    borderRadius: RADIUS.pill, backgroundColor: BRAND_ACCENT, alignItems: 'center', justifyContent: 'center',
  },

  shutterRing: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: 4,
    borderColor: AuroraDark.text, alignItems: 'center', justifyContent: 'center',
  },
  shutterRingRec: { borderColor: AuroraDark.danger },
  shutterCore: {
    width: SHUTTER - 14, height: SHUTTER - 14, borderRadius: (SHUTTER - 14) / 2,
    backgroundColor: AuroraDark.text, alignItems: 'center', justifyContent: 'center',
  },
  shutterCoreRec: { width: 30, height: 30, borderRadius: RADIUS.xs, backgroundColor: AuroraDark.danger },
  shutterCoreScan: { backgroundColor: BRAND_ACCENT },

  rightSlot: {
    width: 48, height: 48, borderRadius: RADIUS.pill, backgroundColor: SCRIM,
    alignItems: 'center', justifyContent: 'center',
  },
  viewOnceOn: { backgroundColor: BRAND_ACCENT },
  doneOn: { backgroundColor: BRAND_ACCENT },

  sheetWrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end' },
  sheetScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: SCRIM_STRONG },
  sheet: {
    backgroundColor: AuroraDark.card, borderTopLeftRadius: RADIUS.xxl,
    borderTopRightRadius: RADIUS.xxl, padding: SPACING.lg, gap: SPACING.sm,
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.xs,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill, borderWidth: 1, borderColor: AuroraDark.border,
  },
  chipOn: { backgroundColor: brandAlpha(0.20), borderColor: BRAND_ACCENT },
  nameInput: {
    backgroundColor: AuroraDark.surfaceSolid, borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.md, paddingVertical: SPACING.md,
    color: AuroraDark.text, fontSize: TYPOGRAPHY.body.fontSize,
  },
  attachBtn: {
    marginTop: SPACING.md, height: 52, borderRadius: RADIUS.lg,
    backgroundColor: BRAND_ACCENT, alignItems: 'center', justifyContent: 'center',
  },
  attachBusy: { opacity: 0.7 },

  gate: { alignItems: 'center', justifyContent: 'center', padding: SPACING.xl, gap: SPACING.md },
  gateIcon: {
    width: 72, height: 72, borderRadius: RADIUS.pill, backgroundColor: brandAlpha(0.12),
    alignItems: 'center', justifyContent: 'center', marginBottom: SPACING.sm,
  },
  gateBody: { maxWidth: 300 },
  gateBtn: {
    marginTop: SPACING.sm, paddingHorizontal: SPACING.xl, paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: BRAND_ACCENT, backgroundColor: brandAlpha(0.12),
  },
  gateSkip: { padding: SPACING.sm },
});
