// app/media-viewer.tsx — Universal In-App Media Viewer
// Images: pinch-zoom, pan, tap to zoom | Videos: stream while loading, seekable
// track | Audio: built-in player | Code: inline preview

import { AuroraDark } from '../constants/theme';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Ionicons } from '@expo/vector-icons';
import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, StatusBar,
  ActivityIndicator, ScrollView, Animated,
  PanResponder, Alert } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Video, Audio, ResizeMode, type AVPlaybackStatusSuccess } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as MediaLibrary from 'expo-media-library';
import { getMedia, MediaKeyMissingError } from '../lib/mediaStore';
import { viewerRouteFor } from '../lib/docOpen';
import { getAccessToken } from '../lib/api';
import { isOwnServerUrl } from '../lib/serverOrigin';
import { attachmentUrl, markAttachmentViewed, reportScreenshotCaptured } from '../lib/chatService';
import { getCurrentUserAsync } from './(constants)/authService';
import ProtectedMediaView from '../components/ProtectedMediaView';
import { onScreenshot } from '../lib/screenGuard';
import { permissionDenied } from '../lib/permissionDenied';
import { VIEWER_TEMP_PREFIX } from '../lib/mediaCacheGC';
import { seekFraction, seekTargetMs } from '../lib/videoSeek';
import { pinchZoom, clampPan } from '../lib/zoomPan';

// Playback status is a union (loaded | error); every read below wants the loaded
// shape. Partial<> keeps the `{}` initial state honest — the fields genuinely
// are absent until the first status callback lands.
type PlaybackState = Partial<AVPlaybackStatusSuccess>;

// DARK-MEDIA TOKENS. Media sits on a black stage in BOTH app themes, so this
// screen takes the dark palette's tokens rather than the active theme's (a
// light-theme card on a black stage was the old bug).
const M = {
  stage: '#000000',
  card: AuroraDark.card,
  border: AuroraDark.border,
  text: AuroraDark.text,
  dim: AuroraDark.textDim,
  faint: AuroraDark.textFaint,
  track: AuroraDark.glassStroke,
  accent: AuroraDark.accentOn,        // accent as text/icon on dark (9.5:1)
  accentFill: AuroraDark.accentDeep,  // accent as a fill under white text
  danger: '#FF7B72',                   // readable red on black
  scrim: 'rgba(0,0,0,0.67)',
};

type FileKind = 'image' | 'video' | 'audio' | 'code' | 'pdf' | 'archive' | 'unknown';
const getFileType = (name: string): FileKind => {
  const ext = (name || '').split('.').pop()?.toLowerCase() || '';
  if (['jpg','jpeg','png','gif','webp','bmp','svg','heic'].includes(ext)) return 'image';
  if (['mp4','mov','avi','mkv','webm','flv','wmv','m4v'].includes(ext)) return 'video';
  if (['mp3','wav','m4a','aac','ogg','flac','wma'].includes(ext)) return 'audio';
  if (['js','jsx','ts','tsx','py','java','c','cpp','go','rs','rb','php','swift','kt','dart','sh','bat','ps1','sql','html','css','json','xml','yaml','yml','md','txt','toml','ini','csv','log'].includes(ext)) return 'code';
  if (ext === 'pdf') return 'pdf';
  if (['zip','rar','7z','tar','gz','bz2','xz'].includes(ext)) return 'archive';
  return 'unknown';
};

const formatSize = (b: number | undefined): string => { if (!b) return ''; if (b<1024) return b+' B'; if (b<1048576) return (b/1024).toFixed(1)+' KB'; return (b/1048576).toFixed(1)+' MB'; };
const formatDur = (ms: number | undefined): string => { if (!ms) return '0:00'; const s=Math.floor(ms/1000); return Math.floor(s/60)+':'+(s%60<10?'0':'')+(s%60); };

// The players live at MODULE scope. Defined inside MediaViewerScreen they were
// a new component type on every render, so any parent state change (the HEAD
// request's setFileSize, setMe, setAuthHeaders) unmounted and remounted them:
// video restarted, audio reloaded, zoom reset.
type Src = { uri: string; headers?: { Authorization: string } };
type PlayerProps = {
  source: Src;
  waitingForAuth: boolean;
  onLoaded: () => void;
  onFail: (msg: string) => void;
  /** Video streams: hide the screen spinner once mounted (it has its own). */
  onStreaming: () => void;
};

// IMAGE — pinch to zoom (1x–5x), drag to pan while zoomed, tap to toggle 2.5x.
function ImageViewer({ source, onLoaded, onFail }: PlayerProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const ty = useRef(new Animated.Value(0)).current;
  const [imgLoaded, setImgLoaded] = useState(false);
  // Live values + the gesture's starting point (the responder is created once).
  const cur = useRef({ z: 1, x: 0, y: 0 });
  const start = useRef({ z: 1, x: 0, y: 0, dist: 0, pinched: false });
  const box = useRef({ w: 0, h: 0 });
  const apply = (z: number, x: number, y: number, animate = false) => {
    const nx = clampPan(x, z, box.current.w), ny = clampPan(y, z, box.current.h);
    cur.current = { z, x: nx, y: ny };
    if (animate) {
      Animated.parallel([
        Animated.spring(scale, { toValue: z, useNativeDriver: true }),
        Animated.spring(tx, { toValue: nx, useNativeDriver: true }),
        Animated.spring(ty, { toValue: ny, useNativeDriver: true }),
      ]).start();
    } else { scale.setValue(z); tx.setValue(nx); ty.setValue(ny); }
  };
  const dist = (t: any[]) => Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const t = e.nativeEvent.touches;
      start.current = { ...cur.current, dist: t.length >= 2 ? dist(t) : 0, pinched: t.length >= 2 };
    },
    onPanResponderMove: (e, g) => {
      const t = e.nativeEvent.touches;
      if (t.length >= 2) {
        // A second finger can land mid-gesture: start the pinch from there.
        if (!start.current.dist) start.current = { ...cur.current, dist: dist(t), pinched: true };
        apply(pinchZoom(start.current.z, start.current.dist, dist(t)), cur.current.x, cur.current.y);
      } else if (cur.current.z > 1 && !start.current.pinched) {
        apply(cur.current.z, start.current.x + g.dx, start.current.y + g.dy);
      }
    },
    onPanResponderRelease: (_, g) => {
      const tap = !start.current.pinched && Math.abs(g.dx) < 5 && Math.abs(g.dy) < 5;
      if (tap) apply(cur.current.z > 1 ? 1 : 2.5, 0, 0, true);
      else if (cur.current.z <= 1.01) apply(1, 0, 0, true);
    },
    onPanResponderTerminate: () => { if (cur.current.z <= 1.01) apply(1, 0, 0, true); },
  })).current;
  return (
    <View style={s.full} {...panResponder.panHandlers}
      onLayout={(e) => { box.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }; }}
      accessible accessibilityRole="image" accessibilityLabel="Photo"
      accessibilityHint="Pinch to zoom. Tap to zoom in or out."
      accessibilityActions={[{ name: 'activate', label: 'Zoom in or out' }]}
      onAccessibilityAction={() => apply(cur.current.z > 1 ? 1 : 2.5, 0, 0, true)}>
      {!imgLoaded && <ActivityIndicator color={M.accent} style={s.center} />}
      <Animated.Image source={source} style={[s.fullImg, { transform: [{ translateX: tx }, { translateY: ty }, { scale }] }]} resizeMode="contain"
        onLoad={() => { setImgLoaded(true); onLoaded(); }} onError={() => onFail("This photo couldn't be loaded.")} />
    </View>
  );
}

// VIDEO — streams while loading; the track is draggable (lib/videoSeek).
function VideoPlayer({ source, waitingForAuth, onLoaded, onFail, onStreaming }: PlayerProps) {
  const videoRef = useRef<Video>(null);
  const [st, setSt] = useState<PlaybackState>({});
  const [ctrl, setCtrl] = useState(true);
  const [shouldPlay, setShouldPlay] = useState(true);
  const [seekFrac, setSeekFrac] = useState<number | null>(null);   // while dragging
  const durRef = useRef(0);
  const trackW = useRef(0);
  durRef.current = st.durationMillis ?? 0;
  const seekTo = (frac: number) => {
    const target = seekTargetMs(frac, durRef.current);
    if (target !== null) videoRef.current?.setPositionAsync(target).catch(() => {});
  };
  const seekPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => setSeekFrac(seekFraction(e.nativeEvent.locationX, trackW.current)),
    onPanResponderMove: (e) => setSeekFrac(seekFraction(e.nativeEvent.locationX, trackW.current)),
    onPanResponderRelease: (e) => { seekTo(seekFraction(e.nativeEvent.locationX, trackW.current)); setSeekFrac(null); },
    onPanResponderTerminate: () => setSeekFrac(null),
  })).current;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once auth is settled
  useEffect(() => { if (!waitingForAuth) onStreaming(); }, [waitingForAuth]);
  // expo-av loads a source once and never retries, so mounting before the
  // token is ready would fail permanently rather than briefly.
  if (waitingForAuth) return <View style={s.full}><ActivityIndicator color={M.accent} style={s.center} /></View>;
  const dur = st.durationMillis || 0;
  const pos = seekFrac !== null ? seekFrac * dur : (st.positionMillis || 0);
  const frac = dur ? pos / dur : 0;
  const step = (deltaMs: number) => {
    if (!dur) return;
    videoRef.current?.setPositionAsync(Math.max(0, Math.min(dur, (st.positionMillis || 0) + deltaMs))).catch(() => {});
  };
  return (
    // Not accessible: an accessible wrapper groups its children, which hid the
    // play button and seek track from screen readers. Controls start shown and
    // only this (unfocusable) tap hides them, so they stay reachable.
    <TouchableOpacity style={s.full} activeOpacity={1} onPress={() => setCtrl(!ctrl)} accessible={false} accessibilityRole="none">
      <Video ref={videoRef} source={source} style={s.fullVid} resizeMode={ResizeMode.CONTAIN}
        shouldPlay={shouldPlay} isLooping={false} useNativeControls={false} progressUpdateIntervalMillis={250}
        onPlaybackStatusUpdate={(status) => { if (!status.isLoaded) return; setSt(status); if (status.didJustFinish) setShouldPlay(false); }}
        onLoad={onLoaded} onError={() => onFail("This video couldn't be played. It may be damaged or in an unsupported format.")} />
      {st.isBuffering && !st.isPlaying && <View style={s.bufOverlay}><ActivityIndicator color={M.accent} size="large" /><Text style={s.bufTxt}>Streaming...</Text></View>}
      {ctrl && (
        <View style={s.vidCtrl}>
          <TouchableOpacity style={s.playBtn} accessibilityRole="button" accessibilityLabel={st.isPlaying ? 'Pause video' : 'Play video'} onPress={async () => {
            const v = videoRef.current; if (!v) return;
            if (st.isPlaying) { await v.pauseAsync().catch(() => {}); setShouldPlay(false); }
            else {
              // Replay from the start if it had reached the end.
              if (st.didJustFinish || (st.durationMillis && (st.positionMillis ?? 0) >= st.durationMillis)) { await v.setPositionAsync(0).catch(() => {}); }
              await v.playAsync().catch(() => {}); setShouldPlay(true);
            }
          }}>
            <Ionicons name={st.isPlaying ? 'pause' : 'play'} size={40} color={M.text} />
          </TouchableOpacity>
          <View style={s.progRow}>
            <Text style={s.timeTxt}>{formatDur(pos)}</Text>
            <View style={s.seekHit}
              onLayout={(e) => { trackW.current = e.nativeEvent.layout.width; }}
              accessible accessibilityRole="adjustable" accessibilityLabel="Seek"
              accessibilityValue={{ text: `${formatDur(pos)} of ${formatDur(dur)}` }}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 10000 : -10000)}
              {...seekPan.panHandlers}>
              <View style={s.seekBg} pointerEvents="none">
                <View style={[s.seekBuf, { width: `${(st.playableDurationMillis||0) / (dur||1) * 100}%` }]} />
                <View style={[s.seekFill, { width: `${frac * 100}%` }]} />
              </View>
              <View pointerEvents="none" style={[s.seekThumb, { left: `${frac * 100}%` }]} />
            </View>
            <Text style={s.timeTxt}>{formatDur(dur)}</Text>
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

// Stable bar heights: Math.random() in render made the waveform flicker on
// every 200 ms status update.
const WAVE = Array.from({ length: 40 }, (_, i) => 8 + ((i * 37) % 29));

// AUDIO
function AudioPlayer({ source, waitingForAuth, onLoaded, onFail, fileName, fileSize }: PlayerProps & { fileName: string; fileSize: number }) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [ast, setAst] = useState<PlaybackState>({});
  useEffect(() => {
    if (waitingForAuth) return;                 // createAsync would 401, and it does not retry
    let dead = false;
    (async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync(source, { shouldPlay: false, progressUpdateIntervalMillis: 200 }, (st) => { if (st.isLoaded) setAst(st); });
        // The screen can close while createAsync is in flight; without this the
        // sound is created after unmount and never unloaded — it keeps playing
        // with no controls left to stop it.
        if (dead) { sound.unloadAsync().catch(() => {}); return; }
        soundRef.current = sound; onLoaded();
      } catch { if (!dead) onFail("This audio couldn't be played. It may be damaged or in an unsupported format."); }
    })();
    return () => { dead = true; soundRef.current?.unloadAsync(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per source
  }, [waitingForAuth, source]);
  const prog = (ast.positionMillis||0) / (ast.durationMillis||1);
  const jump = (delta: number) => {
    if (!soundRef.current) return;
    const p = Math.max(0, Math.min(1, prog + delta));
    soundRef.current.setPositionAsync(p * (ast.durationMillis || 0)).catch(() => {});
  };
  return (
    <View style={s.audioWrap}>
      <View style={s.audioCard}>
        <Ionicons name="musical-notes" size={48} color={M.accent} />
        <Text style={s.audioName}>{fileName}</Text>
        <Text style={s.audioMeta}>{formatSize(fileSize)}{ast.durationMillis ? ' | ' + formatDur(ast.durationMillis) : ''}</Text>
        <View style={s.waveform} accessible accessibilityRole="progressbar" accessibilityLabel="Playback position"
          accessibilityValue={{ text: `${formatDur(ast.positionMillis)} of ${formatDur(ast.durationMillis)}` }}>
          {WAVE.map((h,i) => <View key={i} style={[s.waveBar,{height:h,backgroundColor:i/40<prog?M.accent:M.track}]}/>)}
        </View>
        <View style={s.audioTimeRow}><Text style={s.audioTime}>{formatDur(ast.positionMillis)}</Text><Text style={s.audioTime}>{formatDur(ast.durationMillis)}</Text></View>
        <View style={s.audioCtrlRow}>
          <TouchableOpacity hitSlop={10} onPress={() => jump(-0.1)} accessibilityRole="button" accessibilityLabel="Back ten per cent"><Ionicons name="play-back" size={26} color={M.text} /></TouchableOpacity>
          <TouchableOpacity style={s.audioPlayBtn} onPress={async()=>{if(!soundRef.current)return;await (ast.isPlaying ? soundRef.current.pauseAsync() : soundRef.current.playAsync()).catch(() => {});}} accessibilityRole="button" accessibilityLabel={ast.isPlaying ? 'Pause audio' : 'Play audio'}>
            <Ionicons name={ast.isPlaying?'pause':'play'} size={30} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity hitSlop={10} onPress={() => jump(0.1)} accessibilityRole="button" accessibilityLabel="Forward ten per cent"><Ionicons name="play-forward" size={26} color={M.text} /></TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

/** Calls onReady once on mount: these cards have nothing to load. */
function useReady(onReady: () => void) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once on mount
  useEffect(() => { onReady(); }, []);
}

// ARCHIVE — browsable, not just downloadable: app/archive-viewer lists the
// contents and extracts one entry on tap.
function ArchiveCard({ fileName, fileSize, onReady, onBrowse, onSave }: {
  fileName: string; fileSize: number; onReady: () => void; onBrowse: () => void; onSave: () => void;
}) {
  useReady(onReady);
  return (
    <View style={s.audioWrap}><View style={s.audioCard}>
      <Ionicons name="file-tray-full-outline" size={48} color={M.accent} />
      <Text style={s.audioName}>{fileName}</Text>
      <Text style={s.audioMeta}>{formatSize(fileSize)}</Text>
      <TouchableOpacity style={s.primaryBtn} onPress={onBrowse} accessibilityRole="button" accessibilityLabel="Browse archive contents">
        <Ionicons name="folder-open-outline" size={16} color="#FFFFFF" /><Text style={s.primaryBtnTxt}>Browse contents</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.secondaryBtn} onPress={onSave} accessibilityRole="button" accessibilityLabel="Save to device">
        <Text style={s.secondaryBtnTxt}>Save to device</Text>
      </TouchableOpacity>
    </View></View>
  );
}

// PDF / UNKNOWN
function GenericViewer({ fileName, fileSize, onReady, onSave, onOpen }: {
  fileName: string; fileSize: number; onReady: () => void; onSave: () => void; onOpen: () => void;
}) {
  useReady(onReady);
  return (
    <View style={s.audioWrap}><View style={s.audioCard}>
      <Ionicons name="document-outline" size={48} color={M.accent} />
      <Text style={s.audioName}>{fileName}</Text>
      <Text style={s.audioMeta}>{formatSize(fileSize)}</Text>
      <TouchableOpacity style={s.primaryBtn} onPress={onSave} accessibilityRole="button" accessibilityLabel="Download and open">
        <Ionicons name="download-outline" size={16} color="#FFFFFF" /><Text style={s.primaryBtnTxt}>Download & Open</Text>
      </TouchableOpacity>
      {/* app/file-viewer.tsx shows file metadata and hands documents to the
          device's own PDF/Office app WITHOUT saving a copy to shared storage,
          which "Download & Open" above does do. */}
      <TouchableOpacity style={s.secondaryBtn} onPress={onOpen} activeOpacity={0.8}
        accessibilityRole="button" accessibilityLabel="Open without saving">
        <Ionicons name="eye-outline" size={16} color={M.accent} />
        <Text style={s.secondaryBtnTxt}>Open without saving</Text>
      </TouchableOpacity>
    </View></View>
  );
}

// CODE/TEXT — a dark code canvas in BOTH themes (it was light text on #FFFFFF).
const CODE = { bg: '#0D1117', head: '#161B22', border: '#21262D', text: '#E6EDF3', dim: '#8B949E', gutter: '#6E7681' };
function CodeViewer({ fileUri, fileName, needsAuth, onLoaded, onOpenHighlighted }: {
  fileUri: string; fileName: string; needsAuth: boolean; onLoaded: () => void; onOpenHighlighted: () => void;
}) {
  const [content, setContent] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let dead = false;
    (async () => {
      let lp: string | null = null;
      try {
        let text: string;
        if (fileUri.startsWith('http')) {
          lp = FileSystem.cacheDirectory + VIEWER_TEMP_PREFIX + 'prev_' + Date.now();
          // The URL comes from route params: the token goes to our server only.
          const token = needsAuth && isOwnServerUrl(fileUri) ? await getAccessToken() : null;
          const res = await FileSystem.downloadAsync(fileUri, lp,
            token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
          if (res.status >= 400) throw new Error('GET ' + res.status);
          text = await FileSystem.readAsStringAsync(lp);
        } else text = await FileSystem.readAsStringAsync(fileUri);
        if (!dead) setContent(text);
      } catch { if (!dead) setFailed(true); }
      // The preview copy is plaintext; it is read into memory and not kept.
      if (lp) FileSystem.deleteAsync(lp, { idempotent: true }).catch(() => {});
      if (!dead) onLoaded();
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per file
  }, [fileUri]);
  const lines = content.split('\n');
  return (
    <ScrollView style={{flex:1,backgroundColor:CODE.bg}}>
      <View style={{padding:12,backgroundColor:CODE.head,borderBottomWidth:1,borderBottomColor:CODE.border}}>
        <Text style={{color:CODE.text,fontSize:14,fontWeight:'800'}}>{fileName}</Text>
        <Text style={{color:CODE.dim,fontSize:11,marginTop:4}}>{lines.length} lines | {formatSize(content.length)}</Text>
        <TouchableOpacity style={{marginTop:10,minHeight:44,borderRadius:10,paddingVertical:10,flexDirection:'row',gap:6,justifyContent:'center',alignItems:'center',borderWidth:1,borderColor:M.border}}
          onPress={onOpenHighlighted} accessibilityRole="button" accessibilityLabel="Open with syntax highlighting">
          <Ionicons name="code-slash-outline" size={14} color={M.accent} />
          <Text style={{color:M.accent,fontSize:12,fontWeight:'700'}}>Open with Syntax Highlighting</Text>
        </TouchableOpacity>
      </View>
      {failed && <Text style={{color:M.danger,fontSize:13,textAlign:'center',padding:20}}>{"Couldn't read this file."}</Text>}
      {lines.slice(0,500).map((l,i)=><View key={i} style={{flexDirection:'row',minHeight:22}}><Text style={{color:CODE.gutter,fontSize:12,fontFamily:'monospace',width:40,textAlign:'right',paddingRight:12,paddingTop:2}}>{i+1}</Text><Text style={{color:CODE.text,fontSize:12,fontFamily:'monospace',flex:1,paddingTop:2}}>{l}</Text></View>)}
      {lines.length>500&&<Text style={{color:CODE.gutter,fontSize:12,textAlign:'center',padding:20}}>...{lines.length-500} more lines</Text>}
      <View style={{height:100}}/>
    </ScrollView>
  );
}

function MediaViewerScreen() {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const router = useRouter();
  const { uri, mediaUrl, attachmentId, needsAuth, isMine, mime, filename, msgType, viewOnce, chatId, encrypted } = useLocalSearchParams();
  const isViewOnce = viewOnce === '1';

  // ── VaultView watermark identity ─────────────────────────
  // The overlay carries the VIEWER's identity, not the sender's — that is what
  // makes a second-phone photo self-incriminating. Loaded from the local
  // session so it works offline.
  const [me, setMe] = useState<{ name?: string; phone?: string } | null>(null);
  useEffect(() => {
    if (!isViewOnce) return;
    getCurrentUserAsync()
      .then((u: any) => setMe({ name: u?.name || u?.email, phone: u?.phone || u?.phoneNumber }))
      .catch(() => {});
  }, [isViewOnce]);

  // Screenshot while protected media is open → tell the sender. On Android
  // FLAG_SECURE means this rarely fires (the capture is black); on iOS it is the
  // whole defence.
  useEffect(() => {
    if (!isViewOnce || !chatId) return;
    const stop = onScreenshot(() => {
      reportScreenshotCaptured(String(chatId)).catch(() => {});
    });
    return stop;
  }, [isViewOnce, chatId]);
  const viewedRef = useRef(false);
  // Path of the ephemeral plaintext this viewer wrote (view-once only). The
  // server burns the attachment on first view, so this cache file is the ONLY
  // remaining copy — it must not outlive the screen. Deleted on unmount here;
  // lib/mediaCacheGC.purgeEphemeralMedia() is the crash-recovery path.
  const ephemeralRef = useRef<string | null>(null);
  useEffect(() => () => {
    const p = ephemeralRef.current;
    ephemeralRef.current = null;
    if (p) FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
  }, []);
  // Mark the server "viewed" only AFTER the media has loaded — never before, or
  // the POST /viewed flips viewed_at while the GET is still in flight and the GET
  // 410s. View-once is also downloaded to cache (below), never persisted.
  const markViewedAfterLoad = () => {
    if (isViewOnce && attachmentId && !viewedRef.current) {
      viewedRef.current = true;
      markAttachmentViewed(String(attachmentId)).catch(() => {});
    }
  };
  const fileName = (filename || 'file') + '';
  // For our own /uploads images we attach the Bearer header so Fresco serves the
  // already-cached image instantly (no re-download).
  const [authHeaders, setAuthHeaders] = useState<{ Authorization: string } | undefined>(undefined);
  // No token (signed out, or the read failed) must end in an error, not a
  // player that waits for headers forever.
  const [authFailed, setAuthFailed] = useState(false);

  const fileType = msgType === 'image' ? 'image' : msgType === 'video' ? 'video' : msgType === 'audio' ? 'audio' : getFileType(fileName);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fileSize, setFileSize] = useState(0);
  // Bumped by Retry: re-runs the attachment resolve and remounts the player.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!needsAuth) return;
    let dead = false;
    setAuthFailed(false);
    getAccessToken()
      .then(t => { if (dead) return; if (t) setAuthHeaders({ Authorization: `Bearer ${t}` }); else setAuthFailed(true); })
      .catch(() => { if (!dead) setAuthFailed(true); });
    return () => { dead = true; };
  }, [needsAuth, reloadKey]);
  // When opened by attachmentId (the common path from a chat bubble) we resolve
  // a local file here — so the bubble navigates INSTANTLY and we show a spinner,
  // instead of the bubble awaiting a download (which made taps feel unreliable
  // and stacked multiple viewers).
  const [fileUri, setFileUri] = useState<string>((mediaUrl || uri || '') + '');

  // ONE source rule for every player.
  //
  // saveToDevice sends the bearer token and so did the Image — but Video and
  // Audio were built with a bare { uri }, so authenticated media DOWNLOADED
  // fine and refused to PLAY. The server answers 401, expo-av reports a generic
  // load failure, and it looks like a broken player rather than a missing
  // header. Images kept working, which is exactly what makes this read as "the
  // video player is broken" rather than "the request was unauthenticated".
  // fileUri comes from route params (deep links too), so the token is attached
  // only for our own server, never for whatever host the link names.
  const remoteNeedsAuth = !!needsAuth && isOwnServerUrl(fileUri);
  // Memoised: a new source object on every render would make expo-av reload.
  const source = useMemo(
    () => (remoteNeedsAuth && authHeaders ? { uri: fileUri, headers: authHeaders } : { uri: fileUri }),
    [remoteNeedsAuth, authHeaders, fileUri],
  );

  // Mounting a player before the token resolves is the same 401 with extra
  // steps: getAccessToken is async, expo-av loads a source once and does NOT
  // retry, so a player that loses that race stays broken until the screen is
  // reopened — intermittently, which is the worst way to hit it.
  const waitingForAuth = remoteNeedsAuth && !authHeaders;
  useEffect(() => {
    if (!waitingForAuth || !authFailed) return;
    setError("This media couldn't be loaded because you're signed out or offline. Check your connection and try again.");
    setLoading(false);
  }, [waitingForAuth, authFailed]);

  useEffect(() => {
    if (fileUri || !attachmentId) return;
    let cancel = false;
    const onErr = (e?: unknown) => {
      if (cancel) return;
      setError(e instanceof MediaKeyMissingError
        ? 'This media is end-to-end encrypted and this device no longer holds its key.'
        : "This media couldn't be loaded. Check your connection and try again.");
      setLoading(false);
    };
    if (isViewOnce) {
      // View-once: download to an EPHEMERAL cache file (not the browsable media
      // folder) so it's never saved. The GET runs while viewed_at is still NULL,
      // so it serves; we flip viewed_at only after onLoad (markViewedAfterLoad).
      (async () => {
        try {
          const token = await getAccessToken();
          const ext = msgType === 'video' ? 'mp4' : 'jpg';
          const dest = FileSystem.cacheDirectory + 'vo_' + String(attachmentId) + '.' + ext;
          const res = await FileSystem.downloadAsync(attachmentUrl(String(attachmentId)), dest, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
          if (res.status >= 400) throw new Error('view-once GET ' + res.status);
          ephemeralRef.current = res.uri;   // wiped on unmount
          if (cancel) { FileSystem.deleteAsync(res.uri, { idempotent: true }).catch(() => {}); return; }
          setFileUri(res.uri);
        } catch { onErr(); }
      })();
      return () => { cancel = true; };
    }
    // KIND MUST MATCH THE FILE, not just "video or not".
    //
    // Every non-video attachment was fetched as kind:'image'. The Shelf opens
    // documents through this screen, so a PDF was stored as
    // "VaultChat Images/IMG-<id>.pdf" — and, worse, the sender's own Sent/
    // lookup in getMedia is keyed on the same path, so a file the sender
    // already had on disk missed and was DOWNLOADED BACK from the server.
    //
    // `encrypted` is passed for the same reason it exists: without it getMedia
    // cannot tell "plaintext" from "encrypted but this device has no key", and
    // the no-key branch writes raw CIPHERTEXT into a file named .pdf (audit
    // F-8). With it, callers get MediaKeyMissingError and can say so.
    getMedia(String(attachmentId), {
      kind: msgType === 'video' ? 'video'
          : msgType === 'audio' ? 'audio'
          : msgType === 'image' ? 'image'
          : fileType === 'image' ? 'image'
          : fileType === 'video' ? 'video'
          : fileType === 'audio' ? 'audio'
          : 'file',
      isMine: isMine === '1',
      mime: mime ? String(mime) : undefined,
      filename: filename ? String(filename) : undefined,
      encrypted: encrypted === '1',
    })
      .then(u => { if (!cancel) setFileUri(u); })
      .catch(onErr);
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolve once per attachment (and per Retry)
  }, [attachmentId, reloadKey]);

  useEffect(() => {
    if (fileUri.startsWith('http')) fetch(fileUri, { method: 'HEAD' }).then(r => setFileSize(parseInt(r.headers.get('content-length') || '0'))).catch(() => {});
  }, [fileUri]);

  // Documents READ here, they do not sit behind a download button.
  //
  // A PDF opened from the Shelf landed on GenericViewer, whose primary action is
  // "Download & Open" — it saves a copy to shared storage and hands the file to
  // another app. The in-app renderer (components/PdfView, pdf.js) was reachable
  // only through the secondary "Open without saving" link, so the default path
  // for reading a document was OUT of crazzychat. file-viewer is the screen that
  // renders PDF pages, Word/Excel/PowerPoint structure and text, so send the
  // resolved local file straight there, exactly as video already redirects.
  const docRoute = viewerRouteFor(fileName, mime ? String(mime) : undefined);
  useEffect(() => {
    if (!fileUri || docRoute !== '/file-viewer') return;
    router.replace({
      pathname: '/file-viewer',
      params: { uri: fileUri, filename: fileName, mimeType: (mime || '') + '' },
    } as any);
  }, [fileUri, docRoute, fileName, mime, router]);

  // Share the FILE, not a string.
  //
  // This used to be React Native's Share.share({ url: fileUri }). Two problems,
  // and together they are the reported crash:
  //   * `url` is iOS-only. On Android it is ignored, so the sheet offered the
  //     filename as text and never the media.
  //   * fileUri is a file:// path (media is decrypted to disk before viewing),
  //     and handing a file:// URI to another app trips Android's StrictMode
  //     FileUriExposedException. Other apps must receive a content:// URI from
  //     a FileProvider.
  //
  // expo-sharing does the FileProvider work, and it is what saveToDevice below
  // and every path in file-viewer.tsx already use — this button was the one
  // place still on the old API.
  const shareFile = async () => {
    try {
      if (!fileUri) return;
      if (!(await Sharing.isAvailableAsync())) { Alert.alert('Sharing unavailable', 'No app on this device can receive this file.'); return; }
      await Sharing.shareAsync(fileUri, {
        mimeType: mime ? String(mime) : undefined,
        dialogTitle: fileName,
      });
    } catch (e: any) {
      console.warn('[media-viewer] share failed:', e?.message ?? e);
      Alert.alert('Could not share', 'This file could not be shared. Please try again.');
    }
  };

  const saveToDevice = async () => {
    try {
      const ext = fileName.split('.').pop() || 'file';
      // downloadAsync ONLY accepts http(s). fileUri is already a local path for
      // encrypted media (decrypted to disk) and for anything opened from the
      // Shelf, and passing that in throws:
      //   IllegalArgumentException: Expected URL scheme 'http' or 'https' but was 'file'
      // which surfaced as a bare red "Error" dialog on tapping Save/Download.
      let localPath = fileUri;
      let temp = false;
      if (/^https?:\/\//i.test(fileUri)) {
        // A vt_ temp, so a copy left by a crash is swept at boot/logout.
        localPath = FileSystem.cacheDirectory + VIEWER_TEMP_PREFIX + 'save_' + Date.now() + '.' + ext;
        temp = true;
        const token = isOwnServerUrl(fileUri) ? await getAccessToken() : null;
        const res = await FileSystem.downloadAsync(fileUri, localPath,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (res.status >= 400) throw new Error(`Download failed (${res.status})`);
      }
      if (['image','video'].includes(fileType)) {
        const { status, canAskAgain } = await MediaLibrary.requestPermissionsAsync();
        // No else here meant a refused Save was indistinguishable from a saved
        // one: nothing happened and nothing was said (2026-09-17).
        if (status !== 'granted') { permissionDenied('Photo access needed', 'Allow photo access to save this to your gallery.', canAskAgain); return; }
        await MediaLibrary.saveToLibraryAsync(localPath); Alert.alert('Saved!', fileName + ' saved to gallery');
        // The library holds its own copy now; the download was only a carrier.
        if (temp) FileSystem.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      } else if (await Sharing.isAvailableAsync()) { await Sharing.shareAsync(localPath); }
      else Alert.alert('Sharing unavailable', 'No app on this device can open this file.');
    } catch (e: any) {
      console.warn('[media-viewer] save failed:', e?.message ?? e);
      Alert.alert('Could not save', 'This file could not be saved. Check your connection and storage, then try again.');
    }
  };

  const retry = () => {
    setError('');
    setLoading(true);
    setReloadKey(k => k + 1);
  };

  const playerProps: PlayerProps = {
    source,
    waitingForAuth,
    onLoaded: () => { setLoading(false); markViewedAfterLoad(); },
    onFail: (msg) => { setError(msg); setLoading(false); },
    onStreaming: () => setLoading(false),
  };

  // NO SOURCE = NOTHING TO VIEW, AND THE USER MUST NOT BE STRANDED.
  //
  // Reached by a bare deep link (vaultchat://media-viewer), a notification whose
  // attachment was revoked, or a view-once item already burned. Without this the
  // screen drew a black container with no header and no text at all — a blank
  // wall with no way out. After the hooks, so hook order is unchanged.
  if (!uri && !mediaUrl && !attachmentId) {
    return (
      <>
        <Stack.Screen options={{
          headerShown: true, title: 'Media unavailable',
          headerStyle: { backgroundColor: M.stage }, headerTintColor: M.text,
        }} />
        <View style={[s.container, { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }]}>
          <Ionicons name="image-outline" size={44} color={M.dim} />
          <Text accessibilityRole="header" style={{ color: M.text, fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
            Nothing to show
          </Text>
          <Text style={{ color: M.dim, fontSize: 14, textAlign: 'center' }}>
            This link carried no media, or the file is no longer available.
          </Text>
          <TouchableOpacity
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as any))}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: M.accentFill }}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '700' }}>Go back</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: fileName, headerStyle: { backgroundColor: M.stage }, headerTintColor: M.text,
        // Share/Save are hidden for view-once media. Offering "Download" on a
        // photo the sender was promised is one-view-only would hand the
        // recipient a permanent copy through the app's own UI — the protection
        // has to hold in the viewer, not only on the server.
        headerRight: () => isViewOnce ? null : <View style={{flexDirection:'row',gap:20,marginRight:8}}>
          <TouchableOpacity onPress={shareFile} hitSlop={11} accessibilityRole="button" accessibilityLabel="Share"><Ionicons name="share-social-outline" size={22} color={M.text} /></TouchableOpacity>
          <TouchableOpacity onPress={saveToDevice} hitSlop={11} accessibilityRole="button" accessibilityLabel="Save to device"><Ionicons name="download-outline" size={22} color={M.text} /></TouchableOpacity>
        </View>,
      }} />
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor={M.stage} />
        {loading && !error && <ActivityIndicator color={M.accent} style={s.center} />}
        {error ? (
          <View style={s.errorBox} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle-outline" size={40} color={M.danger} />
            <Text style={s.errorTxt}>{error}</Text>
            <TouchableOpacity style={s.primaryBtn} onPress={retry} accessibilityRole="button" accessibilityLabel="Retry">
              <Ionicons name="refresh" size={16} color="#FFFFFF" /><Text style={s.primaryBtnTxt}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : !fileUri ? (
          <ActivityIndicator color={M.accent} style={s.center} size="large" />
        ) : (
          // Protected media renders inside the VaultView guard: watermarked, and
          // refused outright while a recording/mirror is active. Everything else
          // renders exactly as before.
          isViewOnce && (fileType === 'image' || fileType === 'video') ? (
            <ProtectedMediaView
              watermarkName={me?.name}
              watermarkPhone={me?.phone}
              onBlocked={() => { if (chatId) reportScreenshotCaptured(String(chatId)).catch(() => {}); }}
            >
              {fileType === 'image' ? <ImageViewer key={reloadKey} {...playerProps} /> : <VideoPlayer key={reloadKey} {...playerProps} />}
            </ProtectedMediaView>
          ) : (
            <>
              {fileType === 'image' && <ImageViewer key={reloadKey} {...playerProps} />}
              {fileType === 'video' && <VideoPlayer key={reloadKey} {...playerProps} />}
              {fileType === 'audio' && <AudioPlayer key={reloadKey} {...playerProps} fileName={fileName} fileSize={fileSize} />}
              {fileType === 'code' && (
                <CodeViewer key={reloadKey} fileUri={fileUri} fileName={fileName} needsAuth={!!needsAuth}
                  onLoaded={() => setLoading(false)}
                  onOpenHighlighted={() => router.push({ pathname: '/file-preview', params: { uri: fileUri, filename: fileName, mediaUrl: fileUri } })} />
              )}
              {fileType === 'archive' && (
                <ArchiveCard fileName={fileName} fileSize={fileSize} onReady={() => setLoading(false)} onSave={saveToDevice}
                  onBrowse={() => router.push({ pathname: '/archive-viewer', params: { uri: fileUri, filename: fileName } } as any)} />
              )}
              {(fileType === 'pdf' || fileType === 'unknown') && (
                <GenericViewer fileName={fileName} fileSize={fileSize} onReady={() => setLoading(false)} onSave={saveToDevice}
                  onOpen={() => router.push({ pathname: '/file-viewer', params: { uri: fileUri, filename: fileName, mimeType: (mime || '') + '' } })} />
              )}
            </>
          )
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:M.stage},
  full:{flex:1,justifyContent:'center',alignItems:'center'},
  center:{position:'absolute',top:'45%',alignSelf:'center',zIndex:10},
  fullImg:{width:'100%',height:'100%'},
  fullVid:{width:'100%',height:'100%'},
  bufOverlay:{position:'absolute',justifyContent:'center',alignItems:'center'},
  bufTxt:{color:M.dim,fontSize:12,marginTop:8},
  vidCtrl:{position:'absolute',bottom:0,left:0,right:0,backgroundColor:M.scrim,padding:16,paddingBottom:30},
  playBtn:{alignSelf:'center',marginBottom:12},
  progRow:{flexDirection:'row',alignItems:'center',gap:8},
  timeTxt:{color:M.dim,fontSize:11,width:40},
  // The 32 is touch slop around a 4dp bar; a minimum, so it never clips.
  seekHit:{flex:1,minHeight:32,justifyContent:'center'},
  seekBg:{height:4,backgroundColor:M.track,borderRadius:2,overflow:'hidden'},
  seekBuf:{position:'absolute',height:'100%',backgroundColor:M.faint,borderRadius:2},
  seekFill:{height:'100%',backgroundColor:M.accent,borderRadius:2},
  seekThumb:{position:'absolute',width:14,height:14,borderRadius:7,marginLeft:-7,backgroundColor:M.accent},
  audioWrap:{flex:1,justifyContent:'center',padding:24},
  audioCard:{backgroundColor:M.card,borderRadius:24,padding:32,alignItems:'center',borderWidth:1,borderColor:M.border},
  audioName:{color:M.text,fontSize:16,fontWeight:800,marginTop:12,textAlign:'center'},
  audioMeta:{color:M.dim,fontSize:12,marginTop:4},
  waveform:{
    // layout-exempt: draws fixed-width bars, no text — height is the drawing.
    flexDirection:'row',alignItems:'center',gap:2,marginTop:24,height:40,
  },
  waveBar:{width:3,borderRadius:2},
  audioTimeRow:{flexDirection:'row',justifyContent:'space-between',width:'100%',marginTop:8},
  audioTime:{color:M.dim,fontSize:11},
  audioCtrlRow:{flexDirection:'row',alignItems:'center',gap:24,marginTop:20},
  audioPlayBtn:{width:64,height:64,borderRadius:32,backgroundColor:M.accentFill,justifyContent:'center',alignItems:'center'},
  primaryBtn:{marginTop:20,backgroundColor:M.accentFill,borderRadius:14,flexDirection:'row',gap:8,alignItems:'center',justifyContent:'center',paddingVertical:14,paddingHorizontal:32},
  primaryBtnTxt:{color:'#FFFFFF',fontSize:14,fontWeight:'800'},
  secondaryBtn:{marginTop:12,borderRadius:14,borderWidth:1,borderColor:M.border,flexDirection:'row',gap:8,alignItems:'center',justifyContent:'center',paddingVertical:12,paddingHorizontal:28},
  secondaryBtnTxt:{color:M.accent,fontSize:13,fontWeight:'700'},
  errorBox:{flex:1,alignItems:'center',justifyContent:'center',padding:24,gap:12},
  errorTxt:{color:M.text,fontSize:15,textAlign:'center',lineHeight:21},
});

// A render fault in a viewer used to take the WHOLE app down: these screens
// render untrusted, arbitrary media (a truncated video, a malformed PDF, an
// office file with a codec this device lacks) and none of them were wrapped.
// The boundary turns that crash into a dismissable screen with the chat intact.
export default function MediaViewerScreenBoundary() {
  return (
    <ErrorBoundary screen="MediaViewerScreen" fallbackTitle="Media Viewer Error" fallbackMessage="This photo or video could not be displayed.">
      <MediaViewerScreen />
    </ErrorBoundary>
  );
}
