// lib/launchGateRemount.selftest.ts — app/index.tsx must wait for the CURRENT
// root mount's gate decision, not the first one this JS process saw.
//
// Round-5 regression: index read "has the gate decided" from a process flag,
// while the root gate effect runs per mount. When the React tree remounts and
// JS survives (Android activity re-creation), index's first render saw
// "decided" and routed by the previous mount's edge in parallel with the new
// gate's replace — e.g. into Chats while the new gate sends the launch to
// /app-lock, which also left the veil up. 📱 whether that remount happens.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  beginLaunchGate, currentLaunchDecision, launchAllowed, launchGatePending, settleLaunchGate,
} from './launchGate';

let failures = 0;
function ok(label: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
}
/** The promise's value if it has settled within a macrotask, else 'pending'. */
async function peek<T>(p: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>(r => setTimeout(() => r('pending'), 0))]);
}

async function main() {
  console.log('launchGate — one decision per root mount\n');

  console.log('First mount:');
  ok('pending at load (index\'s visit is the cold one)', launchGatePending());
  beginLaunchGate();
  ok('the first mount keeps the process decision', currentLaunchDecision() === launchAllowed);
  ok('…which has not settled', await peek(currentLaunchDecision()) === 'pending');
  beginLaunchGate(); // StrictMode runs the initializer twice
  ok('re-arming a pending decision is a no-op', currentLaunchDecision() === launchAllowed);
  settleLaunchGate(true);
  ok('settled: allowed', await peek(currentLaunchDecision()) === true && !launchGatePending());

  console.log('\nRemount while JS survives (first launch allowed, now locked):');
  beginLaunchGate();
  const second = currentLaunchDecision();
  ok('pending again, so index waits instead of routing on the old edge', launchGatePending());
  ok('a fresh decision, not the settled one', second !== launchAllowed && await peek(second) === 'pending');
  settleLaunchGate(false);
  ok('index gets THIS mount\'s answer (false: the root has replaced it)', await peek(second) === false);
  ok('launchAllowed still says how the first mount went', await peek(launchAllowed) === true);
  ok('a later visit after this mount decided is not cold', !launchGatePending());

  console.log('\nRemount before the previous mount decided:');
  beginLaunchGate();
  const third = currentLaunchDecision();
  beginLaunchGate();
  ok('the pending decision is kept, so the new gate settles the one index holds', currentLaunchDecision() === third);
  settleLaunchGate(true);
  ok('…and it resolves', await peek(third) === true);

  console.log('\nThe wiring:');
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
  const layout = read('app', '_layout.tsx');
  const index = read('app', 'index.tsx');
  const gateAt = layout.indexOf("Promise.all([secure, getLaunchSessionState(), isMfaEnabled()])");
  const armAt = layout.indexOf('useState(beginLaunchGate);');
  ok('the root re-arms in render, before its gate effect', armAt > 0 && armAt < gateAt);
  ok('index reads cold and the decision once, on its first render',
    /useState\(launchGatePending\)/.test(index) && /useState\(currentLaunchDecision\)/.test(index));
  ok('index no longer awaits the process-wide promise', !/await launchAllowed/.test(index));
  ok('pendingLink no longer keeps a process "decided" flag',
    !/launchGateDecided|gateDecided/.test(read('lib', 'pendingLink.ts').replace(/\/\/.*$/gm, '')));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
void main();
