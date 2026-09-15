// lib/games/sfx.ts — game sound effects.
//
// The tones themselves are baked into assets/games/sfx/*.wav by
// scripts/gen-game-sfx.mjs, from the same specs the web client synthesises
// live with Web Audio. See that script for why they are copied rather than
// retuned.
//
// Sound in a turn-based game is FEEDBACK, not decoration: it confirms the
// server accepted a move without the player having to watch the board, and it
// is what makes a capture land. So it must be cheap enough to fire on every
// tap and must never block or throw into the render path.

import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type Sfx =
  | 'select' | 'tick' | 'error' | 'win'
  | 'roll' | 'move' | 'capture' | 'home' | 'six'
  | 'capture2' | 'check' | 'promote' | 'lose' | 'draw'
  | 'deal' | 'discard';

// require() must be literal for Metro to bundle the asset, so this map cannot
// be built from the Sfx union at runtime.
const FILES: Record<Sfx, number> = {
  select:   require('../../assets/games/sfx/select.wav'),
  tick:     require('../../assets/games/sfx/tick.wav'),
  error:    require('../../assets/games/sfx/error.wav'),
  win:      require('../../assets/games/sfx/win.wav'),
  roll:     require('../../assets/games/sfx/roll.wav'),
  move:     require('../../assets/games/sfx/move.wav'),
  capture:  require('../../assets/games/sfx/capture.wav'),
  home:     require('../../assets/games/sfx/home.wav'),
  six:      require('../../assets/games/sfx/six.wav'),
  capture2: require('../../assets/games/sfx/capture2.wav'),
  check:    require('../../assets/games/sfx/check.wav'),
  promote:  require('../../assets/games/sfx/promote.wav'),
  lose:     require('../../assets/games/sfx/lose.wav'),
  draw:     require('../../assets/games/sfx/draw.wav'),
  deal:     require('../../assets/games/sfx/deal.wav'),
  discard:  require('../../assets/games/sfx/discard.wav'),
};

const KEY = 'vc_games_sound';

let enabled = true;
let volume = 0.8;
let ready = false;
let readying: Promise<void> | null = null;
const loaded = new Map<Sfx, Audio.Sound>();

AsyncStorage.getItem(KEY)
  .then(v => { if (v === 'off') enabled = false; })
  .catch(() => {});

export function soundEnabled(): boolean { return enabled; }

export async function setSoundEnabled(on: boolean): Promise<void> {
  enabled = on;
  try { await AsyncStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
  if (!on) await stopAll();
}

/**
 * Game sound must duck under a call, not fight it.
 *
 * `MixWithOthers` + not staying active in the background means a table left
 * open never holds the audio session, and a ringtone or a crazzychat call is
 * never talked over by a dice roll.
 */
async function prepare(): Promise<void> {
  if (ready) return;
  if (readying) return readying;
  readying = (async () => {
    try {
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: false,       // a muted phone means muted games
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
        interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      });
      ready = true;
    } catch {
      // A device that refuses the audio mode still plays; it just will not
      // duck. Silence is worse than imperfect routing.
      ready = true;
    }
  })();
  return readying;
}

/**
 * Warm the effects a screen is about to need.
 *
 * Loading on first play costs tens of milliseconds, which lands exactly on the
 * tap it is meant to confirm and reads as lag. Boards call this on mount.
 */
export async function preloadSfx(names: Sfx[]): Promise<void> {
  await prepare();
  await Promise.all(names.map(async name => {
    if (loaded.has(name)) return;
    try {
      const { sound } = await Audio.Sound.createAsync(FILES[name], { volume, shouldPlay: false });
      // Two mounts can race here; keep the first and discard the loser rather
      // than leaking a second native player.
      if (loaded.has(name)) { await sound.unloadAsync().catch(() => {}); return; }
      loaded.set(name, sound);
    } catch {}
  }));
}

/**
 * Fire an effect. Never awaited by callers, never throws.
 *
 * `setPositionAsync(0)` then `playAsync()` rather than `replayAsync()`: replay
 * on an already-playing sound restarts it, which is what we want for rapid
 * taps, but it also rejects if the sound is mid-unload during teardown.
 */
export function playSfx(name: Sfx): void {
  if (!enabled) return;
  void (async () => {
    try {
      await prepare();
      let s = loaded.get(name);
      if (!s) {
        const { sound } = await Audio.Sound.createAsync(FILES[name], { volume, shouldPlay: false });
        if (loaded.has(name)) { await sound.unloadAsync().catch(() => {}); s = loaded.get(name)!; }
        else { loaded.set(name, sound); s = sound; }
      }
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch {
      // A missing or busy sound must never break a move.
    }
  })();
}

/** Release every loaded effect. Call when leaving the games section. */
export async function stopAll(): Promise<void> {
  const all = [...loaded.values()];
  loaded.clear();
  await Promise.all(all.map(s => s.unloadAsync().catch(() => {})));
}
