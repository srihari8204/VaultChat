// scripts/gen-game-sfx.mjs — bake the games' sound effects into WAV files.
//
//   node scripts/gen-game-sfx.mjs
//
// The web client synthesises every effect live with Web Audio oscillators
// (games-web/ludo.js, chess.js). React Native has no oscillator, so the same
// tone specs are rendered to small WAVs here and bundled instead.
//
// The numbers below are COPIED from those files rather than retuned by ear.
// Game audio is a set of relative pitches — capture is lower than move, the win
// fanfare climbs — and re-inventing them one at a time loses the relationship
// between them even when each sound is fine on its own.
//
// Rerun after editing TONES; the output is committed so a normal build needs
// no audio toolchain.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'games', 'sfx');
const RATE = 22050;          // plenty for tones under 1.1kHz; a quarter the size of 44.1k

/** [frequency, seconds, waveform, peak gain, start-delay ms] — as playTone(). */
const TONES = {
  // ── shared ──
  select:  [[660, 0.04, 'sine', 0.06, 0]],
  tick:    [[880, 0.04, 'sine', 0.08, 0]],
  error:   [[200, 0.10, 'sawtooth', 0.10, 0]],
  win:     [[523, 0.10, 'sine', 0.15, 0], [659, 0.10, 'sine', 0.15, 80],
            [784, 0.15, 'sine', 0.15, 160], [1047, 0.20, 'sine', 0.15, 240]],
  // ── ludo ──
  roll:    [[200, 0.06, 'square', 0.10, 0], [300, 0.06, 'square', 0.10, 40],
            [250, 0.06, 'square', 0.10, 80], [350, 0.08, 'square', 0.12, 120]],
  move:    [[440, 0.08, 'sine', 0.10, 0]],
  capture: [[150, 0.15, 'sawtooth', 0.15, 0], [100, 0.10, 'sawtooth', 0.12, 80]],
  home:    [[523, 0.08, 'sine', 0.12, 0], [659, 0.08, 'sine', 0.12, 60],
            [784, 0.12, 'sine', 0.12, 120]],
  six:     [[440, 0.08, 'sine', 0.12, 0], [550, 0.08, 'sine', 0.12, 60],
            [660, 0.10, 'sine', 0.12, 120]],
  // ── chess ──
  // Chess capture is brighter than ludo's: a piece leaving the board, not a
  // token being knocked home.
  capture2: [[220, 0.12, 'sawtooth', 0.15, 0], [180, 0.08, 'sawtooth', 0.10, 30]],
  check:   [[660, 0.10, 'square', 0.12, 0], [880, 0.10, 'square', 0.10, 80]],
  promote: [[523, 0.08, 'sine', 0.12, 0], [659, 0.08, 'sine', 0.12, 60],
            [784, 0.12, 'sine', 0.12, 120]],
  lose:    [[330, 0.15, 'sawtooth', 0.12, 0], [220, 0.20, 'sawtooth', 0.12, 120]],
  draw:    [[440, 0.10, 'sine', 0.10, 0], [440, 0.10, 'sine', 0.10, 120]],
  // ── rummy ──
  // Not in the web client, which reuses `select` for a draw. A card leaving the
  // deck deserves its own sound: it is the one irreversible act in a turn.
  deal:    [[520, 0.05, 'sine', 0.09, 0], [430, 0.06, 'sine', 0.08, 45]],
  discard: [[330, 0.07, 'sine', 0.10, 0]],
};

const wave = (type, phase) => {
  switch (type) {
    case 'square':   return Math.sin(phase) >= 0 ? 1 : -1;
    // Ramp from -1 to 1 across the cycle, matching Web Audio's sawtooth.
    case 'sawtooth': return 2 * ((phase / (2 * Math.PI)) % 1) - 1;
    default:         return Math.sin(phase);
  }
};

/**
 * Render one tone stack to mono float samples.
 *
 * Envelope matches playTone(): a 10ms linear attack to `vol`, then an
 * exponential fall to 0.001 over the tone's duration. The attack is what stops
 * each note starting with a click.
 */
function render(parts) {
  const end = Math.max(...parts.map(([, dur, , , delay]) => delay / 1000 + dur));
  const n = Math.ceil(end * RATE) + 1;
  const buf = new Float64Array(n);

  for (const [freq, dur, type, vol, delay] of parts) {
    const start = Math.round((delay / 1000) * RATE);
    const len = Math.round(dur * RATE);
    const attack = Math.max(1, Math.round(0.01 * RATE));
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / RATE;
      const env = i < attack
        ? (vol * i) / attack
        : vol * Math.pow(0.001 / vol, (t - attack / RATE) / Math.max(1e-6, dur - attack / RATE));
      buf[start + i] += wave(type, 2 * Math.PI * freq * t) * env;
    }
  }
  return buf;
}

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    // Clip rather than wrap: a summed stack can exceed 1.0 and wrapping turns
    // a loud moment into a burst of noise.
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);            // PCM
  head.writeUInt16LE(1, 22);            // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);     // byte rate
  head.writeUInt16LE(2, 32);            // block align
  head.writeUInt16LE(16, 34);           // bits
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [name, parts] of Object.entries(TONES)) {
  const buf = wav(render(parts));
  writeFileSync(join(OUT, `${name}.wav`), buf);
  total += buf.length;
  console.log(`  ${name}.wav  ${(buf.length / 1024).toFixed(1)} KB`);
}
console.log(`\n${Object.keys(TONES).length} effects, ${(total / 1024).toFixed(0)} KB total → ${OUT}`);
