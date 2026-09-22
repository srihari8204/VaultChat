export type Eye = 'right' | 'left';
export type CheckPhase = Eye | 'switch' | 'result';
export type CheckStep = {
  phase: CheckPhase;
  eye: Eye;
  stage: number;
  trial: number;
  correct: number;
  rightCorrect: number;
  leftCorrect: number;
  rightCompleted: number;
  leftCompleted: number;
  seed: number;
};

export const TRIALS_PER_EYE = 16;
export const STAGE_MIN = -3;
export const STAGE_MAX = 8;
export const SCREEN_LEVELS = STAGE_MAX - STAGE_MIN + 1;
export const CLEAR_SCREEN_MATCHES = 14;
export const ORIENTATIONS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
// Screen-response points only: fewer matched gaps are negative, more are positive. Not diopters.
export function screenClarityIndex(correct: number): number {
  return Math.floor(Math.max(0, Math.min(TRIALS_PER_EYE, correct)) / 2) - 4;
}
export const INITIAL_CHECK_STEP: CheckStep = {
  phase: 'right', eye: 'right', stage: 0, trial: 0, correct: 0,
  rightCorrect: 0, leftCorrect: 0, rightCompleted: 0, leftCompleted: 0, seed: 0,
};

// A stage is a phone-screen difficulty step, not a calibrated Snellen acuity.
export function symbolScale(stage: number): number {
  return 0.84 ** Math.max(STAGE_MIN, Math.min(STAGE_MAX, stage));
}

export function expectedOrientation(step: CheckStep): typeof ORIENTATIONS[number] {
  const cycle = Math.floor(step.trial / ORIENTATIONS.length);
  const index = ((step.seed + step.trial * 3 + cycle + (step.eye === 'left' ? 4 : 0)) % ORIENTATIONS.length + ORIENTATIONS.length) % ORIENTATIONS.length;
  return ORIENTATIONS[index];
}

export function answerCheck(step: CheckStep, chosenOrientation: number | null): CheckStep {
  if (step.phase !== 'right' && step.phase !== 'left') return step;
  const passed = chosenOrientation === expectedOrientation(step);
  const correct = step.correct + Number(passed);
  const level = passed ? Math.max(0, step.stage - STAGE_MIN + 1) : 0;
  const result = step.eye === 'right'
    ? { ...step, rightCorrect: correct, rightCompleted: Math.max(step.rightCompleted, level) }
    : { ...step, leftCorrect: correct, leftCompleted: Math.max(step.leftCompleted, level) };
  if (step.trial + 1 === TRIALS_PER_EYE) {
    return { ...result, phase: step.eye === 'right' ? 'switch' : 'result', trial: TRIALS_PER_EYE, correct };
  }
  return {
    ...result,
    trial: step.trial + 1,
    correct,
    stage: Math.max(STAGE_MIN, Math.min(STAGE_MAX, step.stage + (passed ? 1 : -1))),
  };
}

export function startLeftEye(step: CheckStep): CheckStep {
  if (step.phase !== 'switch') return step;
  return { ...step, phase: 'left', eye: 'left', stage: 0, trial: 0, correct: 0 };
}
