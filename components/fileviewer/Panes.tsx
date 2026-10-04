// components/fileviewer/Panes.tsx — the content panes of app/file-viewer.tsx.
//
// The screen owns loading (download, windowed text reads, document parsing,
// audio) and hand-off; these only draw what it hands them. Split out of the
// 1,500-line screen without changing what any pane shows or does.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Easing, FlatList, ScrollView, StyleSheet, Text,
  TouchableOpacity, View, useWindowDimensions, type StyleProp, type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { Block } from '../../lib/docBlocks';
import { DocView } from '../DocView';
import { ZoomableImage } from '../media/ZoomableImage';
import { formatBytes, formatDuration, type FileKind } from './fileTypes';
import { C, CTA_GRADIENT, paperColors, s } from './styles';

// ── Skeleton shimmer ─────────────────────────────────────────────
function SkeletonShimmer({ width: w, height: h, style }: { width?: number; height?: number; style?: StyleProp<ViewStyle> }) {
  // Live window width: a module-level Dimensions.get froze it at launch size.
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

export function LoadingPane({ fileType }: { fileType: FileKind }) {
  const { width: SW, height: SH } = useWindowDimensions();
  return (
    <View style={[s.centered, s.loadingPane]}>
      <SkeletonShimmer width={SW * 0.7} height={16} style={{ borderRadius: 8 }} />
      <SkeletonShimmer width={SW * 0.85} height={SH * 0.35} style={{ borderRadius: 12, marginTop: 8 }} />
      <SkeletonShimmer width={SW * 0.5} height={14} style={{ borderRadius: 8, marginTop: 8 }} />
      <SkeletonShimmer width={SW * 0.6} height={14} style={{ borderRadius: 8 }} />
      <Text style={[s.loadingText, s.loadingCaption]}>Loading {fileType}...</Text>
    </View>
  );
}

// ── Image ────────────────────────────────────────────────────────
export function ImagePane({ uri, fileName, onLoaded, onFail }: {
  uri: string; fileName: string; onLoaded: () => void; onFail: (msg: string) => void;
}) {
  return (
    <View style={[s.contentFill, { backgroundColor: C.bgPure }]}>
      <ZoomableImage source={{ uri }} spinnerColor={C.accent} label={fileName}
        onLoaded={onLoaded}
        onFail={() => onFail("This image couldn't be shown. It may be damaged or in a format this device can't display.")} />
      {/* Glassmorphic filename overlay */}
      <View style={s.imageOverlay} pointerEvents="none">
        <View style={s.glassChip}>
          <Text style={s.glassChipText} numberOfLines={1}>{fileName}</Text>
        </View>
      </View>
    </View>
  );
}

// ── "Read here, or hand off" bar shared by PDF, documents and text ──
export function DocActionBar({ hint, opening, onOpen }: { hint: string; opening: boolean; onOpen: () => void }) {
  return (
    <View style={s.docActionBar}>
      <Text style={s.docActionHint} numberOfLines={1}>{hint}</Text>
      <TouchableOpacity
        onPress={onOpen}
        disabled={opening}
        style={s.docActionBtn}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Open in another app"
        accessibilityState={{ busy: opening, disabled: opening }}
      >
        {opening
          ? <ActivityIndicator color={C.accent} size="small" />
          : <>
              <Ionicons name="open-outline" size={16} color={C.accent} />
              <Text style={s.docActionTxt}>Open in another app</Text>
            </>}
      </TouchableOpacity>
    </View>
  );
}

// ── Document hand-off card ───────────────────────────────────────
// The file never leaves the device: it is copied into the app cache so the OS
// FileProvider can share it, then handed to ACTION_VIEW on Android / the
// open-in sheet on iOS (see openInDeviceApp in the screen).
export function DocumentCard({ icon, fileName, label, reason, opening, onOpen }: {
  icon: string; fileName: string; label: string; reason?: string; opening: boolean; onOpen: () => void;
}) {
  return (
    <View style={[s.centered, s.contentFill]}>
      <Text style={s.fileIcon} importantForAccessibility="no" accessibilityElementsHidden>{icon}</Text>
      <Text style={s.loadingText}>{fileName}</Text>
      <Text style={[s.loadingText, s.cardNote]}>
        {reason ? reason : `Opens in your ${label} app. The file stays on this device.`}
      </Text>
      <TouchableOpacity
        style={s.openBtn}
        onPress={onOpen}
        disabled={opening}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Open in your ${label} app`}
        accessibilityState={{ busy: opening, disabled: opening }}
      >
        {opening
          ? <ActivityIndicator color={C.onFill} />
          : <Text style={s.openBtnTxt}>Open</Text>}
      </TouchableOpacity>
    </View>
  );
}

// ── Office / PDF-as-text reader ──────────────────────────────────
// .docx/.xlsx/.pptx are read IN-APP (lib/docBlocks, lib/docText). Anything that
// cannot be read that way still falls back to the device hand-off.
export function DocReader({ blocks, text, more, opening, onOpen }: {
  blocks: Block[] | null; text: string; more: boolean; opening: boolean; onOpen: () => void;
}) {
  // Reading in-app and opening elsewhere are both offered, always. In-app is
  // the default because it is instant and the file never leaves the device.
  return (
    <View style={s.contentFill}>
      {blocks ? (
        <DocView blocks={blocks} colors={paperColors} />
      ) : (
        <ScrollView style={s.flex} contentContainerStyle={s.paperScroll} showsVerticalScrollIndicator indicatorStyle="white">
          {/* Ink, not near-white: this sits on the same white page as the reader above. */}
          <Text selectable style={s.paperText}>{text}</Text>
        </ScrollView>
      )}
      <DocActionBar
        hint={more ? 'Reader view — loading the rest…'
          : blocks ? 'Reader view — no images or charts' : 'Text only — no formatting'}
        opening={opening} onOpen={onOpen} />
    </View>
  );
}

export function DocEmpty({ icon, fileName, isPdf, onOpen }: {
  icon: string; fileName: string; isPdf: boolean; onOpen: () => void;
}) {
  return (
    <View style={[s.centered, s.contentFill]}>
      <Text style={s.fileIcon} importantForAccessibility="no" accessibilityElementsHidden>{icon}</Text>
      <Text style={s.loadingText}>{fileName}</Text>
      <Text style={[s.loadingText, s.cardNote]}>
        {isPdf
          // The overwhelmingly common cause for a PDF: it is a scan, so there
          // is no text layer to read — only an image of one.
          ? 'This PDF has no text layer (it may be a scan). Open it in a PDF app to view the pages.'
          : 'No readable text in this document.'}
      </Text>
      <TouchableOpacity style={s.openBtn} onPress={onOpen} activeOpacity={0.85}
        accessibilityRole="button" accessibilityLabel="Open in another app">
        <Text style={s.openBtnTxt}>Open in another app</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Text / code ──────────────────────────────────────────────────
export function TextPane({ lines, ext, more, failed, capped, onEndReached, onRetryRest, opening, onOpen }: {
  lines: string[]; ext: string; more: boolean; failed: boolean; capped: boolean;
  onEndReached: () => void; onRetryRest: () => void; opening: boolean; onOpen: () => void;
}) {
  const count = `${lines.length} lines${more ? ' so far' : ''}`;
  return (
    <View style={s.contentFill}>
      {/* FlatList, not ScrollView + map: a 5 MB .log is ~100k lines, and
          mounting one View + two Text per line at once is what made a big text
          file freeze the app. No getItemLayout — s.codeLine is minHeight 22 and
          s.lineText wraps, so row height is not statically known. */}
      <FlatList
        style={s.flex}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={s.codeContainer}
        showsVerticalScrollIndicator
        indicatorStyle="white"
        initialNumToRender={40}
        maxToRenderPerBatch={40}
        windowSize={7}
        removeClippedSubviews
        onEndReached={more ? onEndReached : undefined}
        onEndReachedThreshold={1.5}
        ListFooterComponent={
          more ? <ActivityIndicator style={s.footerSpinner} color={C.accent} />
          : failed ? (
            // The rest could not be read. What IS read stays on screen — the
            // full-screen error card would have thrown it all away.
            <TouchableOpacity
              onPress={onRetryRest}
              style={s.footerSpinner}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Could not read the rest of the file. Try again"
            >
              <Text style={[s.codeLineCount, s.footerNote]}>Could not read the rest — tap to try again</Text>
            </TouchableOpacity>
          )
          : capped ? (
            <Text style={[s.codeLineCount, s.footerNote]}>First 5 MB shown — open in another app for the rest</Text>
          ) : null
        }
        ListHeaderComponent={
          <View style={s.codeHeader}>
            <View style={s.codeLangBadge}>
              <Text style={s.codeLangText}>{ext.toUpperCase()}</Text>
            </View>
            <Text style={s.codeLineCount}>{count}</Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <View style={s.codeLine}>
            <Text style={s.lineNumber}>{index + 1}</Text>
            <Text style={s.lineText}>{item || ' '}</Text>
          </View>
        )}
      />
      {/* Same choice as documents get: read here, or hand the file to whatever
          app the user prefers. Consistent across every readable type. */}
      <DocActionBar hint={count} opening={opening} onOpen={onOpen} />
    </View>
  );
}

// ── Audio ────────────────────────────────────────────────────────
function WaveformBars({ progress, barCount = 48 }: { progress: number; barCount?: number }) {
  const heights = useRef(Array.from({ length: barCount }, () => 0.15 + Math.random() * 0.85)).current;
  return (
    <View style={s.waveContainer}>
      {heights.map((h, i) => (
        <View key={i} style={[s.waveBar, { height: h * 56, backgroundColor: i / barCount <= progress ? C.accent : 'rgba(255,255,255,0.12)' }]} />
      ))}
    </View>
  );
}

export function AudioPane({ fileName, fileSize, position, duration, playing, onToggle, onSeek }: {
  fileName: string; fileSize: number; position: number; duration: number; playing: boolean;
  onToggle: () => void; onSeek: (ratio: number) => void;
}) {
  // Live width of the seek bar, from onLayout: locationX is relative to the
  // view, so its own width is the only correct divisor (a frozen screen width
  // jumped to the wrong spot after a rotation).
  const [seekW, setSeekW] = useState(0);
  const progress = duration > 0 ? position / duration : 0;
  const clamp01 = (r: number) => Math.max(0, Math.min(1, r));
  return (
    <View style={[s.centered, s.audioPane]}>
      {/* Album art placeholder */}
      <View style={s.audioArtCircle}>
        <LinearGradient colors={CTA_GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.audioGradient}>
          <Ionicons name="musical-notes" size={40} color={C.onFill} />
        </LinearGradient>
      </View>

      <Text style={s.audioTitle} numberOfLines={2}>{fileName}</Text>
      {fileSize > 0 && <Text style={s.audioMeta}>{formatBytes(fileSize)}</Text>}

      <View style={s.waveWrap}>
        <WaveformBars progress={progress} />
        <TouchableOpacity
          activeOpacity={1}
          style={s.seekTouchArea}
          accessibilityRole="adjustable"
          accessibilityLabel="Seek"
          accessibilityValue={{ text: `${formatDuration(position)} of ${formatDuration(duration)}` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const d = e.nativeEvent.actionName === 'increment' ? 15000 : -15000;
            onSeek(clamp01((position + d) / (duration || 1)));
          }}
          onLayout={(e) => setSeekW(e.nativeEvent.layout.width)}
          onPress={(e) => onSeek(clamp01(e.nativeEvent.locationX / (seekW || 1)))}
        />
      </View>

      <View style={s.audioTimeRow}>
        <Text style={s.audioTime}>{formatDuration(position)}</Text>
        <Text style={s.audioTime}>{formatDuration(duration)}</Text>
      </View>

      <View style={s.audioControls}>
        <TouchableOpacity onPress={() => onSeek(Math.max(0, (position - 15000) / (duration || 1)))}
          style={s.audioBtn} accessibilityRole="button" accessibilityLabel="Back 15 seconds">
          <View style={s.audioBtnInner}>
            <Ionicons name="play-back" size={14} color={C.textDim} />
            <Text style={s.audioBtnText}>15s</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity onPress={onToggle} accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'} style={s.audioPlayBtn}>
          <LinearGradient colors={CTA_GRADIENT} style={s.audioPlayGradient}>
            <Ionicons name={playing ? 'pause' : 'play'} size={24} color={C.onFill} />
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => onSeek(Math.min(1, (position + 15000) / (duration || 1)))}
          style={s.audioBtn} accessibilityRole="button" accessibilityLabel="Forward 15 seconds">
          <View style={s.audioBtnInner}>
            <Text style={s.audioBtnText}>15s</Text>
            <Ionicons name="play-forward" size={14} color={C.textDim} />
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Unknown type / error ─────────────────────────────────────────
export function UnknownPane({ fileName, fileSize }: { fileName: string; fileSize: number }) {
  return (
    <View style={[s.centered, s.unknownPane]}>
      <Ionicons name="attach" size={64} color={C.textDim} />
      <Text style={[s.errorTitle, s.unknownTitle]}>{fileName}</Text>
      {fileSize > 0 && <Text style={s.audioMeta}>{formatBytes(fileSize)}</Text>}
      <Text style={[s.loadingText, s.unknownBody]}>
        This file type cannot be previewed in-app.{'\n'}Use &quot;Open in another app&quot; below to view it.
      </Text>
    </View>
  );
}

export function ErrorPane({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={[s.centered, s.flex]} accessibilityLiveRegion="polite">
      <View style={s.errorCircle}>
        <Ionicons name="alert-circle-outline" size={36} color={C.warning} />
      </View>
      <Text style={s.errorTitle} accessibilityRole="header">Unable to load file</Text>
      <Text style={s.errorDesc}>{message}</Text>
      <TouchableOpacity onPress={onRetry} style={s.retryBtn} accessibilityRole="button" accessibilityLabel="Retry">
        <LinearGradient colors={CTA_GRADIENT} style={s.retryGradient}>
          <Text style={s.retryText}>Retry</Text>
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}
