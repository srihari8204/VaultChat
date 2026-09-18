// app/video-player.tsx — World-class Video Player for crazzychat
// Full-featured playback: controls overlay, PiP, double-tap seek, pinch-zoom, swipe dismiss

import React, { useState, useEffect, useRef, useCallback , useMemo} from 'react';
import {
  View, Text, TouchableOpacity, TouchableWithoutFeedback, StyleSheet,
  StatusBar, ActivityIndicator, Dimensions, Animated, PanResponder,
  Platform, Share, useWindowDimensions } from 'react-native';
import { useTheme } from '../lib/theme';
import { type Palette } from '../constants/theme';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as Sharing from 'expo-sharing';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ACCENT = '#4A9FFF';
const BG = '#000000';
const OVERLAY = 'rgba(0,0,0,0.55)';
const SPEEDS = [0.5, 1, 1.25, 1.5, 2];

const formatTime = (ms: number) => {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec < 10 ? '0' : ''}${sec}`;
};

function useS() {
  // Reactive size. The module-level Dimensions.get above is captured ONCE at
  // import and never updates, so it froze the layout at the size the app
  // launched with. Shadowing it here makes every use in this component follow
  // rotation; StyleSheet.create keeps the initial value, which is fine for
  // static rules.
  const {width: SCREEN_W, height: SCREEN_H} = useWindowDimensions();

  const { colors } = useTheme();
  return useMemo(() => makeStyles(colors), [colors]);
}

export default function VideoPlayerScreen() {
  const { width: SCREEN_W, height: SCREEN_H } = useWindowDimensions();
  const { colors } = useTheme();
  const styles = useS();
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
  const [, setStatus] = useState<AVPlaybackStatus | null>(null);
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

  // Resume from last position
  useEffect(() => {
    if (!videoUri) return;
    const key = `vc_video_pos_${btoa(videoUri).substring(0, 40)}`;
    AsyncStorage.getItem(key).then(saved => {
      if (saved) {
        const pos = parseInt(saved, 10);
        if (pos > 1000 && videoRef.current) {
          videoRef.current.setPositionAsync(pos).catch(() => {});
        }
      }
    }).catch(() => {});
  }, [videoUri]);

  // Save position on unmount or pause
  useEffect(() => {
    return () => {
      if (videoUri && positionMs > 1000) {
        const key = `vc_video_pos_${btoa(videoUri).substring(0, 40)}`;
        AsyncStorage.setItem(key, String(positionMs)).catch(() => {});
      }
    };
  }, [videoUri, positionMs]);

  // PiP state
  const [pipActive, setPipActive] = useState(false);
  const pipPos = useRef(new Animated.ValueXY({ x: SCREEN_W - 180, y: SCREEN_H - 320 })).current;
  const pipPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { pipPos.extractOffset(); },
      onPanResponderMove: Animated.event([null, { dx: pipPos.x, dy: pipPos.y }], { useNativeDriver: false }),
      onPanResponderRelease: () => { pipPos.flattenOffset(); },
    })
  ).current;

  // Animations
  const playBtnScale = useRef(new Animated.Value(1)).current;
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const rippleLeftScale = useRef(new Animated.Value(0)).current;
  const rippleLeftOpacity = useRef(new Animated.Value(0)).current;
  const rippleRightScale = useRef(new Animated.Value(0)).current;
  const rippleRightOpacity = useRef(new Animated.Value(0)).current;
  const dismissY = useRef(new Animated.Value(0)).current;

  // Pinch-to-zoom
  const videoScale = useRef(new Animated.Value(1)).current;
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
  const onTouchStart = useCallback((e: any) => {
    if (e.nativeEvent.touches.length === 2) {
      const t = e.nativeEvent.touches;
      const dist = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      pinchRef.current = { active: true, initialDistance: dist };
      baseScale.current = (videoScale as any).__getValue ? (videoScale as any).__getValue() : 1;
    }
  }, [videoScale]);

  const onTouchMove = useCallback((e: any) => {
    if (pinchRef.current.active && e.nativeEvent.touches.length === 2) {
      const t = e.nativeEvent.touches;
      const dist = Math.hypot(t[1].pageX - t[0].pageX, t[1].pageY - t[0].pageY);
      const scale = Math.min(Math.max((dist / pinchRef.current.initialDistance) * baseScale.current, 0.5), 4);
      videoScale.setValue(scale);
    }
  }, [videoScale]);

  const onTouchEnd = useCallback(() => {
    if (pinchRef.current.active) {
      pinchRef.current.active = false;
      const current = (videoScale as any).__getValue ? (videoScale as any).__getValue() : 1;
      if (current < 1) {
        Animated.spring(videoScale, { toValue: 1, useNativeDriver: true }).start();
      }
    }
  }, [videoScale]);

  // --- Controls visibility ---
  const scheduleHideControls = useCallback(() => {
    if (controlsTimeout.current) clearTimeout(controlsTimeout.current);
    controlsTimeout.current = setTimeout(() => {
      if (isPlaying && !isSeeking) {
        Animated.timing(controlsOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(() => {
          setShowControls(false);
        });
      }
    }, 3000);
  }, [isPlaying, isSeeking, controlsOpacity]);

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
      setIsBuffering(true);
      return;
    }
    setStatus(s);
    setIsPlaying(s.isPlaying);
    setPositionMs(s.positionMillis || 0);
    setDurationMs(s.durationMillis || 0);
    setIsBuffering(s.isBuffering || false);
    setBufferedMs(s.playableDurationMillis || 0);
  }, []);

  const togglePlay = useCallback(async () => {
    if (!videoRef.current) return;
    // Animate play button
    Animated.sequence([
      Animated.timing(playBtnScale, { toValue: 0.7, duration: 100, useNativeDriver: true }),
      Animated.spring(playBtnScale, { toValue: 1, friction: 3, useNativeDriver: true }),
    ]).start();
    if (isPlaying) {
      await videoRef.current.pauseAsync();
    } else {
      await videoRef.current.playAsync();
    }
  }, [isPlaying, playBtnScale]);

  const seekRelative = useCallback(async (deltaMs: number) => {
    if (!videoRef.current) return;
    const newPos = Math.max(0, Math.min(positionMs + deltaMs, durationMs));
    await videoRef.current.setPositionAsync(newPos);
  }, [positionMs, durationMs]);

  const seekToPosition = useCallback(async (fraction: number) => {
    if (!videoRef.current || !durationMs) return;
    const newPos = Math.max(0, Math.min(fraction * durationMs, durationMs));
    await videoRef.current.setPositionAsync(newPos);
  }, [durationMs]);

  const cycleSpeed = useCallback(async () => {
    const nextIdx = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(nextIdx);
    if (videoRef.current) {
      await videoRef.current.setRateAsync(SPEEDS[nextIdx], true);
    }
  }, [speedIndex]);

  const toggleMute = useCallback(async () => {
    if (!videoRef.current) return;
    await videoRef.current.setIsMutedAsync(!isMuted);
    setIsMuted(!isMuted);
  }, [isMuted]);

  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    } else {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT);
    }
    setIsFullscreen(!isFullscreen);
  }, [isFullscreen]);

  const handleClose = useCallback(async () => {
    try { await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP); } catch {}
    router.back();
  }, [router]);

  const handleShare = useCallback(async () => {
    try {
      if (videoUri.startsWith('http')) {
        await Share.share({ url: videoUri, message: videoName });
      } else {
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) await Sharing.shareAsync(videoUri);
      }
    } catch {}
  }, [videoUri, videoName]);

  const activatePip = useCallback(() => {
    setPipActive(true);
  }, []);

  const deactivatePip = useCallback(() => {
    setPipActive(false);
  }, []);

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
  const seekPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        setIsSeeking(true);
        const frac = Math.max(0, Math.min(e.nativeEvent.locationX / seekBarWidth.current, 1));
        setSeekPosition(frac);
      },
      onPanResponderMove: (e) => {
        const frac = Math.max(0, Math.min(e.nativeEvent.locationX / seekBarWidth.current, 1));
        setSeekPosition(frac);
      },
      onPanResponderRelease: (e) => {
        const frac = Math.max(0, Math.min(e.nativeEvent.locationX / seekBarWidth.current, 1));
        seekToPosition(frac);
        setIsSeeking(false);
        scheduleHideControls();
      },
    })
  ).current;

  // Computed seek fraction
  const progress = durationMs > 0 ? (isSeeking ? seekPosition : positionMs / durationMs) : 0;
  const bufferedProgress = durationMs > 0 ? bufferedMs / durationMs : 0;
  const displayPosition = isSeeking ? seekPosition * durationMs : positionMs;
  const currentSpeed = SPEEDS[speedIndex];

  // ==================== PiP MODE ====================
  if (pipActive) {
    return (
      <Animated.View style={[styles.pipContainer, { transform: pipPos.getTranslateTransform() }]}
        {...pipPanResponder.panHandlers}>
        <Video
          ref={videoRef}
          source={{ uri: videoUri }}
          style={styles.pipVideo}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={isPlaying}
          isMuted={isMuted}
          onPlaybackStatusUpdate={onPlaybackStatusUpdate}
        />
        {/* Mini controls */}
        <View style={styles.pipOverlay}>
          <TouchableOpacity hitSlop={6} onPress={togglePlay} style={styles.pipPlayBtn}>
            <Text style={styles.pipPlayIcon}>{isPlaying ? '\u275A\u275A' : '\u25B6'}</Text>
          </TouchableOpacity>
          <TouchableOpacity hitSlop={8} onPress={() => { deactivatePip(); }} style={styles.pipExpandBtn}>
            <Text style={styles.pipExpandIcon}>{'\u2922'}</Text>
          </TouchableOpacity>
          <TouchableOpacity hitSlop={11} onPress={() => { videoRef.current?.stopAsync(); setPipActive(false); }}
            style={styles.pipCloseBtn}>
            <Text style={styles.pipCloseIcon}>{'\u2715'}</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    );
  }

  // NO SOURCE = NOTHING TO PLAY. Reached by a bare deep link, or a notification
  // whose file was revoked or expired. Without this the player drew a black
  // full-bleed surface with headerShown:false — no text, no control, no exit.
  // After the hooks, so hook order is unchanged.
  if (!videoUri) {
    return (
      <View style={[styles.container, { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StatusBar hidden />
        <Ionicons name="videocam-off-outline" size={44} color={colors.textDim} />
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700', textAlign: 'center' }}>
          Nothing to play
        </Text>
        <Text style={{ color: colors.textDim, fontSize: 14, textAlign: 'center' }}>
          This link carried no video, or the file is no longer available.
        </Text>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/chats' as any))}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          style={{ marginTop: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: '#1D4ED8' }}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go back</Text>
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
          ref={videoRef}
          source={{ uri: videoUri }}
          style={styles.video}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay
          isMuted={isMuted}
          rate={currentSpeed}
          progressUpdateIntervalMillis={250}
          onPlaybackStatusUpdate={onPlaybackStatusUpdate}
        />

        {/* Buffering spinner */}
        {isBuffering && (
          <View style={styles.bufferingOverlay}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        )}

        {/* Double-tap ripple left */}
        <Animated.View style={[styles.ripple, styles.rippleLeft, {
          opacity: rippleLeftOpacity,
          transform: [{ scale: rippleLeftScale.interpolate({ inputRange: [0, 1], outputRange: [0.3, 2.5] }) }],
        }]}>
          <Text style={styles.rippleText}>{'\u25C0\u25C0'} 10s</Text>
        </Animated.View>

        {/* Double-tap ripple right */}
        <Animated.View style={[styles.ripple, styles.rippleRight, {
          opacity: rippleRightOpacity,
          transform: [{ scale: rippleRightScale.interpolate({ inputRange: [0, 1], outputRange: [0.3, 2.5] }) }],
        }]}>
          <Text style={styles.rippleText}>10s {'\u25B6\u25B6'}</Text>
        </Animated.View>

        {/* Tap zones for double-tap detection */}
        <View style={styles.tapZoneContainer} pointerEvents="box-none">
          <TouchableWithoutFeedback onPress={() => handleAreaTap('left')}>
            <View style={styles.tapZoneLeft} />
          </TouchableWithoutFeedback>
          <TouchableWithoutFeedback onPress={() => handleAreaTap('right')}>
            <View style={styles.tapZoneRight} />
          </TouchableWithoutFeedback>
        </View>

        {/* Controls overlay */}
        {showControls && (
          <Animated.View style={[styles.controlsOverlay, { opacity: controlsOpacity }]}>
            {/* Top bar */}
            <View style={styles.topBar}>
              <TouchableOpacity onPress={handleClose} style={styles.topBtn}>
                <Text style={styles.topBtnIcon}>{'\u2190'}</Text>
              </TouchableOpacity>
              <Text style={styles.titleText} numberOfLines={1}>{videoName}</Text>
              <View style={styles.topRight}>
                <TouchableOpacity onPress={handleShare} style={styles.topBtn}>
                  <Text style={styles.topBtnIcon}>{'\u2B06'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Center controls */}
            <View style={styles.centerControls}>
              <TouchableOpacity onPress={() => seekRelative(-10000)} style={styles.sideBtn}>
                <Text style={styles.sideBtnIcon}>{'\u25C0\u25C0'}</Text>
                <Text style={styles.sideBtnLabel}>10</Text>
              </TouchableOpacity>

              <Animated.View style={{ transform: [{ scale: playBtnScale }] }}>
                <TouchableOpacity onPress={togglePlay} style={styles.playBtn}>
                  <Text style={styles.playBtnIcon}>{isPlaying ? '\u275A\u275A' : '\u25B6'}</Text>
                </TouchableOpacity>
              </Animated.View>

              <TouchableOpacity onPress={() => seekRelative(10000)} style={styles.sideBtn}>
                <Text style={styles.sideBtnIcon}>{'\u25B6\u25B6'}</Text>
                <Text style={styles.sideBtnLabel}>10</Text>
              </TouchableOpacity>
            </View>

            {/* Bottom bar */}
            <View style={styles.bottomBar}>
              {/* Time + seek */}
              <View style={styles.timeRow}>
                <Text style={styles.timeText}>{formatTime(displayPosition)}</Text>
                <View style={styles.seekBarOuter}
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
                <TouchableOpacity onPress={toggleMute} style={styles.bottomActionBtn}>
                  <Text style={[styles.bottomActionIcon, isMuted && styles.activeIcon]}>
                    {isMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={cycleSpeed} style={styles.speedBtn}>
                  <Text style={[styles.speedText, currentSpeed !== 1 && styles.activeText]}>
                    {currentSpeed}x
                  </Text>
                </TouchableOpacity>

                {currentSpeed !== 1 && (
                  <View style={styles.speedBadge}>
                    <Text style={styles.speedBadgeText}>{currentSpeed}x</Text>
                  </View>
                )}

                <TouchableOpacity onPress={activatePip} style={styles.bottomActionBtn}>
                  <Text style={styles.bottomActionText}>PiP</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={toggleFullscreen} style={styles.bottomActionBtn}>
                  <Text style={[styles.bottomActionIcon, isFullscreen && styles.activeIcon]}>
                    {isFullscreen ? '\u2922' : '\u26F6'}
                  </Text>
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
const makeStyles = (c: Palette) => StyleSheet.create({
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
    color: c.text,
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
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
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
  topBtnIcon: {
    color: c.text,
    fontSize: 24,
    fontWeight: '700',
  },
  titleText: {
    flex: 1,
    color: c.text,
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
    backgroundColor: 'rgba(0,229,255,0.25)',
    borderWidth: 2.5,
    borderColor: ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playBtnIcon: {
    color: c.text,
    fontSize: 28,
    fontWeight: '800',
  },
  sideBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sideBtnIcon: {
    color: c.text,
    fontSize: 14,
    fontWeight: '700',
  },
  sideBtnLabel: {
    color: c.text,
    fontSize: 11,
    fontWeight: '600',
    marginTop: -2,
  },

  // Bottom bar
  bottomBar: {
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
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
  bottomActionIcon: {
    color: c.text,
    fontSize: 20,
  },
  bottomActionText: {
    color: c.text,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  activeIcon: {
    color: ACCENT,
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
    color: c.text,
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

  // PiP
  pipContainer: {
    position: 'absolute',
    width: 170,
    height: 100,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: BG,
    borderWidth: 1.5,
    borderColor: ACCENT,
    zIndex: 9999,
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
  },
  pipVideo: {
    width: '100%',
    height: '100%',
  },
  pipOverlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    gap: 12,
  },
  pipPlayBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,229,255,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipPlayIcon: {
    color: c.text,
    fontSize: 12,
    fontWeight: '800',
  },
  pipExpandBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipExpandIcon: {
    color: c.text,
    fontSize: 16,
  },
  pipCloseBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,60,60,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipCloseIcon: {
    color: c.text,
    fontSize: 12,
    fontWeight: '800',
  },
});
