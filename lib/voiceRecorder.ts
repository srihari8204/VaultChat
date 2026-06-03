// Voice message recording (Day 7).
//
// Thin wrapper around expo-av's Audio.Recording. Each call to start()
// creates a fresh recording — only one can be active at a time.
// Files land in the OS temp dir as .m4a (AAC), then get uploaded via
// lib/chatService.uploadAttachment to /uploads — same flow as images.
//
// expo-av is being deprecated for SDK 54 → 55 in favour of expo-audio
// (we see the warning on Metro boot). When you migrate this file is the
// one place to touch — the rest of the app talks to start/stop/cancel.

import { Audio } from 'expo-av';
import { Platform } from 'react-native';

export interface RecordingResult {
  uri:        string;
  filename:   string;
  mime:       string;
  durationMs: number;
}

let current: Audio.Recording | null = null;
let startedAt = 0;

async function ensureMicPermission(): Promise<void> {
  const perm = await Audio.requestPermissionsAsync();
  if (!perm.granted) throw new Error('Microphone permission denied');
}

/**
 * Start a new recording. Throws if mic permission is denied or another
 * recording is already in progress.
 */
export async function start(): Promise<void> {
  if (current) throw new Error('Recording already in progress');
  await ensureMicPermission();

  await Audio.setAudioModeAsync({
    allowsRecordingIOS:    true,
    playsInSilentModeIOS:  true,
    staysActiveInBackground: false,
  });

  const recording = new Audio.Recording();
  await recording.prepareToRecordAsync({
    isMeteringEnabled: true,
    android: {
      extension: '.m4a',
      outputFormat: Audio.AndroidOutputFormat.MPEG_4,
      audioEncoder: Audio.AndroidAudioEncoder.AAC,
      sampleRate:  44100,
      numberOfChannels: 1,
      bitRate: 96000,
    },
    ios: {
      extension: '.m4a',
      outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
      audioQuality: Audio.IOSAudioQuality.MEDIUM,
      sampleRate:  44100,
      numberOfChannels: 1,
      bitRate: 96000,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: { mimeType: 'audio/webm', bitsPerSecond: 96000 },
  });
  await recording.startAsync();
  current = recording;
  startedAt = Date.now();
}

/**
 * Stop the active recording and return the file. Returns null if there
 * was no active recording (e.g. user cancelled before stop).
 */
export async function stop(): Promise<RecordingResult | null> {
  if (!current) return null;
  const recording = current;
  current = null;
  try {
    await recording.stopAndUnloadAsync();
  } catch {
    // already stopped
  }
  const uri = recording.getURI();
  if (!uri) return null;
  const durationMs = Math.max(500, Date.now() - startedAt);
  startedAt = 0;
  const filename = `voice-${Date.now()}.m4a`;
  const mime     = Platform.OS === 'web' ? 'audio/webm' : 'audio/m4a';
  return { uri, filename, mime, durationMs };
}

/** Throw away the active recording. */
export async function cancel(): Promise<void> {
  if (!current) return;
  const recording = current;
  current = null;
  startedAt = 0;
  try { await recording.stopAndUnloadAsync(); } catch {}
}

export function isActive(): boolean { return current !== null; }

/** Milliseconds since the active recording started; 0 if not recording. */
export function elapsedMs(): number {
  return startedAt ? Date.now() - startedAt : 0;
}

// expo-router requires a default export on every file under app/. lib/
// isn't a route folder but we keep the same hygiene.
export default {};
