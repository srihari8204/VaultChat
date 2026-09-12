// lib/notificationActions.selftest.ts — run: npx tsx lib/notificationActions.selftest.ts
//
// AUDIT F6. Reply-from-notification has three ways to go wrong, and two of them
// are invisible until a user complains:
//
//   1. the reply opens the app — which is the behaviour it exists to replace;
//   2. the reply is sent directly instead of through the durable outbox, so a
//      reply typed with no signal vanishes with no trace and no retry;
//   3. the action fires AND the tap routing fires, so replying also navigates.
//
// lib/notificationActions imports expo-notifications and react-native, so this
// reads the source. That is the right depth for what must not regress here: the
// failures above are all visible as wiring, not as arithmetic.

import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const ACT = read('lib/notificationActions.ts');
const PUSH = read('lib/push.ts');
const LOCAL = read('lib/messageNotifications.ts');
const LAYOUT = read('app/_layout.tsx');
const GO = read('vaultchat-backend-go/internal/routes/chats_helpers.go');

console.log('\nNotification-actions self-test\n');

console.log('The actions exist and do not open the app:');
check('a Reply action with a text input', /identifier: ACTION_REPLY[\s\S]{0,200}textInput:/.test(ACT));
check('a Mark as read action', /identifier: ACTION_MARK_READ/.test(ACT));
check('neither opens the app to the foreground',
  (ACT.match(/opensAppToForeground: false/g) ?? []).length === 2,
  'opening the app to send a reply is the behaviour this replaces');

console.log('\nThe reply goes through the DURABLE outbox:');
check('it enqueues rather than sending directly', /await enqueueText\(chatId, text\)/.test(ACT),
  'a direct send loses a reply typed with no signal');
check('it does not call the raw send path', !/sendMessage\(/.test(ACT));
check('an empty reply sends nothing', /if \(text\) await enqueueText/.test(ACT),
  'a user who opened the input and thought better of it must not send a blank message');

console.log('\nAn action consumes the response:');
check('handleMessageAction reports whether it handled it', /: Promise<boolean>/.test(ACT));
check('a non-action response is passed through', /if \(action !== ACTION_REPLY && action !== ACTION_MARK_READ\) return false;/.test(ACT));
check('the listener runs actions BEFORE tap routing',
  PUSH.indexOf('handleMessageAction(response)') < PUSH.indexOf('routeNotificationTap('));
check('tap routing is skipped when an action handled it',
  /if \(handled\) return;/.test(PUSH),
  'replying must not also navigate to the chat');

console.log('\nBoth delivery paths carry the category:');
check('the local (no-GMS) notification sets it', /categoryIdentifier: MESSAGE_CATEGORY/.test(LOCAL));
check('the server sets it on message pushes', /msg\["categoryId"\] = "message"/.test(GO));
check('and ONLY on message pushes',
  /if t, _ := data\["type"\]\.\(string\); t == "message"/.test(GO),
  'a reply box on a push that cannot be replied to is worse than no button');

console.log('\nMark-as-read knows what "read" means:');
check('the local notification carries the message id', /messageId: id/.test(LOCAL));
check('the Expo push carries it', /"messageId": msg\.ID/.test(GO));
check('the FCM data-only push carries it too', /"messageId": msg\.ID/.test(GO));
check('a failed server read does not undo the local one',
  /await markSeen\(chatId, upTo\);\s*\n\s*try \{ await markRead/.test(ACT),
  'the user has read it either way');

console.log('\nIt is registered before anything can arrive:');
check('registered at module scope in the root layout',
  /^registerMessageActions\(\)\.catch\(\(\) => \{\}\);$/m.test(LAYOUT));
check('registration is idempotent', /if \(registered \|\| Platform\.OS === 'web'\) return;/.test(ACT));
check('a device that refuses categories still gets the notification',
  /catch \{[\s\S]{0,300}\}\s*\n\}/.test(ACT));

console.log(failures === 0 ? '\nAll notification-action checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
