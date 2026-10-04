// app/video-player.tsx — full-screen video player.
// Controls overlay, seekable track, double-tap seek, pinch-zoom, swipe-down dismiss.
// No picture-in-picture: expo-av (the installed player) has no system PiP API,
// and the old in-app "mini player" mounted a second <Video> that restarted
// playback, so it was removed rather than kept as a fake.

import React, { useState, useEffect, useRef, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, TouchableWithoutFeedback, StyleSheet,
  StatusBar, ActivityIndicator, Animated, PanResponder, Alert, AccessibilityInfo,
  useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { seekFraction, seekTargetMs, resumeKey } from '../lib/videoSeek';
import { videoResumeKey } from '../lib/media/videoResumeKey';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { getAccessToken } from '../lib/api';
import { isOwnServerUrl } from '../lib/serverOrigin';
import { VIEWER_TEMP_PREFIX } from '../lib/mediaCacheGC';

// Fixed palette, deliberately not theme tokens: the video stage is black in
// both themes, so the chrome on it must stay light-on-dark.
const ACCENT = '#4A9FFF';
const ACCENT_FILL = 'rgba(74,159,255,0.25)';   // ACCENT, translucent, behind the play icon
const BG = '#000000';
const CTA = '#1D4ED8'; // 6.7:1 under white text
const OVERLAY = 'rgba(0,0,0,0.55)';
// Controls sit on the fixed black stage + OVERLAY in BOTH themes, so they use
// a fixed light foreground. c.text is #1B1526 in light theme — invisible here.
const FG = '#FFFFFF';
const FG_DIM = 'rgba(255,255,255,0.75)';
const SPEEDS = [0.5, 1, 1.25, 1.5, 2];

const formatTime = (ms: number) => {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
};

// A render crash in the player (a bad status payload, a native view error)
// lands on a recoverable screen instead of taking the app down.
export default function VideoPlayerScreen() {
  return (
    <ErrorBoundary screen="VideoPlayerScreen" fallbackTitle="Video player error" fallbackMessage="This video could not be played.">
      <VideoPlayerInner />
    </ErrorBoundary>
  );
}

function VideoPlayerInner() {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(insets.top, insets.bottom), [insets.top, insets.bottom]);
  const router = useRouter();
  const { uri, filename } = useLocalSearchParams();
  const videoUri = (uri || '') + '';
  const videoName = (filename || 'Video') + '';

  // Refs
  const videoRef = useRef<Video>(null);
  const controlsTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapLeft = useRef(0);
  const lastTapRight = useRef(0);

  // Playback state
  const [isPlaying, setIsPlaying] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [isBuffering, setIsBuffering] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1); // index into SPEEDS (1 = 1x)
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPosition, setSeekPosition] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Live values for callbacks that are created once (the seek PanResponder):
  // reading state there would capture the first render, where duration is 0.
  const durationRef = useRef(0);
  const positionRef = useRef(0);

  // Resume from the last position. Read on mount, APPLIED once the video has
  // loaded: a seek issued before that is dropped by the player, so the old
  // mount-time seek mostly did nothing. Applied once per file — from onLoad,
  // from the first loaded status update, or at once when storage answers
  // after either (loadedRef), so no ordering of the three misses it.
  const resumeAt = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const applyResume = useCallback(() => {
    loadedRef.current = true;
    const pos = resumeAt.current;
    resumeAt.current = null;
    if (pos != null && videoRef.current) videoRef.current.setPositionAsync(pos).catch(() => {});
  }, []);
  useEffect(() => {
    resumeAt.current = null;
    loadedRef.current = false;
    if (!videoUri) return;
    // The old key (lib/videoSeek.resumeKey) kept a readable prefix of the path
    // and was shared by every video in the same folder: drop it.
    AsyncStorage.removeItem(resumeKey(videoUri)).catch(() => {});
    AsyncStorage.getItem(videoResumeKey(videoUri)).then(saved => {
      const pos = saved ? parseInt(saved, 10) : 0;
      if (pos > 1000) {
        resumeAt.current = pos;
        // Already loaded by the time storage answered: seek now.
        if (loadedRef.current) applyResume();
      }
    }).catch(() => {});
  }, [videoUri, applyResume]);

  // Save the resume position on pause and on unmount only. Keying the cleanup
  // on positionMs re-ran it on every 250 ms progress tick (~4 writes/s).
  const saveResume = useCallback(() => {
    if (videoUri && positionRef.current > 1000) {
      AsyncStorage.setItem(videoResumeKey(videoUri), String(positionRef.current)).catch(() => {});
    }
  }, [videoUri]);
  useEffect(() => () => saveResume(), [saveResume]);
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (wasPlaying.current && !isPlaying) saveResume();
    wasPlaying.current = isPlaying;
  }, [isPlaying, saveResume]);

  // Never leave the app locked in landscape: hardware back skips handleClose.
  useEffect(() => () => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
  }, []);

  // Animations
  const playBtnScale = useRef(new Animated.Value(1)).current;
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const rippleLeftScale = useRef(new Animated.Value(0)).current;
  const rippleLeftOpacity = useRef(new Animated.Value(0)).current;
  const rippleRightScale = useRef(new Animated.Value(0)).current;
  const rippleRightOpacity = useRef(new Animated.Value(0)).current;
  const dismissY = useRef(new Animated.Value(0)).current;

  // Pinch-to-zoom. scaleRef mirrors the value we last set, so reading the
  // current zoom needs no private Animated API.
  const videoScale = useRef(new Animated.Value(1)).current;
  const scaleRef = useRef(1);
  const baseScale = useRef(1);
  const pinchRef = useRef({ active: false, initialDistance: 0 });

  // Swipe-to-dismiss pan responder
  const dismissPanResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        // Only respond to vertical swipes (not horizontal seeks), and not during pinch
        return !pinchRef.current.active && Math.abs(g.dy) > 15 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5;
      },
      onPanResponderMove: (_, g) => { dismissY.setValue(g.dy); },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 120) {
          // Swipe down far enough — dismiss
          Animated.timing(dismissY, { toValue: SCREEN_H, duration: 250, useNativeDriver: true }).start(() => {
            handleClose();
          });
        } else {
          Animated.spring(dismissY, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  // Pinch gesture via touch events on the wrapper
  const onTouchStart = useCallback((e: GestureResponderEvent) => {
    if (e.nativeEvent.touches.length === 2) {
      const t = e.nativeEvent.touches;
      const dist = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      pinchRef.current = { active: true, initialDistance: dist };
      baseScale.current = scaleRef.current;
    }
  }, []);

  const onTouchMove = useCallback((e: GestureResponderEvent) => {
    if (pinchRef.current.active && e.nativeEvent.touches.length === 2) {
      const t = e.nativeEvent.touches;
      const dist = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      const scale = Math.min(Math.max((dist / pinchRef.current.initialDistance) * baseScale.current, 0.5), 4);
      scaleRef.current = scale;
      videoScale.setValue(scale);
    }
  }, [videoScale]);

  const onTouchEnd = useCallback(() => {
    if (pinchRef.current.active) {
      pinchRef.current.active = false;
      if (scaleRef.current < 1) {
        scaleRef.current = 1;
        Animated.spring(videoScale, { toValue: 1, useNativeDriver: true }).start();
      }
    }
  }, [videoScale]);

  // --- Controls visibility ---
  // A screen-reader user cannot tap an invisible overlay back into view, so
  // the controls never auto-hide while one is running.
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled().then(v => { if (alive) setScreenReader(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', v => { if (alive) setScreenReader(!!v); });
    return () => { alive = false; sub.remove(); };
  }, []);
  useEffect(() => {
    if (!screenReader) return;
    if (controlsTimeout.current) clearTimeout(controlsTimeout.current);
    controlsOpacity.stopAnimation();
    controlsOpacity.setValue(1);
    setShowControls(true);
  }, [screenReader, showControls, controlsOpacity]);
  const scheduleHideControls = useCallback(() => {
    if (controlsTimeout.current) clearTimeout(controlsTimeout.current);
    if (screenReader) return;
    controlsTimeout.current = setTimeout(() => {
      if (isPlaying && !isSeeking) {
        Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
          setShowControls(false);
        });
      }
    }, 3000);
  }, [isPlaying, isSeeking, controlsOpacity, screenReader]);

  const toggleControls = useCallback(() => {
    if (showControls) {
      Animated.timing(controlsOpacity, { toValue: 0, duration: 250, useNativeDriver: true }).start(() => {
        setShowControls(false);
      });
    } else {
      setShowControls(true);
      controlsOpacity.setValue(0);
      Animated.timing(controlsOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
      scheduleHideControls();
    }
  }, [showControls, scheduleHideControls, controlsOpacity]);

  useEffect(() => {
    if (showControls && isPlaying) scheduleHideControls();
    return () => { if (controlsTimeout.current) clearTimeout(controlsTimeout.current); };
  }, [showControls, isPlaying, scheduleHideControls]);

  // --- Playback handlers ---
  const onPlaybackStatusUpdate = useCallback((s: AVPlaybackStatus) => {
    if (!s.isLoaded) {
      if ('error' in s && s.error) { setLoadError(String(s.error)); setIsBuffering(false); return; }
      setIsBuffering(true);
      return;
    }
    if (!loadedRef.current || resumeAt.current != null) applyResume();
    positionRef.current = s.positionMillis || 0;
    durationRef.current = s.durationMillis || 0;
    setIsPlaying(s.isPlaying);
    setPositionMs(s.positionMillis || 0);
    setDurationMs(s.durationMillis || 0);
    setIsBuffering(s.isBuffering || false);
    setBufferedMs(s.playableDurationMillis || 0);
  }, [applyResume]);

  const togglePlay = useCallback(async () => {
    if (!videoRef.current) return;
    // Animate play button
    Animated.sequence([
      Animated.timing(playBtnScale, { toValue: 0.7, duration: 100, useNativeDriver: true }),
      Animated.spring(playBtnScale, { toValue: 1, friction: 3, useNativeDriver: true }),
    ]).start();
    // A rejected play/pause (player torn down mid-tap) must not surface as an
    // unhandled rejection; the status callback reports real load failures.
    await (isPlaying ? videoRef.current.pauseAsync() : videoRef.current.playAsync()).catch(() => {});
  }, [isPlaying, playBtnScale]);

  const seekRelative = useCallback(async (deltaMs: number) => {
    if (!videoRef.current) return;
    const newPos = Math.max(0, Math.min(positionMs + deltaMs, durationMs));
    await videoRef.current.setPositionAsync(newPos).catch(() => {});
  }, [positionMs, durationMs]);

  // Reads the live duration from a ref, so it is stable and safe to call from
  // the once-created seek PanResponder below.
  const seekToPosition = useCallback(async (fraction: number) => {
    const target = seekTargetMs(fraction, durationRef.current);
    if (!videoRef.current || target === null) return;
    await videoRef.current.setPositionAsync(target).catch(() => {});
  }, []);

  // Like togglePlay: a torn-down player (or a refused orientation lock) must
  // not surface as an unhandled rejection, and the UI state changes only when
  // the call succeeded, so the button never shows a state the player is not in.
  const cycleSpeed = useCallback(async () => {
    const nextIdx = (speedIndex + 1) % SPEEDS.length;
    try {
      if (videoRef.current) await videoRef.current.setRateAsync(SPEEDS[nextIdx], true);
      setSpeedIndex(nextIdx);
    } catch { /* speed unchanged */ }
  }, [speedIndex]);

  const toggleMute = useCallback(async () => {
    if (!videoRef.current) return;
    try {
      await videoRef.current.setIsMutedAsync(!isMuted);
      setIsMuted(!isMuted);
    } catch { /* mute unchanged */ }
  }, [isMuted]);

  const toggleFullscreen = useCallback(async () => {
    try {
      await ScreenOrientation.lockAsync(isFullscreen
        ? ScreenOrientation.OrientationLock.PORTRAIT_UP
        : ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT);
      setIsFullscreen(!isFullscreen);
    } catch { /* orientation unchanged */ }
  }, [isFullscreen]);

  const handleClose = useCallback(async () => {
    try { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); } catch {}
    router.back();
  }, [router]);

  // Share the FILE, not a link: a remote video is downloaded first (with the
  // bearer token only for our own server), into a vt_share_ dir that
  // lib/mediaCacheGC sweeps at boot/logout — the receiving app may still be
  // reading it after the sheet closes, so it is not deleted here.
  const [sharing, setSharing] = useState(false);
  const handleShare = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device has no app to share the video with.');
        return;
      }
      let local = videoUri;
      if (/^https?:/i.test(videoUri)) {
        const dir = (FileSystem.cacheDirectory || '') + VIEWER_TEMP_PREFIX + 'share_' + Date.now() + '/';
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
        const name = videoName.replace(/[/\\:*?"<>|]/g, '_') || 'video';
        const token = isOwnServerUrl(videoUri) ? await getAccessToken() : null;
        const res = await FileSystem.downloadAsync(videoUri, dir + name,
          token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (res.status >= 400) throw new Error('GET ' + res.status);
        local = res.uri;
      }
      await Sharing.shareAsync(local);
    } catch (e: unknown) {
      console.warn('[video-player] share failed:', e instanceof Error ? e.message : e);
      Alert.alert("Couldn't share video", 'Check your connection and try again.');
    } finally {
      setSharing(false);
    }
  }, [videoUri, videoName, sharing]);

  // --- Double tap detection ---
  const handleAreaTap = useCallback((side: 'left' | 'right') => {
    const fireRipple = (s: 'left' | 'right') => {
      const scaleAnim = s === 'left' ? rippleLeftScale : rippleRightScale;
      const opacityAnim = s === 'left' ? rippleLeftOpacity : rippleRightOpacity;
      scaleAnim.setValue(0);
      opacityAnim.setValue(0.5);
      Animated.parallel([
        Animated.timing(scaleAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(opacityAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start();
    };
    const now = Date.now();
    const lastTap = side === 'left' ? lastTapLeft : lastTapRight;
    if (now - lastTap.current < 300) {
      // Double tap
      if (side === 'left') {
        seekRelative(-10000);
        fireRipple('left');
      } else {
        seekRelative(10000);
        fireRipple('right');
      }
      lastTap.current = 0;
    } else {
      lastTap.current = now;
      // Single tap — toggle controls after brief delay
      setTimeout(() => {
        if (Date.now() - lastTap.current >= 280) {
          toggleControls();
        }
      }, 300);
    }
  }, [seekRelative, toggleControls, rippleLeftScale, rippleRightScale, rippleLeftOpacity, rippleRightOpacity]);

  // --- Seek bar pan responder ---
  const seekBarWidth = useRef(SCREEN_W - 120);
  // Created once, so it calls the latest scheduleHideControls through a ref.
  const scheduleHideRef = useRef(scheduleHideControls);
  scheduleHideRef.current = scheduleHideControls;
  const seekPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        setIsSeeking(true);
        setSeekPosition(seekFraction(e.nativeEvent.locationX, seekBarWidth.current));
      },
      onPanResponderMove: (e) => {
        setSeekPosition(seekFraction(e.nativeEvent.locationX, seekBarWidth.current));
      },
      onPanResponderRelease: (e) => {
        seekToPosition(seekFraction(e.nativeEvent.locationX, seekBarWidth.current));
        setIsSeeking(false);
        scheduleHideRef.current();
      },
      onPanResponderTerminate: () => { setIsSeeking(false); },
    })
  ).current;

  // Computed seek fraction
  const progress = durationMs > 0 ? (isSeeking ? seekPosition : positionMs / durationMs) : 0;
  const bufferedProgress = durationMs > 0 ? bufferedMs / durationMs : 0;
  const displayPosition = isSeeking ? seekPosition * durationMs : positionMs;
  const currentSpeed = SPEEDS[speedIndex];

  // NO SOURCE = NOTHING TO PLAY. Reached by a bare deep link, or a notification
  // whose file was revoked or expired. Without this the player drew a black
  // full-bleed surface with headerShown:false — no text, no control, no exit.
  // After the hooks, so hook order is unchanged.
  if (!videoUri) {
    return (
      <View style={[styles.container, styles.stateBox]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StatusBar hidden />
        <Ionicons name="videocam-off-outline" size={44} color={FG_DIM} />
        <Text accessibilityRole="header" style={styles.stateTitle}>Nothing to play</Text>
        <Text style={styles.stateBody}>This link carried no video, or the file is no longer available.</Text>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats'))}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={[styles.stateBtn, styles.stateBtnTop]}
        >
          <Text style={styles.stateBtnTxt}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ==================== FULL PLAYER ====================
  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden />

      <Animated.View
        style={[styles.fullscreenWrap, { transform: [{ translateY: dismissY }, { scale: videoScale }] }]}
        {...dismissPanResponder.panHandlers}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Video */}
        <Video
          key={reloadKey}
          ref={videoRef}
          source={{ uri: videoUri }}
          style={styles.video}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isMuted={isMuted}
          rate={currentSpeed}
          progressUpdateIntervalMillis={250}
          onPlaybackStatusUpdate={onPlaybackStatusUpdate}
          onLoad={applyResume}
          onError={(e) => { setLoadError(String(e || 'unknown')); setIsBuffering(false); }}
        />

        {/* Buffering spinner */}
        {isBuffering && !loadError && (
          <View style={styles.bufferingOverlay}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        )}

        {/* Load failure: a bad or expired file used to spin forever. */}
        {loadError && (
          <View style={[styles.bufferingOverlay, styles.stateBox]} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle-outline" size={44} color={FG} />
            <Text accessibilityRole="header" style={styles.stateTitle}>{"Can't play this video"}</Text>
            <Text style={styles.stateBody}>The file may be damaged, in an unsupported format, or no longer available.</Text>
            <View style={styles.stateRow}>
              <TouchableOpacity
                onPress={() => { setLoadError(null); setIsBuffering(true); setReloadKey(k => k + 1); }}
                accessibilityRole="button" accessibilityLabel="Retry loading the video"
                style={styles.stateBtn}
              >
                <Text style={styles.stateBtnTxt}>Retry</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleClose}
                accessibilityRole="button" accessibilityLabel="Close video player"
                style={[styles.stateBtn, styles.stateBtnGhost]}
              >
                <Text style={styles.stateBtnTxt}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Double-tap ripple left */}
        <Animated.View style={[styles.ripple, styles.rippleLeft, {
          opacity: rippleLeftOpacity,
          transform: [{ scale: rippleLeftScale.interpolate({ inputRange: [0, 1], outputRange: [0.3, 2.5] }) }],
        }]}>
          <Ionicons name="play-back" size={18} color={FG} />
          <Text style={styles.rippleText}>10s</Text>
        </Animated.View>

        {/* Double-tap ripple right */}
        <Animated.View style={[styles.ripple, styles.rippleRight, {
          opacity: rippleRightOpacity,
          transform: [{ scale: rippleRightScale.interpolate({ inputRange: [0, 1], outputRange: [0.3, 2.5] }) }],
        }]}>
          <Ionicons name="play-forward" size={18} color={FG} />
          <Text style={styles.rippleText}>10s</Text>
        </Animated.View>

        {/* Tap zones for double-tap detection */}
        <View style={styles.tapZoneContainer} pointerEvents="box-none">
          <TouchableWithoutFeedback onPress={() => handleAreaTap('left')}
            accessibilityRole="button" accessibilityLabel="Show or hide controls"
            accessibilityHint="Double-tap quickly to rewind 10 seconds">
            <View style={styles.tapZoneLeft} />
          </TouchableWithoutFeedback>
          <TouchableWithoutFeedback onPress={() => handleAreaTap('right')}
            accessibilityRole="button" accessibilityLabel="Show or hide controls"
            accessibilityHint="Double-tap quickly to skip forward 10 seconds">
            <View style={styles.tapZoneRight} />
          </TouchableWithoutFeedback>
        </View>

        {/* Controls overlay */}
        {showControls && (
          <Animated.View style={[styles.controlsOverlay, { opacity: controlsOpacity }]}>
            {/* Top bar */}
            <View style={styles.topBar}>
              <TouchableOpacity onPress={handleClose} style={styles.topBtn}
                accessibilityRole="button" accessibilityLabel="Close video player">
                <Ionicons name="arrow-back" size={24} color={FG} />
              </TouchableOpacity>
              <Text style={styles.titleText} numberOfLines={1}>{videoName}</Text>
              <View style={styles.topRight}>
                <TouchableOpacity onPress={handleShare} style={styles.topBtn} disabled={sharing}
                  accessibilityRole="button" accessibilityLabel="Share video"
                  accessibilityState={{ busy: sharing, disabled: sharing }}>
                  {sharing
                    ? <ActivityIndicator color={FG} />
                    : <Ionicons name="share-outline" size={22} color={FG} />}
                </TouchableOpacity>
              </View>
            </View>

            {/* Center controls */}
            <View style={styles.centerControls}>
              <TouchableOpacity onPress={() => seekRelative(-10000)} style={styles.sideBtn}
                accessibilityRole="button" accessibilityLabel="Back 10 seconds">
                <Ionicons name="play-back" size={16} color={FG} />
                <Text style={styles.sideBtnLabel}>10</Text>
              </TouchableOpacity>

              <Animated.View style={{ transform: [{ scale: playBtnScale }] }}>
                <TouchableOpacity onPress={togglePlay} style={styles.playBtn}
                  accessibilityRole="button" accessibilityLabel={isPlaying ? 'Pause' : 'Play'}>
                  <Ionicons name={isPlaying ? 'pause' : 'play'} size={30} color={FG} />
                </TouchableOpacity>
              </Animated.View>

              <TouchableOpacity onPress={() => seekRelative(10000)} style={styles.sideBtn}
                accessibilityRole="button" accessibilityLabel="Forward 10 seconds">
                <Ionicons name="play-forward" size={16} color={FG} />
                <Text style={styles.sideBtnLabel}>10</Text>
              </TouchableOpacity>
            </View>

            {/* Bottom bar */}
            <View style={styles.bottomBar}>
              {/* Time + seek */}
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>{formatTime(displayPosition)}</Text>
                <View style={styles.seekBarOuter}
                  accessible
                  accessibilityRole="adjustable"
                  accessibilityLabel="Seek"
                  accessibilityValue={{ text: `${formatTime(displayPosition)} of ${formatTime(durationMs)}` }}
                  accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                  onAccessibilityAction={(e) => seekRelative(e.nativeEvent.actionName === 'increment' ? 10000 : -10000)}
                  onLayout={(e) => { seekBarWidth.current = e.nativeEvent.layout.width; }}
                  {...seekPanResponder.panHandlers}
                >
                  {/* Buffered track */}
                  <View style={[styles.seekBuffered, { width: `${bufferedProgress * 100}%` }]} />
                  {/* Progress track */}
                  <View style={[styles.seekProgress, { width: `${progress * 100}%` }]} />
                  {/* Thumb */}
                  <Animated.View style={[styles.seekThumb, { left: `${progress * 100}%` }]} />
                </View>
                <Text style={styles.timeText}>-{formatTime(durationMs - displayPosition)}</Text>
              </View>

              {/* Bottom buttons row */}
              <View style={styles.bottomBtns}>
                <TouchableOpacity onPress={toggleMute} style={styles.bottomActionBtn}
                  accessibilityRole="switch" accessibilityLabel="Mute" accessibilityState={{ checked: isMuted }}>
                  <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={22} color={isMuted ? ACCENT : FG} />
                </TouchableOpacity>

                <TouchableOpacity onPress={cycleSpeed} style={styles.speedBtn}
                  accessibilityRole="button" accessibilityLabel={`Playback speed ${currentSpeed}x, change speed`}>
                  <Text style={[styles.speedText, currentSpeed !== 1 && styles.activeText]}>
                    {currentSpeed}x
                  </Text>
                </TouchableOpacity>

                {currentSpeed !== 1 && (
                  <View style={styles.speedBadge}>
                    <Text style={styles.speedBadgeText}>{currentSpeed}x</Text>
                  </View>
                )}

                <TouchableOpacity onPress={toggleFullscreen} style={styles.bottomActionBtn}
                  accessibilityRole="button" accessibilityLabel={isFullscreen ? 'Exit full screen' : 'Full screen'}>
                  <Ionicons name={isFullscreen ? 'contract' : 'expand'} size={22} color={isFullscreen ? ACCENT : FG} />
                </TouchableOpacity>
              </View>
            </View>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

// ============================== STYLES ==============================
const makeStyles = (insetTop: number, insetBottom: number) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: BG,
  },
  fullscreenWrap: {
    flex: 1,
    backgroundColor: BG,
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
  },

  // Buffering
  bufferingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },

  // Ripple animations
  ripple: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rippleLeft: {
    left: '15%',
    top: '40%',
  },
  rippleRight: {
    right: '15%',
    top: '40%',
  },
  rippleText: {
    color: FG,
    fontSize: 14,
    fontWeight: '700',
  },

  // Tap zones
  tapZoneContainer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  tapZoneLeft: {
    flex: 1,
  },
  tapZoneRight: {
    flex: 1,
  },

  // Controls overlay
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: insetTop + 8,
    paddingHorizontal: 12,
    paddingBottom: 12,
    backgroundColor: OVERLAY,
  },
  topBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleText: {
    flex: 1,
    color: FG,
    fontSize: 16,
    fontWeight: '600',
    marginHorizontal: 8,
  },
  topRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  // Center controls
  centerControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 48,
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: ACCENT_FILL,
    borderWidth: 2.5,
    borderColor: ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideBtnLabel: {
    color: FG,
    fontSize: 11,
    fontWeight: '600',
    marginTop: -2,
  },

  // Bottom bar
  bottomBar: {
    paddingBottom: insetBottom + 16,
    paddingHorizontal: 16,
    backgroundColor: OVERLAY,
    paddingTop: 12,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  timeText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    width: 44,
    textAlign: 'center',
  },
  seekBarOuter: {
    // layout-exempt: a seek TRACK — the 28 is touch slop around a 3dp bar, and
    // the only text on this row (elapsed/total) lives outside it.
    flex: 1,
    height: 28,
    justifyContent: 'center',
    marginHorizontal: 8,
  },
  seekBuffered: {
    position: 'absolute',
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 1.5,
  },
  seekProgress: {
    position: 'absolute',
    height: 3,
    backgroundColor: ACCENT,
    borderRadius: 1.5,
  },
  seekThumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: ACCENT,
    marginLeft: -7,
    top: 7,
    shadowColor: ACCENT,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 6,
    elevation: 4,
  },

  // Bottom buttons
  bottomBtns: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  bottomActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  activeText: {
    color: ACCENT,
  },
  speedBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  speedText: {
    color: FG,
    fontSize: 14,
    fontWeight: '700',
  },
  speedBadge: {
    position: 'absolute',
    top: -8,
    left: '50%',
    backgroundColor: ACCENT,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  speedBadgeText: {
    color: BG,
    fontSize: 10,
    fontWeight: '800',
  },

  // "Nothing to play" and the load-error overlay
  stateBox: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  stateTitle: { color: FG, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  stateBody: { color: FG_DIM, fontSize: 14, textAlign: 'center' },
  stateRow: { flexDirection: 'row', gap: 12, marginTop: 8 },
  stateBtn: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: CTA },
  stateBtnTop: { marginTop: 8 },
  stateBtnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  stateBtnTxt: { color: FG, fontWeight: '700' },
});
