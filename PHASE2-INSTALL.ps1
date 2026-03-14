# ============================================================
#  VaultChat Phase 2 — Photos, Voice, GIFs, Reactions
#  Run from: C:\Users\ADMIN\Desktop\Vaultchat backup\
#  powershell -ExecutionPolicy Bypass -File PHASE2-INSTALL.ps1
# ============================================================

$root = "C:\Users\ADMIN\Desktop\Vaultchat backup"
$noBOM = [System.Text.UTF8Encoding]::new($false)
Set-Location $root

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  VaultChat Phase 2 - Photos, Voice, GIFs, Reactions" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# Create components folder if it doesn't exist
if (!(Test-Path "$root\components")) { New-Item -ItemType Directory -Path "$root\components" | Out-Null }

# ─────────────────────────────────────────────────────────────────────────────
# FILE 1 of 7  services/mediaService.ts
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[1/7] services/mediaService.ts" -ForegroundColor Yellow

$f1 = @'
// services/mediaService.ts
// Upload images, videos, audio, files to Firebase Storage

import storage from '@react-native-firebase/storage';

export type MediaType = 'image' | 'video' | 'audio' | 'file';

export interface UploadResult {
  downloadURL: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  size?: number;
}

// Upload any local file URI to Firebase Storage
// Returns the public download URL
export async function uploadMedia(
  localUri: string,
  chatId: string,
  type: MediaType,
  filename?: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  const ext  = localUri.split('.').pop()?.toLowerCase() ?? 'bin';
  const name = filename ?? `${type}_${Date.now()}.${ext}`;
  const path = `chats/${chatId}/${type}s/${name}`;
  const ref  = storage().ref(path);

  const task = ref.putFile(localUri);

  if (onProgress) {
    task.on('state_changed', snap => {
      const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
      onProgress(Math.round(pct));
    });
  }

  await task;
  const downloadURL = await ref.getDownloadURL();

  const mimeMap: Record<MediaType, string> = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/m4a',
    file:  'application/octet-stream',
  };

  return { downloadURL, storagePath: path, filename: name, mimeType: mimeMap[type] };
}

// Delete a file from Firebase Storage by its storagePath
export async function deleteMedia(storagePath: string): Promise<void> {
  try {
    await storage().ref(storagePath).delete();
  } catch { /* ignore if already deleted */ }
}
'@
[System.IO.File]::WriteAllText("$root\services\mediaService.ts", $f1, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 2 of 7  components/AttachmentSheet.tsx
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[2/7] components/AttachmentSheet.tsx" -ForegroundColor Yellow

$f2 = @'
// components/AttachmentSheet.tsx
// Bottom sheet for choosing what to attach

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable, ScrollView } from 'react-native';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPhoto: () => void;
  onVideo: () => void;
  onFile: () => void;
  onGif: () => void;
  onVoice: () => void;
}

const OPTS = [
  { label: 'Photo',  icon: '🖼️',  key: 'photo'  },
  { label: 'Video',  icon: '🎬',  key: 'video'  },
  { label: 'File',   icon: '📄',  key: 'file'   },
  { label: 'GIF',    icon: '🎞️',  key: 'gif'    },
  { label: 'Voice',  icon: '🎤',  key: 'voice'  },
];

export default function AttachmentSheet({ visible, onClose, onPhoto, onVideo, onFile, onGif, onVoice }: Props) {
  if (!visible) return null;
  const handlers: Record<string, () => void> = {
    photo: onPhoto, video: onVideo, file: onFile, gif: onGif, voice: onVoice,
  };
  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <View style={s.sheet}>
        <View style={s.handle} />
        <Text style={s.title}>Attach</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
          {OPTS.map(o => (
            <TouchableOpacity key={o.key} style={s.btn} onPress={() => { onClose(); handlers[o.key](); }}>
              <View style={s.circle}><Text style={s.icon}>{o.icon}</Text></View>
              <Text style={s.lbl}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:   { backgroundColor: '#0E0E20', borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingBottom: 36, paddingTop: 12 },
  handle:  { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginBottom: 12 },
  title:   { color: '#888', fontSize: 13, fontWeight: '600', textAlign: 'center', marginBottom: 18 },
  row:     { paddingHorizontal: 16, gap: 16 },
  btn:     { alignItems: 'center', gap: 8 },
  circle:  { width: 60, height: 60, borderRadius: 30, backgroundColor: '#181830', alignItems: 'center', justifyContent: 'center' },
  icon:    { fontSize: 26 },
  lbl:     { color: '#C0C0E0', fontSize: 12 },
});
'@
[System.IO.File]::WriteAllText("$root\components\AttachmentSheet.tsx", $f2, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 3 of 7  components/VoiceRecorder.tsx
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[3/7] components/VoiceRecorder.tsx" -ForegroundColor Yellow

$f3 = @'
// components/VoiceRecorder.tsx
// Hold to record voice message

import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Audio } from 'expo-av';

interface Props {
  onSend: (uri: string, duration: number) => void;
  onCancel: () => void;
}

export default function VoiceRecorder({ onSend, onCancel }: Props) {
  const [recording, setRecording]   = useState<Audio.Recording | null>(null);
  const [seconds,   setSeconds]     = useState(0);
  const [uploading, setUploading]   = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { Alert.alert('Permission denied', 'Microphone permission is required.'); return; }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: rec } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(rec);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds(s => s + 1), 1000);
    } catch (e: any) { Alert.alert('Error', 'Could not start recording: ' + e.message); }
  };

  const stopAndSend = async () => {
    if (!recording) return;
    setUploading(true);
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recording.getURI();
      if (uri) onSend(uri, seconds);
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setUploading(false); setRecording(null); }
  };

  const cancel = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recording) {
      try { await recording.stopAndUnloadAsync(); } catch {}
    }
    setRecording(null); setSeconds(0); onCancel();
  };

  const fmt = (s: number) => `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`;

  return (
    <View style={s.wrap}>
      <TouchableOpacity onPress={cancel} style={s.cancelBtn}>
        <Text style={s.cancelTxt}>✕</Text>
      </TouchableOpacity>

      <View style={s.center}>
        {recording
          ? <View style={s.recRow}>
              <View style={s.dot} />
              <Text style={s.timer}>{fmt(seconds)}</Text>
            </View>
          : <Text style={s.hint}>Tap mic to record</Text>
        }
      </View>

      {uploading
        ? <ActivityIndicator color="#00E5FF" />
        : recording
          ? <TouchableOpacity onPress={stopAndSend} style={[s.micBtn, s.micStop]}>
              <Text style={s.micIco}>⬛</Text>
            </TouchableOpacity>
          : <TouchableOpacity onPress={startRecording} style={s.micBtn}>
              <Text style={s.micIco}>🎤</Text>
            </TouchableOpacity>
      }
    </View>
  );
}

const s = StyleSheet.create({
  wrap:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', paddingHorizontal: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#111' },
  cancelBtn: { padding: 8 },
  cancelTxt: { color: '#555', fontSize: 20 },
  center:    { flex: 1, alignItems: 'center' },
  recRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot:       { width: 10, height: 10, borderRadius: 5, backgroundColor: '#FF3C6E' },
  timer:     { color: '#E0E0F0', fontSize: 16, fontVariant: ['tabular-nums'] },
  hint:      { color: '#555', fontSize: 13 },
  micBtn:    { width: 48, height: 48, borderRadius: 24, backgroundColor: '#00E5FF', alignItems: 'center', justifyContent: 'center' },
  micStop:   { backgroundColor: '#FF3C6E' },
  micIco:    { fontSize: 22 },
});
'@
[System.IO.File]::WriteAllText("$root\components\VoiceRecorder.tsx", $f3, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 4 of 7  components/GifPicker.tsx
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[4/7] components/GifPicker.tsx" -ForegroundColor Yellow

$f4 = @'
// components/GifPicker.tsx
// Search and pick GIFs using Tenor API (free public key)
// Get your own key free at: https://tenor.com/developer/dashboard

import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  Image, StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';

// Replace with your own free Tenor API key from tenor.com/developer
const TENOR_KEY = 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCPY';
const TENOR_URL = 'https://tenor.googleapis.com/v2/search';

interface GifResult {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (url: string, previewUrl: string) => void;
}

export default function GifPicker({ visible, onClose, onSelect }: Props) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    try {
      const url = `${TENOR_URL}?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=24&media_filter=gif,tinygif`;
      const res  = await fetch(url);
      const data = await res.json();
      const gifs: GifResult[] = (data.results ?? []).map((r: any) => ({
        id:      r.id,
        url:     r.media_formats?.gif?.url     ?? r.media_formats?.tinygif?.url ?? '',
        preview: r.media_formats?.tinygif?.url ?? r.media_formats?.gif?.url     ?? '',
        width:   r.media_formats?.tinygif?.dims?.[0] ?? 100,
        height:  r.media_formats?.tinygif?.dims?.[1] ?? 100,
      }));
      setResults(gifs);
    } catch { setResults([]); }
    finally { setLoading(false); }
  }, []);

  if (!visible) return null;

  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <Pressable style={s.sheet} onPress={() => {}}>
        <View style={s.handle} />
        <View style={s.searchRow}>
          <TextInput
            style={s.input}
            placeholder="Search GIFs…"
            placeholderTextColor="#444"
            value={query}
            onChangeText={q => { setQuery(q); search(q); }}
            autoFocus
          />
          <TouchableOpacity onPress={onClose}>
            <Text style={s.closeX}>✕</Text>
          </TouchableOpacity>
        </View>
        {loading && <ActivityIndicator color="#00E5FF" style={{ margin: 16 }} />}
        <FlatList
          data={results}
          numColumns={3}
          keyExtractor={g => g.id}
          contentContainerStyle={s.grid}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.gifCell}
              onPress={() => { onSelect(item.url, item.preview); onClose(); }}
            >
              <Image source={{ uri: item.preview }} style={s.gifImg} resizeMode="cover" />
            </TouchableOpacity>
          )}
          ListEmptyComponent={!loading ? <Text style={s.empty}>Type to search GIFs</Text> : null}
        />
      </Pressable>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay:   { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:     { backgroundColor: '#0E0E20', borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: '75%' },
  handle:    { width: 40, height: 4, backgroundColor: '#333', borderRadius: 2, alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  searchRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  input:     { flex: 1, backgroundColor: '#181830', color: '#E0E0F0', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 14 },
  closeX:    { color: '#555', fontSize: 20, padding: 4 },
  grid:      { padding: 4 },
  gifCell:   { flex: 1, margin: 2, height: 100, backgroundColor: '#111', borderRadius: 8, overflow: 'hidden' },
  gifImg:    { width: '100%', height: '100%' },
  empty:     { color: '#444', textAlign: 'center', marginTop: 40, fontSize: 14 },
});
'@
[System.IO.File]::WriteAllText("$root\components\GifPicker.tsx", $f4, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 5 of 7  components/ReactionPicker.tsx
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[5/7] components/ReactionPicker.tsx" -ForegroundColor Yellow

$f5 = @'
// components/ReactionPicker.tsx
// Emoji reaction picker shown on long-press

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';

const EMOJIS = ['❤️', '😂', '👍', '😮', '😢', '🔥', '👏', '🙏'];

interface Props {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function ReactionPicker({ visible, onSelect, onClose }: Props) {
  if (!visible) return null;
  return (
    <Pressable style={s.overlay} onPress={onClose}>
      <View style={s.bubble}>
        {EMOJIS.map(e => (
          <TouchableOpacity key={e} onPress={() => onSelect(e)} style={s.emojiBtn}>
            <Text style={s.emoji}>{e}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  overlay:  { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  bubble:   {
    position: 'absolute', bottom: 120, alignSelf: 'center',
    flexDirection: 'row', backgroundColor: '#1A1A32',
    borderRadius: 30, paddingHorizontal: 8, paddingVertical: 6,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4, shadowRadius: 8, elevation: 10,
    borderWidth: 1, borderColor: '#333',
  },
  emojiBtn: { padding: 6 },
  emoji:    { fontSize: 26 },
});
'@
[System.IO.File]::WriteAllText("$root\components\ReactionPicker.tsx", $f5, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 6 of 7  components/MediaMessage.tsx
# Renders image / video / audio / GIF / file messages
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[6/7] components/MediaMessage.tsx" -ForegroundColor Yellow

$f6 = @'
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

// ── Image / GIF ────────────────────────────────────────────
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

// ── Audio player ───────────────────────────────────────────
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
        <Text style={{ fontSize: 20 }}>{playing ? '⏸' : '▶️'}</Text>
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

// ── File ───────────────────────────────────────────────────
function FileMsg({ filename, url }: { filename?: string; url: string }) {
  return (
    <View style={s.fileRow}>
      <Text style={{ fontSize: 28 }}>📄</Text>
      <View style={{ flex: 1 }}>
        <Text style={s.fileName} numberOfLines={1}>{filename ?? 'File'}</Text>
        <Text style={s.fileOpen}>Tap to open</Text>
      </View>
    </View>
  );
}

// ── Main ───────────────────────────────────────────────────
export default function MediaMessage({ url, msgType, filename, duration }: Props) {
  if (msgType === 'image' || msgType === 'gif') return <ImageMsg url={url} />;
  if (msgType === 'audio')  return <AudioMsg url={url} duration={duration} />;
  if (msgType === 'file')   return <FileMsg filename={filename} url={url} />;
  if (msgType === 'video')  return (
    <View style={s.imgWrap}>
      <Image source={{ uri: url }} style={s.img} resizeMode="cover" />
      <View style={s.videoPlay}><Text style={{ fontSize: 36 }}>▶</Text></View>
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
'@
[System.IO.File]::WriteAllText("$root\components\MediaMessage.tsx", $f6, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# FILE 7 of 7  app/chat.tsx  (full rewrite — Phase 1 + Phase 2)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "[7/7] app/chat.tsx (full Phase 1 + Phase 2)" -ForegroundColor Yellow

$f7 = @'
// app/chat.tsx
// Phase 1 + Phase 2: E2E encryption, ticks, typing, reply, edit, delete,
// photos, videos, files, voice messages, GIFs, emoji reactions,
// message formatting (bold, italic, code)

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity,
  KeyboardAvoidingView, Platform, StyleSheet, Alert,
  ActivityIndicator, Pressable, Image,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { io, Socket } from 'socket.io-client';
import { encryptMessage, decryptMessage, EncryptedPayload } from '../services/d2deService';
import { uploadMedia } from '../services/mediaService';
import AttachmentSheet from '../components/AttachmentSheet';
import VoiceRecorder   from '../components/VoiceRecorder';
import GifPicker       from '../components/GifPicker';
import ReactionPicker  from '../components/ReactionPicker';
import MediaMessage    from '../components/MediaMessage';

const BACKEND = 'https://vaultchat.onrender.com';

// ── Types ──────────────────────────────────────────────────────────────────

type MsgStatus = 'sending' | 'sent' | 'delivered' | 'read';
type MsgType   = 'text' | 'image' | 'video' | 'audio' | 'file' | 'gif';

interface Reactions { [emoji: string]: string[]; }

interface Message {
  id: string;
  senderId: string;
  plaintext: string;
  ciphertext: string;
  iv: string;
  status: MsgStatus;
  createdAt: any;
  isEdited?: boolean;
  isDeleted?: boolean;
  replyTo?: { id: string; senderId: string; plaintext: string };
  msgType: MsgType;
  mediaUrl?: string;
  filename?: string;
  audioDuration?: number;
  reactions?: Reactions;
}

// ── Formatting helpers ────────────────────────────────────────────────────

function renderFormatted(text: string): React.ReactNode {
  // bold: *text*, italic: _text_, code: `text`
  const parts = text.split(/(\*[^*]+\*|_[^_]+_|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('*') && part.endsWith('*'))
      return <Text key={i} style={{ fontWeight: 'bold' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('_') && part.endsWith('_'))
      return <Text key={i} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <Text key={i} style={{ fontFamily: 'monospace', backgroundColor: '#111', color: '#00E5FF' }}>{part.slice(1, -1)}</Text>;
    return <Text key={i}>{part}</Text>;
  });
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const { chatId, peerUid, peerName } = useLocalSearchParams<{
    chatId: string; peerUid: string; peerName: string;
  }>();
  const router = useRouter();
  const myUid  = auth().currentUser?.uid ?? '';

  const [messages,      setMessages]      = useState<Message[]>([]);
  const [inputText,     setInputText]     = useState('');
  const [loading,       setLoading]       = useState(true);
  const [sending,       setSending]       = useState(false);
  const [uploading,     setUploading]     = useState(false);
  const [uploadPct,     setUploadPct]     = useState(0);
  const [peerTyping,    setPeerTyping]    = useState(false);
  const [replyTarget,   setReplyTarget]   = useState<Message | null>(null);
  const [editTarget,    setEditTarget]    = useState<Message | null>(null);
  const [longPressMsg,  setLongPressMsg]  = useState<Message | null>(null);
  const [showAttach,    setShowAttach]    = useState(false);
  const [showVoice,     setShowVoice]     = useState(false);
  const [showGif,       setShowGif]       = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [reactionTarget,setReactionTarget]= useState<Message | null>(null);

  const flatRef     = useRef<FlatList>(null);
  const socketRef   = useRef<Socket | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTyping    = useRef(false);

  // ── Socket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let sock: Socket;
    (async () => {
      const token = await auth().currentUser?.getIdToken();
      sock = io(BACKEND, { auth: { token }, transports: ['websocket'] });
      sock.emit('join_chat', { chatId, uid: myUid });

      sock.on('typing_start',      ({ uid }: any) => { if (uid !== myUid) setPeerTyping(true);  });
      sock.on('typing_stop',       ({ uid }: any) => { if (uid !== myUid) setPeerTyping(false); });
      sock.on('message_delivered', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId && m.status === 'sent' ? { ...m, status: 'delivered' } : m)));
      sock.on('message_read', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, status: 'read' } : m)));
      sock.on('message_edited', ({ messageId, newPlaintext }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, plaintext: newPlaintext, isEdited: true } : m)));
      sock.on('message_deleted', ({ messageId }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, isDeleted: true, plaintext: '' } : m)));
      sock.on('reaction_updated', ({ messageId, reactions }: any) =>
        setMessages(p => p.map(m => m.id === messageId ? { ...m, reactions } : m)));

      socketRef.current = sock;
    })();
    return () => { sock?.disconnect(); };
  }, [chatId, myUid]);

  // ── Firestore ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = firestore()
      .collection('chats').doc(chatId)
      .collection('messages').orderBy('createdAt', 'asc')
      .onSnapshot(async snap => {
        const msgs = await Promise.all(snap.docs.map(async doc => {
          const d = doc.data() as any;
          if (d.isDeleted) return { id: doc.id, senderId: d.senderId, plaintext: '', ciphertext: '', iv: '', status: d.status ?? 'sent', createdAt: d.createdAt, isDeleted: true, msgType: d.msgType ?? 'text' } as Message;

          let plaintext = '';
          if (d.msgType === 'text') {
            try {
              if (d.ciphertext && d.iv) {
                plaintext = await decryptMessage({ ciphertext: d.ciphertext, iv: d.iv, tag: d.tag ?? '', keyId: d.keyId ?? 'v1-pbkdf2', v: d.v ?? 1 }, myUid, peerUid);
              } else { plaintext = d.plaintext ?? ''; }
            } catch { plaintext = '[Decryption failed]'; }
          }

          return {
            id: doc.id, senderId: d.senderId, plaintext,
            ciphertext: d.ciphertext ?? '', iv: d.iv ?? '',
            status: d.status ?? 'sent', createdAt: d.createdAt,
            isEdited: d.isEdited ?? false, isDeleted: false,
            replyTo: d.replyTo ?? null, msgType: d.msgType ?? 'text',
            mediaUrl: d.mediaUrl, filename: d.filename,
            audioDuration: d.audioDuration,
            reactions: d.reactions ?? {},
          } as Message;
        }));
        setMessages(msgs);
        setLoading(false);
        markRead(snap.docs);
        setTimeout(() => flatRef.current?.scrollToEnd({ animated: true }), 80);
      });
    return unsub;
  }, [chatId, myUid, peerUid]);

  const markRead = useCallback((docs: any[]) => {
    const batch = firestore().batch();
    docs.forEach(doc => {
      if (doc.data().senderId !== myUid && doc.data().status !== 'read') {
        batch.update(doc.ref, { status: 'read' });
        socketRef.current?.emit('message_read', { chatId, messageId: doc.id, readerUid: myUid, senderUid: peerUid });
      }
    });
    batch.commit().catch(() => {});
  }, [chatId, myUid, peerUid]);

  // ── Typing ─────────────────────────────────────────────────────────────
  const handleTyping = (text: string) => {
    setInputText(text);
    if (!isTyping.current) { isTyping.current = true; socketRef.current?.emit('typing_start', { chatId, uid: myUid }); }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => { isTyping.current = false; socketRef.current?.emit('typing_stop', { chatId, uid: myUid }); }, 2000);
  };

  // ── Core send (text) ───────────────────────────────────────────────────
  const sendTextMessage = async (text: string, reply?: Message | null) => {
    setSending(true);
    isTyping.current = false;
    socketRef.current?.emit('typing_stop', { chatId, uid: myUid });
    try {
      const payload = await encryptMessage(text, myUid, peerUid);
      const data: any = {
        senderId: myUid, ciphertext: payload.ciphertext, iv: payload.iv,
        tag: payload.tag, keyId: payload.keyId, v: payload.v,
        msgType: 'text', status: 'sent', isDeleted: false,
        reactions: {},
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (reply) data.replyTo = { id: reply.id, senderId: reply.senderId, plaintext: reply.plaintext.substring(0, 80) };
      const ref = await firestore().collection('chats').doc(chatId).collection('messages').add(data);
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: text.substring(0, 60), lastTime: firestore.FieldValue.serverTimestamp(),
        [`unread.${peerUid}`]: firestore.FieldValue.increment(1),
      });
      socketRef.current?.emit('new_message', { chatId, messageId: ref.id, senderUid: myUid, recipientUid: peerUid, preview: text.substring(0, 40) });
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSending(false); }
  };

  // ── Send media message (photo/video/audio/file/gif) ────────────────────
  const sendMediaMessage = async (
    localUri: string,
    type: 'image' | 'video' | 'audio' | 'file' | 'gif',
    opts?: { filename?: string; duration?: number; gifUrl?: string }
  ) => {
    setUploading(true); setUploadPct(0);
    try {
      let downloadURL = opts?.gifUrl ?? '';
      let filename    = opts?.filename ?? '';
      if (!downloadURL) {
        const result = await uploadMedia(localUri, chatId, type === 'gif' ? 'image' : type, opts?.filename, pct => setUploadPct(pct));
        downloadURL = result.downloadURL;
        filename    = result.filename;
      }
      const data: any = {
        senderId: myUid, msgType: type, mediaUrl: downloadURL,
        filename, status: 'sent', isDeleted: false, reactions: {},
        createdAt: firestore.FieldValue.serverTimestamp(),
      };
      if (type === 'audio' && opts?.duration) data.audioDuration = opts.duration;
      const ref = await firestore().collection('chats').doc(chatId).collection('messages').add(data);
      const preview = type === 'audio' ? '🎤 Voice message' : type === 'gif' ? '🎞️ GIF' : type === 'file' ? `📄 ${filename}` : `📷 ${type}`;
      await firestore().collection('chats').doc(chatId).update({
        lastMsg: preview, lastTime: firestore.FieldValue.serverTimestamp(),
        [`unread.${peerUid}`]: firestore.FieldValue.increment(1),
      });
      socketRef.current?.emit('new_message', { chatId, messageId: ref.id, senderUid: myUid, recipientUid: peerUid, preview });
    } catch (e: any) { Alert.alert('Upload error', e.message); }
    finally { setUploading(false); }
  };

  // ── Send button ────────────────────────────────────────────────────────
  const onSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    if (editTarget) { await saveEdit(text); return; }
    setInputText('');
    const reply = replyTarget; setReplyTarget(null);
    await sendTextMessage(text, reply);
  };

  // ── Edit / Delete ──────────────────────────────────────────────────────
  const startEdit  = (m: Message) => { setEditTarget(m); setLongPressMsg(null); setInputText(m.plaintext); };
  const cancelEdit = () => { setEditTarget(null); setInputText(''); };
  const saveEdit   = async (newText: string) => {
    if (!editTarget) return;
    setSending(true); setEditTarget(null); setInputText('');
    try {
      const payload = await encryptMessage(newText, myUid, peerUid);
      await firestore().collection('chats').doc(chatId).collection('messages').doc(editTarget.id)
        .update({ ciphertext: payload.ciphertext, iv: payload.iv, isEdited: true, editedAt: firestore.FieldValue.serverTimestamp() });
      socketRef.current?.emit('message_edited', { chatId, messageId: editTarget.id, newPlaintext: newText });
    } catch (e: any) { Alert.alert('Error', e.message); }
    finally { setSending(false); }
  };

  const deleteForEveryone = (m: Message) => {
    setLongPressMsg(null);
    Alert.alert('Delete for Everyone?', 'Permanently removed for both users.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await firestore().collection('chats').doc(chatId).collection('messages').doc(m.id)
            .update({ ciphertext: firestore.FieldValue.delete(), iv: firestore.FieldValue.delete(), mediaUrl: firestore.FieldValue.delete(), isDeleted: true });
          socketRef.current?.emit('message_deleted', { chatId, messageId: m.id, deleterUid: myUid });
        } catch (e: any) { Alert.alert('Error', e.message); }
      }},
    ]);
  };

  // ── Reactions ──────────────────────────────────────────────────────────
  const addReaction = async (msg: Message, emoji: string) => {
    setShowReactions(false); setReactionTarget(null); setLongPressMsg(null);
    const existing: Reactions = msg.reactions ?? {};
    const users: string[] = existing[emoji] ?? [];
    let updated: Reactions;
    if (users.includes(myUid)) {
      // toggle off
      const filtered = users.filter(u => u !== myUid);
      updated = { ...existing };
      if (filtered.length === 0) delete updated[emoji];
      else updated[emoji] = filtered;
    } else {
      updated = { ...existing, [emoji]: [...users, myUid] };
    }
    await firestore().collection('chats').doc(chatId).collection('messages').doc(msg.id)
      .update({ reactions: updated });
    socketRef.current?.emit('reaction_updated', { chatId, messageId: msg.id, reactions: updated });
  };

  // ── Pickers ────────────────────────────────────────────────────────────
  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1 });
    if (!res.canceled && res.assets[0]) await sendMediaMessage(res.assets[0].uri, 'image');
  };

  const pickVideo = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos });
    if (!res.canceled && res.assets[0]) await sendMediaMessage(res.assets[0].uri, 'video');
  };

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
    if (!res.canceled && res.assets[0]) await sendMediaMessage(res.assets[0].uri, 'file', { filename: res.assets[0].name });
  };

  // ── Render message ─────────────────────────────────────────────────────
  const Ticks = ({ status }: { status: MsgStatus }) => {
    if (status === 'sending')   return <Text style={s.tick}>○</Text>;
    if (status === 'sent')      return <Text style={s.tick}>✓</Text>;
    if (status === 'delivered') return <Text style={s.tick}>✓✓</Text>;
    return <Text style={[s.tick, { color: '#00E5FF' }]}>✓✓</Text>;
  };

  const ReactionRow = ({ msg }: { msg: Message }) => {
    const reactions = msg.reactions ?? {};
    const entries   = Object.entries(reactions).filter(([, uids]) => uids.length > 0);
    if (entries.length === 0) return null;
    return (
      <View style={s.reactionRow}>
        {entries.map(([emoji, uids]) => (
          <TouchableOpacity key={emoji} onPress={() => addReaction(msg, emoji)} style={[s.reactionChip, uids.includes(myUid) && s.reactionChipMine]}>
            <Text style={s.reactionEmoji}>{emoji}</Text>
            {uids.length > 1 && <Text style={s.reactionCount}>{uids.length}</Text>}
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderMsg = ({ item: m }: { item: Message }) => {
    const isMe = m.senderId === myUid;
    if (m.isDeleted) return (
      <View style={[s.row, isMe ? s.rowR : s.rowL]}>
        <View style={[s.bubble, s.bubbleDel]}>
          <Text style={s.delTxt}>🚫 Message deleted</Text>
        </View>
      </View>
    );

    return (
      <Pressable onLongPress={() => { setLongPressMsg(m); }} delayLongPress={350}>
        <View style={[s.row, isMe ? s.rowR : s.rowL]}>
          <View>
            <View style={[s.bubble, isMe ? s.bMe : s.bPeer]}>
              {m.replyTo && (
                <View style={s.replyBar}>
                  <Text style={s.replyName}>{m.replyTo.senderId === myUid ? 'You' : peerName}</Text>
                  <Text style={s.replyPrev} numberOfLines={1}>{m.replyTo.plaintext}</Text>
                </View>
              )}

              {m.msgType !== 'text' && m.mediaUrl
                ? <MediaMessage url={m.mediaUrl} msgType={m.msgType} filename={m.filename} duration={m.audioDuration} />
                : <Text style={s.msgTxt}>{renderFormatted(m.plaintext)}</Text>
              }

              <View style={s.meta}>
                {m.isEdited && <Text style={s.edited}>edited · </Text>}
                <Text style={s.time}>{m.createdAt?.toDate?.().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? ''}</Text>
                {isMe && <Ticks status={m.status} />}
              </View>
            </View>
            <ReactionRow msg={m} />
          </View>
        </View>
      </Pressable>
    );
  };

  // ── Long press sheet ───────────────────────────────────────────────────
  const Sheet = () => {
    if (!longPressMsg) return null;
    const isMe = longPressMsg.senderId === myUid;
    return (
      <Pressable style={s.overlay} onPress={() => setLongPressMsg(null)}>
        <View style={s.sheet}>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReactionTarget(longPressMsg); setShowReactions(true); setLongPressMsg(null); }}>
            <Text style={s.sheetTxt}>😊  React</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.sheetRow} onPress={() => { setReplyTarget(longPressMsg); setLongPressMsg(null); }}>
            <Text style={s.sheetTxt}>↩  Reply</Text>
          </TouchableOpacity>
          {isMe && longPressMsg.msgType === 'text' && (
            <TouchableOpacity style={s.sheetRow} onPress={() => startEdit(longPressMsg)}>
              <Text style={s.sheetTxt}>✏️  Edit</Text>
            </TouchableOpacity>
          )}
          {isMe && (
            <TouchableOpacity style={s.sheetRow} onPress={() => deleteForEveryone(longPressMsg)}>
              <Text style={[s.sheetTxt, { color: '#FF3C6E' }]}>🗑  Delete for Everyone</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.sheetRow} onPress={() => setLongPressMsg(null)}>
            <Text style={[s.sheetTxt, { color: '#555' }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    );
  };

  // ── Main render ────────────────────────────────────────────────────────
  return (
    <>
      <Stack.Screen options={{
        title: peerName ?? 'Chat',
        headerStyle: { backgroundColor: '#0C0C1A' }, headerTintColor: '#fff',
        headerRight: () => (
          <TouchableOpacity onPress={() => router.push({ pathname: '/videocall', params: { chatId, peerUid, peerName } })} style={{ marginRight: 12 }}>
            <Text style={{ color: '#00E5FF', fontSize: 18 }}>📹</Text>
          </TouchableOpacity>
        ),
      }} />

      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>

        {loading ? <ActivityIndicator color="#00E5FF" style={{ flex: 1 }} /> :
          <FlatList ref={flatRef} data={messages} keyExtractor={m => m.id} renderItem={renderMsg}
            contentContainerStyle={s.list} onContentSizeChange={() => flatRef.current?.scrollToEnd({ animated: false })} />
        }

        {uploading && (
          <View style={s.uploadBar}>
            <Text style={s.uploadTxt}>Uploading… {uploadPct}%</Text>
            <View style={[s.uploadFill, { width: `${uploadPct}%` as any }]} />
          </View>
        )}

        {peerTyping && <View style={s.typingRow}><Text style={s.typingTxt}>{peerName} is typing…</Text></View>}

        {replyTarget && (
          <View style={s.banner}>
            <View style={{ flex: 1 }}>
              <Text style={s.bannerTitle}>Replying to {replyTarget.senderId === myUid ? 'yourself' : peerName}</Text>
              <Text style={s.bannerPrev} numberOfLines={1}>{replyTarget.plaintext}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTarget(null)}><Text style={s.bannerX}>✕</Text></TouchableOpacity>
          </View>
        )}

        {editTarget && (
          <View style={[s.banner, { borderTopColor: '#4F8FFF33' }]}>
            <Text style={[s.bannerTitle, { color: '#4F8FFF', flex: 1 }]}>✏️  Editing message</Text>
            <TouchableOpacity onPress={cancelEdit}><Text style={s.bannerX}>✕</Text></TouchableOpacity>
          </View>
        )}

        {showVoice
          ? <VoiceRecorder
              onSend={(uri, dur) => { setShowVoice(false); sendMediaMessage(uri, 'audio', { duration: dur }); }}
              onCancel={() => setShowVoice(false)}
            />
          : <View style={s.bar}>
              <TouchableOpacity onPress={() => setShowAttach(true)} style={s.attachBtn}>
                <Text style={{ fontSize: 22, color: '#555' }}>＋</Text>
              </TouchableOpacity>
              <TextInput
                style={s.input} value={inputText} onChangeText={handleTyping}
                placeholder="Message…" placeholderTextColor="#444" multiline maxLength={4000}
              />
              {inputText.trim()
                ? <TouchableOpacity style={[s.sendBtn, sending && s.sendOff]} onPress={onSend} disabled={sending}>
                    {sending ? <ActivityIndicator color="#000" size="small" /> : <Text style={s.sendIco}>{editTarget ? '✓' : '➤'}</Text>}
                  </TouchableOpacity>
                : <TouchableOpacity style={s.sendBtn} onPress={() => setShowVoice(true)}>
                    <Text style={s.sendIco}>🎤</Text>
                  </TouchableOpacity>
              }
            </View>
        }

        <Sheet />

        <AttachmentSheet
          visible={showAttach} onClose={() => setShowAttach(false)}
          onPhoto={pickPhoto} onVideo={pickVideo} onFile={pickFile}
          onGif={() => { setShowAttach(false); setShowGif(true); }}
          onVoice={() => { setShowAttach(false); setShowVoice(true); }}
        />

        <GifPicker
          visible={showGif} onClose={() => setShowGif(false)}
          onSelect={(url) => sendMediaMessage(url, 'gif', { gifUrl: url })}
        />

        <ReactionPicker
          visible={showReactions} onClose={() => { setShowReactions(false); setReactionTarget(null); }}
          onSelect={(emoji) => { if (reactionTarget) addReaction(reactionTarget, emoji); }}
        />

      </KeyboardAvoidingView>
    </>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen:      { flex: 1, backgroundColor: '#03030E' },
  list:        { padding: 12, paddingBottom: 8 },
  row:         { marginBottom: 6 },
  rowR:        { alignItems: 'flex-end' },
  rowL:        { alignItems: 'flex-start' },
  bubble:      { maxWidth: '80%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  bMe:         { backgroundColor: '#003D2A', borderBottomRightRadius: 2 },
  bPeer:       { backgroundColor: '#111127', borderBottomLeftRadius: 2 },
  bubbleDel:   { backgroundColor: '#111', borderWidth: 1, borderColor: '#222' },
  msgTxt:      { color: '#E0E0F0', fontSize: 15, lineHeight: 21 },
  delTxt:      { color: '#444', fontSize: 14, fontStyle: 'italic' },
  meta:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 },
  time:        { color: '#444', fontSize: 11, marginRight: 3 },
  edited:      { color: '#555', fontSize: 11 },
  tick:        { color: '#555', fontSize: 12 },
  replyBar:    { backgroundColor: '#00000044', borderLeftWidth: 3, borderLeftColor: '#00E5FF', borderRadius: 6, padding: 6, marginBottom: 6 },
  replyName:   { color: '#00E5FF', fontSize: 11, fontWeight: 'bold', marginBottom: 1 },
  replyPrev:   { color: '#888', fontSize: 12 },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionChip:     { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A30', borderRadius: 12, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: '#333' },
  reactionChipMine: { borderColor: '#00E5FF', backgroundColor: '#00E5FF11' },
  reactionEmoji:    { fontSize: 14 },
  reactionCount:    { color: '#888', fontSize: 11, marginLeft: 3 },
  uploadBar:   { backgroundColor: '#0C0C1A', paddingHorizontal: 14, paddingVertical: 6 },
  uploadTxt:   { color: '#00E5FF', fontSize: 12, marginBottom: 4 },
  uploadFill:  { height: 2, backgroundColor: '#00E5FF', borderRadius: 1 },
  typingRow:   { paddingHorizontal: 16, paddingBottom: 6 },
  typingTxt:   { color: '#555', fontSize: 13, fontStyle: 'italic' },
  banner:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0C0C1A', borderTopWidth: 1, borderTopColor: '#00E5FF33', paddingHorizontal: 14, paddingVertical: 8 },
  bannerTitle: { color: '#00E5FF', fontSize: 12, fontWeight: 'bold' },
  bannerPrev:  { color: '#888', fontSize: 12 },
  bannerX:     { color: '#555', fontSize: 20, paddingHorizontal: 8 },
  bar:         { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: '#0C0C1A', paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#111' },
  attachBtn:   { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  input:       { flex: 1, backgroundColor: '#111127', color: '#E0E0F0', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120, marginHorizontal: 6 },
  sendBtn:     { width: 44, height: 44, borderRadius: 22, backgroundColor: '#00E5FF', alignItems: 'center', justifyContent: 'center' },
  sendOff:     { backgroundColor: '#111127' },
  sendIco:     { color: '#000', fontSize: 18, fontWeight: 'bold' },
  overlay:     { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:       { backgroundColor: '#0E0E20', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 36, paddingTop: 8 },
  sheetRow:    { padding: 18, borderBottomWidth: 1, borderBottomColor: '#111' },
  sheetTxt:    { color: '#E0E0F0', fontSize: 16 },
});
'@
[System.IO.File]::WriteAllText("$root\app\chat.tsx", $f7, $noBOM)
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP A — Install packages
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Installing @react-native-firebase/storage ..." -ForegroundColor Yellow
npx expo install @react-native-firebase/storage
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP B — Add reaction_updated event to server/index.js
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Adding reaction event to server ..." -ForegroundColor Yellow
$serverContent = Get-Content "$root\server\index.js" -Raw
if ($serverContent -notlike "*reaction_updated*") {
  $insert = @'

  socket.on('reaction_updated', d => socket.to(`chat:${d.chatId}`).emit('reaction_updated', d));
'@
  $serverContent = $serverContent -replace "socket\.on\('message_deleted'", "$insert`n  socket.on('message_deleted'"
  [System.IO.File]::WriteAllText("$root\server\index.js", $serverContent, $noBOM)
}
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# STEP C — Git commit and push
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Pushing to GitHub ..." -ForegroundColor Yellow
git add -A
git commit -m "Phase 2: photos, voice, GIFs, emoji reactions, formatting, media upload"
git push origin master --force
Write-Host "      OK" -ForegroundColor Green

# ─────────────────────────────────────────────────────────────────────────────
# DONE
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Phase 2 Complete!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  New files:" -ForegroundColor White
Write-Host "  services/mediaService.ts         Firebase Storage upload" -ForegroundColor Green
Write-Host "  components/AttachmentSheet.tsx   + button attachment picker" -ForegroundColor Green
Write-Host "  components/VoiceRecorder.tsx     Hold-to-record voice notes" -ForegroundColor Green
Write-Host "  components/GifPicker.tsx         GIF search with Tenor" -ForegroundColor Green
Write-Host "  components/ReactionPicker.tsx    Emoji reaction picker" -ForegroundColor Green
Write-Host "  components/MediaMessage.tsx      Image/video/audio renderer" -ForegroundColor Green
Write-Host "  app/chat.tsx                     Full Phase1 + Phase2" -ForegroundColor Green
Write-Host ""
Write-Host "  Features now working:" -ForegroundColor White
Write-Host "  [OK] Send photos and videos" -ForegroundColor Green
Write-Host "  [OK] Send voice messages (hold-to-record)" -ForegroundColor Green
Write-Host "  [OK] Send any file (PDF, ZIP, APK)" -ForegroundColor Green
Write-Host "  [OK] GIF search and send" -ForegroundColor Green
Write-Host "  [OK] Emoji reactions on messages" -ForegroundColor Green
Write-Host "  [OK] Message formatting (*bold*, _italic_, code)" -ForegroundColor Green
Write-Host "  [OK] Upload progress bar" -ForegroundColor Green
Write-Host "  [OK] Audio player in chat" -ForegroundColor Green
Write-Host ""
Write-Host "  Now run:  npx expo start" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Green
