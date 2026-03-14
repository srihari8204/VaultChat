// components/MediaMessage.tsx
// Renders image, video thumbnail, audio player, GIF, file attachment

import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Audio, AVPlaybackStatus } from 'expo-av';

interface Props {
  url: string;
  msgType: 'image' | 'video' | 'audio' | 'file' | 'gif';
  filename?: string;
  duration?: number;
}

// â”€â”€ Image / GIF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function ImageMsg({ url }: { url: string }) {
  const [loading, setLoading] = useState(true);
  return (
    <View style={s.imgWrap}>
      {loading && <ActivityIndicator color="#00E5FF" style={s.loader} />}
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

// â”€â”€ Audio player â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function AudioMsg({ url, duration }: { url: string; duration?: number }) {
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
    } catch (e: any) { Alert.alert('Playback error', e.message); }
  };

  const fmt = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;
  };
  const pct = dur > 0 ? pos / dur : 0;

  return (
    <View style={s.audioRow}>
      <TouchableOpacity onPress={toggle} style={s.playBtn}>
        <Text style={{ fontSize: 20 }}>{playing ? 'â¸' : 'â–¶ï¸'}</Text>
      </TouchableOpacity>
      <View style={s.audioRight}>
        <View style={s.progressBg}>
          <View style={[s.progressFill, { width: `${pct * 100}%` as any }]} />
        </View>
        <Text style={s.audioTime}>{fmt(playing ? pos : dur * 1000)}</Text>
      </View>
    </View>
  );
}

// â”€â”€ File â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function FileMsg({ filename, url }: { filename?: string; url: string }) {
  return (
    <View style={s.fileRow}>
      <Text style={{ fontSize: 28 }}>ðŸ“„</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.fileName} numberOfLines={1}>{filename ?? 'File'}</Text>
        <Text style={s.fileOpen}>Tap to open</Text>
      </View>
    </View>
  );
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function MediaMessage({ url, msgType, filename, duration }: Props) {
  if (msgType === 'image' || msgType === 'gif') return <ImageMsg url={url} />;
  if (msgType === 'audio')  return <AudioMsg url={url} duration={duration} />;
  if (msgType === 'file')   return <FileMsg filename={filename} url={url} />;
  if (msgType === 'video')  return (
    <View style={s.imgWrap}>
      <Image source={{ uri: url }} style={s.img} resizeMode="cover" />
      <View style={s.videoPlay}><Text style={{ fontSize: 36 }}>â–¶</Text></View>
    </View>
  );
  return null;
}

const s = StyleSheet.create({
  imgWrap:     { width: 220, height: 180, borderRadius: 10, overflow: 'hidden', backgroundColor: '#111' },
  img:         { width: '100%', height: '100%' },
  loader:      { position: 'absolute', top: '50%', left: '50%' },
  videoPlay:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#00000055' },
  audioRow:    { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 180, maxWidth: 240 },
  playBtn:     { width: 40, height: 40, borderRadius: 20, backgroundColor: '#00E5FF22', alignItems: 'center', justifyContent: 'center' },
  audioRight:  { flex: 1 },
  progressBg:  { height: 3, backgroundColor: '#333', borderRadius: 2, overflow: 'hidden', marginBottom: 4 },
  progressFill:{ height: '100%', backgroundColor: '#00E5FF', borderRadius: 2 },
  audioTime:   { color: '#666', fontSize: 11 },
  fileRow:     { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 160, maxWidth: 240 },
  fileName:    { color: '#E0E0F0', fontSize: 14, fontWeight: '600' },
  fileOpen:    { color: '#555', fontSize: 11, marginTop: 2 },
});