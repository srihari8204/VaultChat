// lib/forwardPolicy.selftest.ts — run: npx tsx lib/forwardPolicy.selftest.ts
//
// AUDIT F10. The hop counter is the whole feature, and the two ways to get it
// wrong are both silent: lose the count and every viral message looks like a
// friend's first share; mishandle messages that predate the field and the label
// disappears from history that already carries it.

import fs from 'node:fs';
import path from 'node:path';

import {
  FORWARD_MANY_THRESHOLD, forwardLabel, forwardNotice, forwardScoreOf,
  isForwarded, isForwardedManyTimes, maxForwardTargets, nextForwardScore,
} from './forwardPolicy';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

console.log('\nForward-policy self-test\n');

const origin = {};
const once = { forwardedFrom: { messageId: 1, chatId: 'c', senderId: 's' }, forwardScore: 1 };
const legacy = { forwardedFrom: { messageId: 1, chatId: 'c', senderId: 's' } }; // predates forwardScore
const many = { ...once, forwardScore: FORWARD_MANY_THRESHOLD };

console.log('Counting hops:');
check('an original message scores 0', forwardScoreOf(origin) === 0);
check('no meta at all scores 0', forwardScoreOf(undefined) === 0 && forwardScoreOf(null) === 0);
check('a forwarded message carries its score', forwardScoreOf(once) === 1);
check('a message forwarded BEFORE this feature counts as 1, not 0',
  forwardScoreOf(legacy) === 1,
  'treating it as 0 strips the label off every message already in history');
check('forwarding increments', nextForwardScore(once) === 2);
check('forwarding an original produces 1', nextForwardScore(origin) === 1);
check('forwarding a pre-feature message produces 2', nextForwardScore(legacy) === 2);

console.log('\nA hostile client cannot break rendering:');
check('a negative score reads as unforwarded', forwardScoreOf({ forwardScore: -5 }) === 0);
check('a non-numeric score reads as unforwarded', forwardScoreOf({ forwardScore: 'lots' }) === 0);
check('NaN reads as unforwarded', forwardScoreOf({ forwardScore: NaN }) === 0);
check('a fractional score is floored', forwardScoreOf({ forwardScore: 3.9 }) === 3);
check('an absurd score is clamped', forwardScoreOf({ forwardScore: 1e9 }) === 1000);

console.log('\nTwo tiers, and only two:');
check('an original message has no label', forwardLabel(origin) === null);
check('one hop says Forwarded', forwardLabel(once) === '↪ Forwarded');
check('four hops still says Forwarded', forwardLabel({ forwardScore: 4 }) === '↪ Forwarded');
check(`${FORWARD_MANY_THRESHOLD} hops says many times`, forwardLabel(many) === '↪↪ Forwarded many times');
check('the label never shows the number',
  !/[0-9]/.test(forwardLabel({ forwardScore: 7 }) ?? ''),
  'a visible count reads as a popularity score');
check('isForwarded agrees with the label', isForwarded(once) && !isForwarded(origin));
check('isForwardedManyTimes is inclusive of the threshold', isForwardedManyTimes(many));

console.log('\nThe fan-out cap tightens as a message travels:');
check('an ordinary message may go to 5 chats', maxForwardTargets(once) === 5);
check('a many-times message may go to 1', maxForwardTargets(many) === 1);
check('only the many-times case warns', forwardNotice(once) === null && forwardNotice(many) !== null);

console.log('\nThe wiring is in place:');
const SVC = read('lib/chatService.ts');
check('forwardMessage sends what forwardPayload decides', /const p = forwardPayload\(source\)/.test(SVC));
check('forwardPayload writes the next score', /forwardScore: nextForwardScore\(/.test(read('lib/forwardPayload.ts')));
const BUBBLE = read('components/chat/MessageBubble.tsx');
check('the bubble renders the policy label, not a hard-coded string',
  /forwardLabel\(msg\.meta\)/.test(BUBBLE));
// app/chat.tsx was split into components/chat/*; read the screen and its parts as one source.
const CHAT = ['app/chat.tsx', 'components/chat/ChatHeader.tsx', 'components/chat/InChatSearchBar.tsx', 'components/chat/ChatBanners.tsx', 'components/chat/MessageRow.tsx', 'components/chat/ComposerBars.tsx', 'components/chat/Composer.tsx', 'components/chat/ChatModals.tsx', 'components/chat/MediaCaptionPreview.tsx', 'components/chat/ChatLockGate.tsx', 'components/chat/useChatMenu.ts', 'components/chat/useMessageActions.ts', 'components/chat/useMessagePaging.ts', 'components/chat/useVoiceRecording.ts', 'components/chat/useTiltReveal.ts', 'components/chat/useMediaStaging.ts'].map((f) => read(f)).join('\n');
check('the forward sheet shows the notice', /forwardNotice\(/.test(CHAT));

console.log(failures === 0 ? '\nAll forward-policy checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
