// components/MediaMessage.tsx
// Renders image, video thumbnail, audio player, GIF, file attachment

import React, { useState, useMemo } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { brandAlpha, type Palette } from '../constants/theme';
import { useColors } from '../lib/theme';

interface Props {
  url: string;
  msgType: 'image' | 'video' | 'audio' | 'file' | 'gif';
  filename?: string;
  duration?: number;
}

// ── Image / GIF ────────────────────────────────────────────
function ImageMsg({ url }: { url: string }) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  const [loading, setLoading] = useState(true);
  return (
    <View style={s.imgWrap}>
      {loading && <ActivityIndicator color={c.accentOn} style={s.loader} />}
      <Image
        source={{ uri: url }}
        style={s.img}
        resizeMode="cover"
        onLoad={() => setLoading(false)}
        onError={() => setLoading(false)}
      />
    </View>
  );
}

// ── Audio player ───────────────────────────────────────────
function AudioMsg({ url, duration }: { url: string; duration?: number }) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  const [sound,   setSound]   = useState<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos,     setPos]     = useState(0);
  const [dur,     setDur]     = useState(duration ?? 0);

  const toggle = async () => {
    if (playing && sound) {
      await sound.pauseAsync();
      setPlaying(false);
      return;
    }
    if (sound) {
      await sound.playAsync();
      setPlaying(true);
      return;
    }
    try {
      await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
      const { sound: s } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true },
        (status: AVPlaybackStatus) => {
          if (status.isLoaded) {
            setPos(status.positionMillis ?? 0);
            setDur(status.durationMillis ?? dur);
            setPlaying(status.isPlaying);
            if (status.didJustFinish) setPlaying(false);
          }
        }
      );
      setSound(s);
      setPlaying(true);
    } catch { Alert.alert('Playback error', "This audio couldn't be played. It may be damaged or in an unsupported format."); }
  };

  const fmt = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;
  };
  const pct = dur > 0 ? pos / dur : 0;

  return (
    <View style={s.audioRow}>
      <TouchableOpacity onPress={toggle} style={s.playBtn} accessibilityRole="button" accessibilityLabel={playing ? 'Pause audio' : 'Play audio'}>
        <Ionicons name={playing ? 'pause' : 'play'} size={20} color={c.accentOn} />
      </TouchableOpacity>
      <View style={s.audioRight}>
        <View style={s.progressBg}>
          <View style={[s.progressFill, { width: `${pct * 100}%` }]} />
        </View>
        <Text style={s.audioTime}>{fmt(playing ? pos : dur * 1000)}</Text>
      </View>
    </View>
  );
}

// ── File ───────────────────────────────────────────────────
function FileMsg({ filename, url }: { filename?: string; url: string }) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  return (
    <View style={s.fileRow}>
      <Ionicons name="document-outline" size={28} color={c.textDim} importantForAccessibility="no" />
      <View style={s.flex}>
        <Text style={s.fileName} numberOfLines={1}>{filename ?? 'File'}</Text>
        <Text style={s.fileOpen}>Tap to open</Text>
      </View>
    </View>
  );
}

// ── Main ───────────────────────────────────────────────────
export default function MediaMessage({ url, msgType, filename, duration }: Props) {
  const c = useColors();
  const s = useMemo(() => makeS(c), [c]);
  if (msgType === 'image' || msgType === 'gif') return <ImageMsg url={url} />;
  if (msgType === 'audio')  return <AudioMsg url={url} duration={duration} />;
  if (msgType === 'file')   return <FileMsg filename={filename} url={url} />;
  if (msgType === 'video')  return (
    <View style={s.imgWrap}>
      <Image source={{ uri: url }} style={s.img} resizeMode="cover" />
      <View style={s.videoPlay}><Ionicons name="play" size={36} color={c.text} accessibilityLabel="Video" /></View>
    </View>
  );
  return null;
}

const makeS = (c: Palette) => StyleSheet.create({
  imgWrap: { width: 220, height: 180, borderRadius: 10, overflow: 'hidden', backgroundColor: c.bg },
  img: { width: '100%', height: '100%' },
  loader: { position: 'absolute', top: '50%', left: '50%' },
  videoPlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.33)' },
  flex: { flex: 1 },
  audioRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 180, maxWidth: 240 },
  playBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: brandAlpha(0.13), alignItems: 'center', justifyContent: 'center' },
  audioRight: { flex: 1 },
  progressBg: { height: 3, backgroundColor: c.surfaceSolid, borderRadius: 2, overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: '100%', backgroundColor: c.accentOn, borderRadius: 2 },
  audioTime: { color: c.textDim, fontSize: 11 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 160, maxWidth: 240 },
  fileName: { color: c.text, fontSize: 14, fontWeight: '600' },
  fileOpen: { color: c.textDim, fontSize: 11, marginTop: 2 },
});