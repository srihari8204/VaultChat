// components/call/inviteResult.selftest.ts — npx tsx components/call/inviteResult.selftest.ts
import assert from 'node:assert/strict';
import { inviteAndDescribe, inviteResultMessage } from './inviteResult';

let n = 0;
const ok = (cond: boolean, what: string) => { assert.ok(cond, what); n++; };

async function main(): Promise<void> {
  ok(inviteResultMessage('Asha', 1).startsWith('Calling Asha'), '1. a ring says who is being called');
  ok(/already on this call|ended/.test(inviteResultMessage('Asha', 0)), '2. zero rung is NOT reported as success');
  ok(/Could not invite Asha/.test(inviteResultMessage('Asha', 'error')), '3. a throw reads as a failure');
  ok(inviteResultMessage('   ', 2).startsWith('Calling They'), '4. a blank name still yields a sentence');

  ok((await inviteAndDescribe(async () => 1, 'Ben')).startsWith('Calling Ben'), '5. resolves the success sentence');
  ok(/Could not invite Ben/.test(await inviteAndDescribe(async () => { throw new Error('x'); }, 'Ben')),
    '6. never throws; a rejected invite becomes the failure sentence');
  let calls = 0;
  await inviteAndDescribe(async () => { calls++; return 1; }, 'C');
  ok(calls === 1, '7. runs the invite exactly once');

  console.log(`inviteResult.selftest: ${n} assertions passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
