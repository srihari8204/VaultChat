// constants/securityQuestionPool.ts — the 12 security questions (codes MUST match
// the backend SECURITY_QUESTION_CODES set in routes/auth.js). The onboarding flow
// makes the user pick 5 distinct ones and answer each.

export interface SecurityQuestion { code: string; label: string }

export const SECURITY_QUESTION_POOL: SecurityQuestion[] = [
  { code: 'first_pet',            label: 'What was the name of your first pet?' },
  { code: 'mother_maiden',        label: "What is your mother's maiden name?" },
  { code: 'birth_city',           label: 'In which city were you born?' },
  { code: 'primary_school',       label: 'What was the name of your primary school?' },
  { code: 'childhood_friend',     label: 'What is the name of your childhood best friend?' },
  { code: 'first_car',            label: 'What was the make of your first car?' },
  { code: 'favourite_teacher',    label: 'What is the name of your favourite teacher?' },
  { code: 'street_grew_up',       label: 'What was the name of the street you grew up on?' },
  { code: 'first_job_city',       label: 'In which city did you take your first job?' },
  { code: 'favourite_book',       label: 'What is the title of your favourite book?' },
  { code: 'oldest_cousin',        label: 'What is the name of your oldest cousin?' },
  { code: 'maternal_grandfather', label: "What was your maternal grandfather's first name?" },
];

export const REQUIRED_SECURITY_ANSWERS = 5;

export function questionLabel(code: string): string {
  return SECURITY_QUESTION_POOL.find(q => q.code === code)?.label ?? code;
}
