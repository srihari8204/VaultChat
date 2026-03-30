// app/file-viewer.tsx — Universal File Viewer for VaultChat
// View ANY file without leaving the app: images, videos, PDFs, Office docs,
// code/text files, audio — all rendered inline with premium UI.

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  PanResponder,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { LinearGradient } from 'expo-linear-gradient';
import { WebView } from 'react-native-webview';

const { width: SW, height: SH } = Dimensions.get('window');

// ── Design tokens ────────────────────────────────────────────────
const C = {
  bg: '#FFFFFF',
  bgPure: '#000000',
  primary: '#4A9FFF',
  secondary: '#7C3AED',
  accent: '#10B981',
  danger: '#EF4444',
  warning: '#F59E0B',
  text: '#FFFFFF',
  textDim: 'rgba(255,255,255,0.55)',
  textFaint: 'rgba(255,255,255,0.25)',
  border: 'rgba(74,159,255,0.15)',
  glass: 'rgba(2,11,24,0.72)',
  glassBorder: 'rgba(255,255,255,0.08)',
};

// ── File type detection ──────────────────────────────────────────
const EXT_MAP: Record<string, string> = {};
['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg'].forEach(e => (EXT_MAP[e] = 'image'));
['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'].forEach(e => (EXT_MAP[e] = 'video'));
['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma'].forEach(e => (EXT_MAP[e] = 'audio'));
['pdf'].forEach(e => (EXT_MAP[e] = 'pdf'));
['ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx'].forEach(e => (EXT_MAP[e] = 'office'));
['txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'md', 'csv', 'xml', 'html', 'css', 'sql', 'sh', 'yaml', 'yml', 'toml', 'ini', 'log', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'swift', 'kt', 'dart', 'php'].forEach(e => (EXT_MAP[e] = 'text'));

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

// ── Skeleton shimmer component ───────────────────────────────────
function SkeletonShimmer({ width: w, height: h, style }: any) {
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
export default function FileViewerScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ uri: string; filename: string; mimeType?: string }>();
  const fileUri = (params.uri || '') + '';
  const fileName = (params.filename || 'file') + '';
  const fileType = detectType(fileName, params.mimeType as string | undefined);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [textContent, setTextContent] = useState('');

  // Audio state
  const [sound, setSound] = useState<Audio.Sound | null>(null);
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

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
    const loadTextContentInEffect = async () => {
      try {
        let content: string;
        if (fileUri.startsWith('http')) {
          const dl = await FileSystem.downloadAsync(fileUri, FileSystem.cacheDirectory + 'temp_view_' + Date.now());
          content = await FileSystem.readAsStringAsync(dl.uri);
        } else {
          content = await FileSystem.readAsStringAsync(fileUri);
        }
        setTextContent(content);
      } catch {
        setError('Could not read file contents');
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
        setLoading(false);
      } catch (e: any) {
        setError(e.message || 'Failed to load file');
        setLoading(false);
      }
    };
    loadFileMeta();
    return () => { sound?.unloadAsync(); };
  }, [fadeIn, slideUp, fileUri, fileType, sound]);

  // Redirect to dedicated video player when file type is video
  useEffect(() => {
    if (fileType === 'video') {
      router.replace({ pathname: '/media-viewer', params: { uri: fileUri, filename: fileName, msgType: 'video' } });
    }
  }, [fileType, fileName, fileUri, router]);

  // ── Load file metadata ─────────────────────────────────────────
  const loadFileMeta = async () => {
    try {
      if (fileUri.startsWith('file://') || fileUri.startsWith(FileSystem.documentDirectory || '')) {
        const info = await FileSystem.getInfoAsync(fileUri);
        if (info.exists && info.size) setFileSize(info.size);
      }
      if (fileType === 'text') await loadTextContent();
      if (fileType === 'audio') await loadAudio();
      setLoading(false);
    } catch (e: any) {
      setError(e.message || 'Failed to load file');
      setLoading(false);
    }
  };

  // ── Text / code file loader ────────────────────────────────────
  const loadTextContent = async () => {
    try {
      let content: string;
      if (fileUri.startsWith('http')) {
        const dl = await FileSystem.downloadAsync(fileUri, FileSystem.cacheDirectory + 'temp_view_' + Date.now());
        content = await FileSystem.readAsStringAsync(dl.uri);
      } else {
        content = await FileSystem.readAsStringAsync(fileUri);
      }
      setTextContent(content);
    } catch {
      setError('Could not read file contents');
    }
  };

  // ── Audio loader ───────────────────────────────────────────────
  const loadAudio = async () => {
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
      setSound(snd);
    } catch {
      setError('Could not load audio');
    }
  };

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

  // ── Share / open externally ────────────────────────────────────
  const handleShare = async () => {
    try {
      let localUri = fileUri;
      if (fileUri.startsWith('http')) {
        const dl = await FileSystem.downloadAsync(fileUri, FileSystem.cacheDirectory + fileName);
        localUri = dl.uri;
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
  const handleRetry = () => {
    setError('');
    setLoading(true);
    loadFileMeta();
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
  // ██  RENDER: PDF via WebView
  // ══════════════════════════════════════════════════════════════
  const renderPDF = () => {
    const googleUrl = `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(fileUri)}`;
    return (
      <View style={s.contentFill}>
        <WebView
          source={{ uri: googleUrl }}
          style={s.contentFill}
          startInLoadingState
          renderLoading={() => (
            <View style={[s.centered, StyleSheet.absoluteFillObject, { backgroundColor: C.bg }]}>
              <SkeletonShimmer width={SW - 48} height={SH * 0.5} style={{ borderRadius: 12 }} />
              <Text style={[s.loadingText, { marginTop: 16 }]}>Rendering PDF...</Text>
            </View>
          )}
          onError={() => setError('Could not render PDF')}
          onLoadEnd={() => setLoading(false)}
        />
      </View>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Office docs via Google Docs Viewer
  // ══════════════════════════════════════════════════════════════
  const renderOffice = () => {
    const viewerUrl = `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(fileUri)}`;
    return (
      <View style={s.contentFill}>
        <WebView
          source={{ uri: viewerUrl }}
          style={s.contentFill}
          startInLoadingState
          renderLoading={() => (
            <View style={[s.centered, StyleSheet.absoluteFillObject, { backgroundColor: C.bg }]}>
              <SkeletonShimmer width={SW - 48} height={SH * 0.5} style={{ borderRadius: 12 }} />
              <Text style={[s.loadingText, { marginTop: 16 }]}>Loading document...</Text>
            </View>
          )}
          onError={() => setError('Could not render document')}
          onLoadEnd={() => setLoading(false)}
        />
      </View>
    );
  };

  // ══════════════════════════════════════════════════════════════
  // ██  RENDER: Text / Code viewer
  // ══════════════════════════════════════════════════════════════
  const renderText = () => {
    const lines = textContent.split('\n');
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    return (
      <ScrollView
        style={s.contentFill}
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
            onPress={(e) => {
              const x = e.nativeEvent.locationX;
              const ratio = x / (SW - 48);
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
            <Text style={s.audioBtnText}>⏪ 15s</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={toggleAudio} style={s.audioPlayBtn}>
            <LinearGradient
              colors={[C.primary, '#3B82F6']}
              style={s.audioPlayGradient}
            >
              <Text style={s.audioPlayIcon}>{audioPlaying ? '⏸' : '▶'}</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => seekAudio(Math.min(1, (audioPosition + 15000) / (audioDuration || 1)))}
            style={s.audioBtn}
          >
            <Text style={s.audioBtnText}>15s ⏩</Text>
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
          <TouchableOpacity onPress={() => router.back()} style={s.headerBtn}>
            <Text style={s.headerBtnIcon}>←</Text>
          </TouchableOpacity>

          {/* File info */}
          <View style={s.headerCenter}>
            <View style={s.headerFilenameRow}>
              <Text style={s.headerIcon}>{FILE_ICONS[fileType] || '📎'}</Text>
              <Text style={s.headerFilename} numberOfLines={1}>{fileName}</Text>
            </View>
            {fileSize > 0 && (
              <Text style={s.headerSize}>{formatBytes(fileSize)} · {fileType.toUpperCase()}</Text>
            )}
          </View>

          {/* Action buttons */}
          <TouchableOpacity onPress={handleShare} style={s.headerBtn}>
            <Text style={s.headerBtnIcon}>↗</Text>
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
