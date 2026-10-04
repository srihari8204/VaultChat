// npx tsx lib/messageReminderReset.selftest.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MESSAGE_REMINDER_BODY, isMessageReminderRequest } from './messageReminderReset';

const mine = { content: { body: MESSAGE_REMINDER_BODY, data: { chatId: 'c1', messageId: '42' } } };
assert.equal(isMessageReminderRequest(mine), true);
// Another feature's notification with a chat route but different text is kept.
assert.equal(isMessageReminderRequest({ content: { body: 'Task due', data: { chatId: 'c1' } } }), false);
// Same body but no chat/message (not ours) is kept.
assert.equal(isMessageReminderRequest({ content: { body: MESSAGE_REMINDER_BODY, data: {} } }), false);
assert.equal(isMessageReminderRequest({ content: { body: MESSAGE_REMINDER_BODY, data: null } }), false);
assert.equal(isMessageReminderRequest({ content: null }), false);
assert.equal(isMessageReminderRequest({}), false);
// The screen must schedule with the shared constant, and offer the reset.
// app/message-reminder.tsx was split: its list and stored list live in
// components/chattools, so the screen and its parts are read as one source.
const REMINDER_FILES = ['app/message-reminder.tsx', 'components/chattools/RemindersList.tsx', 'components/chattools/reminderStore.ts'];
const src = REMINDER_FILES.map(f => readFileSync(f, 'utf8')).join('\n');
assert.ok(/body:\s*MESSAGE_REMINDER_BODY/.test(readFileSync('app/message-reminder.tsx', 'utf8')), 'reminders are scheduled with MESSAGE_REMINDER_BODY');
assert.ok(/isMessageReminderRequest/.test(src) && /Clear reminders/.test(src), 'list offers Clear reminders');
console.log('messageReminderReset selftest: ok');
