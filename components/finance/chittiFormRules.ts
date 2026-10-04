// components/finance/chittiFormRules.ts — the checks the new Lucky Draw group
// form runs before Create. Pure, asserted by chittiFormRules.selftest.ts. Same
// shape as ledgerFormRules: every failing field is reported, so the form can
// mark each one inline; `problem` is the first, for the Alert.

import { num } from '../../utils/financeFormat';

export interface ChittiFormText {
  name: string; chitValue: string; installment: string; members: string; duration: string;
}
export type ChittiFormField = 'name' | 'chitValue' | 'installment' | 'members' | 'duration';
export interface ChittiFormProblem { title: string; message: string; field: ChittiFormField }
export type ChittiFormCheck =
  | { problem: ChittiFormProblem; problems: ChittiFormProblem[] }
  | { ok: { name: string; chitValue: number; installment: number; members: number; duration: number } };

export function checkChittiForm(f: ChittiFormText): ChittiFormCheck {
  const no = (title: string, message: string, field: ChittiFormField): ChittiFormProblem => ({ title, message, field });
  const name = f.name.trim();
  const cv = num(f.chitValue), inst = num(f.installment), mem = num(f.members), dur = num(f.duration);
  const checks: (ChittiFormProblem | undefined)[] = [
    !name ? no('Name', 'Enter a group name.', 'name') : undefined,
    !(cv > 0) ? no('Chit value', 'Enter a chit value greater than 0.', 'chitValue') : undefined,
    !(inst > 0) ? no('Installment', 'Enter a monthly installment.', 'installment') : undefined,
    // Whole numbers of at least 1: 0.4 members used to pass `> 0` and then
    // round to a group of 0, and 2.5 months has no third auction.
    !(Number.isInteger(mem) && mem >= 1) ? no('Members', 'Enter the number of members as a whole number, 1 or more.', 'members') : undefined,
    !(Number.isInteger(dur) && dur >= 1) ? no('Duration', 'Enter the duration as a whole number of months, 1 or more.', 'duration') : undefined,
  ];
  const problems = checks.filter((p): p is ChittiFormProblem => !!p);
  if (problems.length) return { problem: problems[0], problems };
  return { ok: { name, chitValue: cv, installment: inst, members: mem, duration: dur } };
}
