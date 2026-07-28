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
  // 0..1 normalized amplitude samples, downsampled to <= 48 bars so the
  // bubble UI can render a Telegram-style waveform without parsing PCM.
  // Empty array if the platform didn't deliver metering data.
  waveform:   number[];
}

let current: Audio.Recording | null = null;
let startedAt = 0;
// Raw dB samples accumulated by the status callback; dropped on cancel/stop.
let meterSamples: number[] = [];

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
  // Sample meter ~10 times per second. expo-av emits `metering` in dB
  // (-160 = silence, 0 = peak). We collect raw and downsample on stop.
  meterSamples = [];
  recording.setProgressUpdateInterval(100);
  recording.setOnRecordingStatusUpdate((status: any) => {
    if (!status?.isRecording) return;
    const m = (status as any).metering;
    if (typeof m === 'number' && Number.isFinite(m)) meterSamples.push(m);
  });

  await recording.startAsync();
  current = recording;
  startedAt = Date.now();
}

// Reduce a long dB stream to ~32 normalized [0..1] bars by averaging
// chunks. dB values are typically [-60..0]; clamp + scale so anything
// quieter than -60 dB reads as 0 and 0 dB reads as 1.
function downsampleMeters(raw: number[], bars: number): number[] {
  if (raw.length === 0) return [];
  const targetBars = Math.min(bars, raw.length);
  const chunkSize  = raw.length / targetBars;
  const out: number[] = [];
  for (let i = 0; i < targetBars; i++) {
    const start = Math.floor(i * chunkSize);
    const end   = Math.floor((i + 1) * chunkSize);
    let sum = 0, n = 0;
    for (let j = start; j < end && j < raw.length; j++) { sum += raw[j]; n++; }
    const avgDb = n > 0 ? sum / n : -60;
    const clamped = Math.max(-60, Math.min(0, avgDb));
    // Map [-60..0] dB → [0..1] amplitude. Floor at 0.05 so a "silent"
    // bar still renders a hint of itself (more visually consistent).
    out.push(Math.max(0.05, (clamped + 60) / 60));
  }
  return out;
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
  const waveform   = downsampleMeters(meterSamples, 32);
  meterSamples = [];
  startedAt = 0;
  const filename = `voice-${Date.now()}.m4a`;
  const mime     = Platform.OS === 'web' ? 'audio/webm' : 'audio/m4a';
  return { uri, filename, mime, durationMs, waveform };
}

/** Throw away the active recording. */
export async function cancel(): Promise<void> {
  if (!current) return;
  const recording = current;
  current = null;
  startedAt = 0;
  meterSamples = [];
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
