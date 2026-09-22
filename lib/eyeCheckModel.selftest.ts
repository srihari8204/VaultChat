import assert from 'node:assert/strict';
import { answerCheck, expectedOrientation, INITIAL_CHECK_STEP, ORIENTATIONS, screenClarityIndex, STAGE_MAX, STAGE_MIN, startLeftEye, symbolScale, TRIALS_PER_EYE } from './eyeCheckModel';

assert.equal(screenClarityIndex(0), -4);
assert.equal(screenClarityIndex(8), 0);
assert.equal(screenClarityIndex(14), 3);
assert.equal(screenClarityIndex(16), 4);

let step = INITIAL_CHECK_STEP;
let previous: number | null = null;
for (let trial = 0; trial < TRIALS_PER_EYE; trial++) {
  const orientation = expectedOrientation(step);
  assert.ok(ORIENTATIONS.includes(orientation));
  assert.notEqual(orientation, previous);
  previous = orientation;
  step = answerCheck(step, orientation);
  assert.equal(step.rightCorrect, trial + 1);
  assert.ok(step.stage <= STAGE_MAX);
}
assert.equal(step.phase, 'switch');
assert.equal(step.trial, TRIALS_PER_EYE);
assert.equal(step.rightCompleted, STAGE_MAX - STAGE_MIN + 1);
assert.equal(answerCheck(step, null), step);

step = startLeftEye(step);
assert.equal(step.eye, 'left');
assert.equal(step.trial, 0);
assert.equal(step.correct, 0);
previous = null;
for (let trial = 0; trial < TRIALS_PER_EYE; trial++) {
  const orientation = expectedOrientation(step);
  assert.notEqual(orientation, previous);
  previous = orientation;
  step = answerCheck(step, null);
  assert.equal(step.leftCorrect, 0);
  assert.ok(step.stage >= STAGE_MIN);
}
assert.equal(step.phase, 'result');
assert.equal(step.leftCompleted, 0);
assert.equal(step.rightCorrect, TRIALS_PER_EYE);
assert.ok(symbolScale(STAGE_MIN) > symbolScale(0));
assert.ok(symbolScale(STAGE_MAX) < symbolScale(0));
assert.ok(64 * symbolScale(STAGE_MAX) < 20, 'the finest C level is smaller than the previous 20 dp floor');
assert.notEqual(expectedOrientation(INITIAL_CHECK_STEP), expectedOrientation({ ...INITIAL_CHECK_STEP, seed: 1 }));
assert.notEqual(expectedOrientation(INITIAL_CHECK_STEP), expectedOrientation({ ...INITIAL_CHECK_STEP, trial: ORIENTATIONS.length }));
console.log('Eye Check adaptive flow OK');
