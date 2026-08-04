// lib/lock/alarmChannels.ts — the impure half of the alarm: real speakers and
// motors behind the AlarmDrivers interface that alarmController orchestrates.
//
//  * Tone   — expo-av looped playback of the bundled siren/beep WAVs (generated,
//             CC0). playsInSilentModeIOS + staysActiveInBackground so the alarm
//             keeps sounding with the screen off; volume is the user's alarm
//             volume (relative to the media stream — Android's alarm-stream
//             loudness for the killed-app path comes from the notifee channel).
//  * Vibe   — RN Vibration with looped patterns per the chosen intensity.
//  * Voice  — expo-speech TTS, short lines only.
//
// The full-screen flash channel is UI (app/lock-alert.tsx reads the phase) —
// nothing to drive here.

import { Vibration, Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as Speech from 'expo-speech';
import { type AlarmDrivers, type AlarmPhase } from './alarmController';
import { type LockTone, type LockVibe } from './lockSettings';

const TONE_ASSET: Record<LockTone, any> = {
  siren: require('../../assets/sounds/lock_siren.wav'),
  beep: require('../../assets/sounds/lock_beep.wav'),
};

// [wait, on, off, …] ms — looped by Vibration.vibrate(pattern, true).
const VIBE_PATTERN: Record<LockVibe, number[]> = {
  strong: [0, 800, 250],
  medium: [0, 400, 300],
  pulse: [0, 150, 150],
};

let sound: Audio.Sound | null = null;
let soundGen = 0;              // async guard: only the latest start keeps playing
let vibing = false;

async function startToneAsync(tone: LockTone, volume: number): Promise<void> {
  const gen = ++soundGen;
  await stopToneAsync();
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
    });
    const { sound: s } = await Audio.Sound.createAsync(
      TONE_ASSET[tone],
      { isLooping: true, volume: Math.max(0.05, Math.min(1, volume)) },
    );
    if (gen !== soundGen) { s.unloadAsync().catch(() => {}); return; }   // superseded
    sound = s;
    await s.playAsync();
  } catch { /* no audio (emulator, focus loss) — vibration + UI still alert */ }
}

async function stopToneAsync(): Promise<void> {
  const s = sound;
  sound = null;
  if (s) { try { await s.stopAsync(); } catch {} try { await s.unloadAsync(); } catch {} }
}

/** Real drivers for the controller. `onPhase` is supplied by the lock service. */
export function realAlarmDrivers(onPhase: (p: AlarmPhase) => void): AlarmDrivers {
  return {
    startTone(tone, volume) { startToneAsync(tone, volume); },
    stopTone() { soundGen++; stopToneAsync(); },
    startVibe(pattern) {
      if (Platform.OS === 'web') return;
      try { Vibration.cancel(); } catch {}
      Vibration.vibrate(VIBE_PATTERN[pattern], true);
      vibing = true;
    },
    stopVibe() {
      if (!vibing) return;
      try { Vibration.cancel(); } catch {}
      vibing = false;
    },
    speak(text) {
      try {
        Speech.stop();
        Speech.speak(text, { rate: 1.0, pitch: 1.0 });
      } catch {}
    },
    onPhase,
  };
}

export default {};
