// app/camera.tsx — In-app camera (WhatsApp-style).
//
// Tap the shutter = photo. Hold the shutter = record video (release to stop).
// A Photo/Video toggle, a recent-gallery strip, flip, flash and a view-once
// toggle. Captured media is handed back to the chat via router params.

import { brandAlpha } from '../constants/theme';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, Pressable, StyleSheet, Alert, StatusBar,
  Image, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';

const MAX_VIDEO_SECONDS = 60;

export default function CameraScreen() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { chatId, peerUid, peerName, returnTo, startMode } = useLocalSearchParams();
  const noteStart = startMode === 'note'; // opened via composer slide-up → video note

  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<'front' | 'back'>(noteStart ? 'front' : 'back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [viewOnce, setViewOnce] = useState(false);
  const [mode, setMode] = useState<'picture' | 'video'>(noteStart ? 'video' : 'picture');
  const [isNote, setIsNote] = useState(noteStart); // video-note (round, WhatsApp-style) when in video mode
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<MediaLibrary.Asset[]>([]);

  const cameraRef = useRef<CameraView>(null);
  const recTimer = useRef<any>(null);
  const holdRef = useRef(false);       // recording started by a press-and-hold
  const revertRef = useRef(false);     // should revert to 'picture' after recording

  // Recent gallery thumbnails (best-effort; needs read permission).
  useEffect(() => {
    (async () => {
      try {
        const p = await MediaLibrary.requestPermissionsAsync();
        if (!p.granted) return;
        const a = await MediaLibrary.getAssetsAsync({ first: 30, sortBy: [['creationTime', false]], mediaType: ['photo', 'video'] });
        setRecent(a.assets);
      } catch {}
    })();
    return () => { if (recTimer.current) clearInterval(recTimer.current); };
  }, []);

  const returnMedia = useCallback((uri: string, type: 'image' | 'video' | 'video-note') => {
    router.replace({
      pathname: (returnTo || '/chat') as any,
      params: { chatId, peerUid, peerName, capturedUri: uri, capturedType: type, capturedViewOnce: viewOnce ? '1' : '0' },
    });
  }, [router, returnTo, chatId, peerUid, peerName, viewOnce]);

  const takePhoto = useCallback(async () => {
    if (busy || recording || !cameraRef.current) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.85 });
      if (photo?.uri) returnMedia(photo.uri, 'image');
    } catch { Alert.alert('Camera', 'Could not take the photo.'); }
    finally { setBusy(false); }
  }, [busy, recording, returnMedia]);

  const startTimer = () => {
    setRecSecs(0);
    recTimer.current = setInterval(() => setRecSecs(s2 => s2 + 1), 1000);
  };
  const clearTimer = () => { if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; } setRecSecs(0); };

  const startRecording = useCallback(async () => {
    if (recording || busy || !cameraRef.current) return;
    if (!micPerm?.granted) {
      const r = await requestMic();
      if (!r.granted) { Alert.alert('Microphone needed', 'Allow microphone access to record video.'); holdRef.current = false; return; }
    }
    // Recording needs video mode. If we're in picture mode (hold-to-record),
    // switch and revert afterwards.
    if (mode !== 'video') { revertRef.current = true; setMode('video'); await new Promise(r => setTimeout(r, 250)); }
    setRecording(true); startTimer();
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
      if (video?.uri) returnMedia(video.uri, isNote ? 'video-note' : 'video');
    } catch { /* cancelled / failed */ }
    finally {
      setRecording(false); clearTimer();
      if (revertRef.current) { revertRef.current = false; setMode('picture'); }
    }
  }, [recording, busy, micPerm, requestMic, mode, isNote, returnMedia]);

  const stopRecording = useCallback(() => { try { cameraRef.current?.stopRecording(); } catch {} }, []);

  // Shutter gestures — tap = photo (picture mode) / start-stop (video mode);
  // hold = record while pressed.
  const onShutterPress = () => {
    if (mode === 'video') { recording ? stopRecording() : startRecording(); }
    else if (!recording) takePhoto();
  };
  const onShutterLongPress = () => { if (!recording) { holdRef.current = true; startRecording(); } };
  const onShutterPressOut = () => { if (holdRef.current && recording) { holdRef.current = false; stopRecording(); } };

  if (!camPerm) return <View style={s.container} />;
  if (!camPerm.granted) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <Ionicons name="camera-outline" size={48} color={colors.textDim} />
        <Text style={{ color: colors.text, fontSize: 16, marginVertical: 16, textAlign: 'center' }}>Camera permission needed</Text>
        <TouchableOpacity onPress={requestCam} style={s.permBtn}><Text style={{ color: colors.primary, fontWeight: '800' }}>Grant access</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}><Text style={{ color: colors.textDim }}>Go back</Text></TouchableOpacity>
      </View>
    );
  }

  const mm = String(Math.floor(recSecs / 60)).padStart(2, '0');
  const ss = String(recSecs % 60).padStart(2, '0');

  return (
    <View style={s.container}>
      <StatusBar hidden />
      <CameraView ref={cameraRef} style={s.camera} facing={facing} flash={flash} mode={mode} videoQuality="1080p" />

      {/* Video-note framing — round, like WhatsApp's instant video */}
      {isNote && <View pointerEvents="none" style={s.noteFrame} />}

      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.topBtn}><Ionicons name="close" size={26} color="#fff" /></TouchableOpacity>
        {recording && (
          <View style={s.recPill}><View style={s.recDot} /><Text style={s.recTxt}>{mm}:{ss}</Text></View>
        )}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity onPress={() => setViewOnce(v => !v)} style={[s.topBtn, viewOnce && { backgroundColor: colors.primary }]}>
            <View style={s.voRing}><Text style={s.voOne}>1</Text></View>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setFlash(f => f === 'off' ? 'on' : 'off')} style={s.topBtn}>
            <Ionicons name={flash === 'on' ? 'flash' : 'flash-off'} size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Recent gallery strip */}
      {!recording && recent.length > 0 && (
        <View style={s.galleryWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 10 }}>
            {recent.map(a => (
              <TouchableOpacity key={a.id} onPress={() => returnMedia(a.uri, a.mediaType === 'video' ? 'video' : 'image')} activeOpacity={0.8}>
                <Image source={{ uri: a.uri }} style={s.galleryThumb} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Mode toggle — Note (round video) · Video · Photo */}
      {!recording && (
        <View style={s.modeRow}>
          <TouchableOpacity onPress={() => { setMode('video'); setIsNote(true); setFacing('front'); }}>
            <Text style={[s.modeTxt, mode === 'video' && isNote && s.modeOn]}>Note</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setMode('video'); setIsNote(false); }}>
            <Text style={[s.modeTxt, mode === 'video' && !isNote && s.modeOn]}>Video</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { setMode('picture'); setIsNote(false); }}>
            <Text style={[s.modeTxt, mode === 'picture' && s.modeOn]}>Photo</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom controls */}
      <View style={s.bottomBar}>
        <View style={{ width: 50 }} />
        <Pressable
          onPress={onShutterPress}
          onLongPress={onShutterLongPress}
          onPressOut={onShutterPressOut}
          delayLongPress={350}
          style={[s.captureBtn, recording && s.captureRec]}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <View style={recording ? s.captureSquare : s.captureInner} />}
        </Pressable>
        <TouchableOpacity onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')} style={s.flipBtn} disabled={recording}>
          <Ionicons name="camera-reverse-outline" size={26} color="#fff" />
        </TouchableOpacity>
      </View>

      {!recording && (
        <Text style={s.hint}>{mode === 'picture' ? 'Tap for photo, hold to record' : isNote ? 'Tap to record a video note' : 'Tap to record'}</Text>
      )}
    </View>
  );
}

const makeStyles = (c: Palette) => StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { ...StyleSheet.absoluteFillObject },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 48, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#00000066', justifyContent: 'center', alignItems: 'center' },
  recPill: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#00000088', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#FF3B30' },
  noteFrame: { position: 'absolute', top: '24%', alignSelf: 'center', width: 280, height: 280, borderRadius: 140, borderWidth: 3, borderColor: 'rgba(255,255,255,0.85)' },
  recTxt: { color: '#fff', fontWeight: '700', fontSize: 13 },
  voRing: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  voOne: { color: '#fff', fontSize: 12, fontWeight: '800' },

  galleryWrap: { position: 'absolute', bottom: 168, left: 0, right: 0 },
  galleryThumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: '#222' },

  modeRow: { position: 'absolute', bottom: 130, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 28 },
  modeTxt: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '700' },
  modeOn: { color: '#fff', backgroundColor: '#00000066', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden' },

  bottomBar: { position: 'absolute', bottom: 44, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 40 },
  captureBtn: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  captureRec: { borderColor: '#FF3B30' },
  captureInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  captureSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: '#FF3B30' },
  flipBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: '#00000066', justifyContent: 'center', alignItems: 'center' },
  permBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor: c.primary, backgroundColor: brandAlpha(0.12) },
  hint: { position: 'absolute', bottom: 16, alignSelf: 'center', color: 'rgba(255,255,255,0.55)', fontSize: 12 },
});
