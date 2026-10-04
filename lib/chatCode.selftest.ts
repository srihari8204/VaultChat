// lib/chatCode.selftest.ts — run: npx tsx lib/chatCode.selftest.ts
//
// A chat code opens a chat with someone whose number you do not have. The
// server side of that is covered by routes/chat_codes_test.go and migration
// 118's SQL test; what neither of those can see is the CLIENT, and the client is
// where this feature fails silently.
//
// Every check below guards an outcome that produces no error, no crash and no
// visible symptom — just a promise quietly broken:
//
//   * "Save this contact" sending keepContact:false would switch Ghost Mode on
//     for someone you deliberately kept. Their last-seen, typing and read
//     receipts vanish for good, and nothing anywhere says why.
//   * "Until I delete" sending keepContact:true would do the reverse — hand a
//     stranger your presence signals when the row promised they stay a stranger.
//   * A wrong number on 1 hour / 3 hours means messages outlive what the screen
//     said. The chat works perfectly; only the promise is false.
//   * A code left on screen past its two minutes gets read out to somebody and
//     fails at their end, looking like a server fault.
//
// The API tests cannot catch any of these: they assert what the server does
// with the arguments it is given, and all four options are individually valid.
// Only the mapping from row to argument is at stake here, and it lives in the
// screen.

import { readFileSync } from 'node:fs';

const SCREEN  = readFileSync('app/chat-code.tsx', 'utf8');
// app/chat.tsx was split into components/chat/*; read the screen and its parts as one source.
const SCREENCHAT = ['app/chat.tsx', 'components/chat/ChatHeader.tsx', 'components/chat/InChatSearchBar.tsx', 'components/chat/ChatBanners.tsx', 'components/chat/MessageRow.tsx', 'components/chat/ComposerBars.tsx', 'components/chat/Composer.tsx', 'components/chat/ChatModals.tsx', 'components/chat/MediaCaptionPreview.tsx', 'components/chat/ChatLockGate.tsx', 'components/chat/useChatMenu.ts', 'components/chat/useMessageActions.ts', 'components/chat/useMessagePaging.ts', 'components/chat/useVoiceRecording.ts', 'components/chat/useTiltReveal.ts', 'components/chat/useMediaStaging.ts'].map((f) => readFileSync(f, 'utf8')).join('\n');
const CHATS   = readFileSync('app/(tabs)/chats.tsx', 'utf8');
const SERVICE = readFileSync('lib/chatService.ts', 'utf8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nChat codes\n');

// ── the four options, and what each one actually sends ────────────────
// Parsed out of the real OPTIONS array rather than restated, so this reads the
// same data the screen renders.
type Row = { label: string; ttl: string; keep: string };
const rows: Row[] = [...SCREEN.matchAll(
  /label:\s*'([^']+)',[\s\S]*?ttl:\s*(null|\d+),\s*keep:\s*(true|false)/g,
)].map(m => ({ label: m[1], ttl: m[2], keep: m[3] }));

const row = (label: string) => rows.find(r => r.label === label);

check('all four options are present',
  rows.length === 4,
  `found ${rows.length}: ${rows.map(r => r.label).join(', ')}`);

check('1 hour is 3600 seconds',   row('1 hour')?.ttl === '3600',   row('1 hour')?.ttl);
check('3 hours is 10800 seconds', row('3 hours')?.ttl === '10800', row('3 hours')?.ttl);

check('"Until I delete" sets no timer',
  row('Until I delete')?.ttl === 'null', row('Until I delete')?.ttl);
check('"Save this contact" sets no timer',
  row('Save this contact')?.ttl === 'null', row('Save this contact')?.ttl);

// The whole difference between the last two rows. If these ever match, one of
// them is a duplicate row that lies about what it does.
check('"Save this contact" KEEPS the contact (keepContact: true)',
  row('Save this contact')?.keep === 'true',
  'a kept contact would be silently ghosted');
check('"Until I delete" leaves them a stranger (keepContact: false)',
  row('Until I delete')?.keep === 'false',
  'a stranger would silently get your presence signals');
check('the timed options do not keep the contact',
  row('1 hour')?.keep === 'false' && row('3 hours')?.keep === 'false');

// ── the chosen row is what actually gets sent ─────────────────────────
check('generate forwards BOTH fields from the chosen row',
  /createChatCode\(\{\s*ttlSeconds:\s*pick\.ttl,\s*keepContact:\s*pick\.keep\s*\}\)/.test(SCREEN),
  'hardcoding either one would make three of the four rows decorative');

check('the API layer sends keepContact to the server',
  /keepContact:\s*!!opts\.keepContact/.test(SERVICE));
check('the API layer maps a null timer to 0, which the server reads as "no timer"',
  /ttlSeconds:\s*opts\.ttlSeconds\s*\?\?\s*0/.test(SERVICE));

// ── the timer is the SERVER's job, not the client's ───────────────────
// /new-chat deliberately calls setDisappearing after opening a chat. Doing the
// same here would put the owner's promise in the hands of the stranger's client,
// and give the chat two sources of truth for its timer.
check('joining does NOT set the timer client-side',
  !/setDisappearing/.test(SCREEN),
  'the server stamps it inside the redeem, before it answers');

// ── a dead code must not stay on screen ───────────────────────────────
check('the countdown clears the code when it hits zero',
  /if\s*\(s\s*===\s*0\)\s*onDead\.current\(\)/.test(SCREEN),
  'digits that stopped working still get read out to people');
check('the countdown ticks every second',
  /setInterval\(tick,\s*1000\)/.test(SCREEN) && /clearInterval/.test(SCREEN),
  'and is cleaned up');
check('time left is compared as a NUMBER, not a formatted string',
  /left\s*<=\s*30/.test(SCREEN) && !/left\s*<\s*'/.test(SCREEN),
  "string comparison on mm:ss silently misorders at the minute boundary");

// ── the code the user types ───────────────────────────────────────────
check('the entry field keeps digits only and stops at six',
  /replace\(\/\\D\/g,\s*''\)\.slice\(0,\s*6\)/.test(SCREEN));
check('Open chat is refused until six digits are present',
  /typed\.length\s*!==\s*6/.test(SCREEN));
check('the submitted value is re-stripped rather than trusted from state',
  /const digits = typed\.replace\(\/\\D\/g, ''\)/.test(SCREEN));

// ── the entry points exist ────────────────────────────────────────────
// The screen is unreachable without these; a route that renders and cannot be
// opened is the same as no feature.
check('the Chats temporary-chat sheet offers both halves',
  /label="Share a code"/.test(CHATS) && /label="Enter a code"/.test(CHATS));
check('both rows route to /chat-code with a mode',
  /pathname:\s*'\/chat-code',\s*params:\s*\{\s*mode\s*\}/.test(CHATS));

// ── the two-minute life is stated where it is read ────────────────────
// Someone who does not know the code dies in two minutes will write it down and
// use it later. Saying so on both tabs is the cheapest fix for that.
check('both tabs say the code expires in two minutes',
  (SCREEN.match(/two minutes/g) ?? []).length >= 2);

// ── the self-destruct has to be VISIBLE (migration 120) ───────────────
// A 1h/3h code deletes the WHOLE conversation. The server has always known the
// deadline; until the countdown existed the person in the chat did not, so it
// simply vanished mid-sentence — which reads as data loss, not as the feature
// working. These guard the only warning there is.
const CHATSTYLES = readFileSync('components/chat/chatStyles.ts', 'utf8');

check('the chat header counts down to the deletion',
  /deletes itself in/.test(SCREENCHAT) && /expiryLabel/.test(SCREENCHAT),
  'the server sends expiresAt; something has to render it');
check('the countdown goes red near the end',
  /expiresIn <= 600/.test(SCREENCHAT),
  'ten minutes is where "I will reply later" stops being an option');
check('the countdown interval is cleaned up',
  /clearInterval\(h\)/.test(SCREENCHAT));
check('the chat LIST flags an expiring chat without opening it',
  /chat\.expiresAt &&/.test(CHATS) && /timer-outline/.test(CHATS),
  'finding out by the chat being gone is finding out too late');
check('the countdown styles exist',
  /expiryRow:/.test(CHATSTYLES) && /expiryTxt:/.test(CHATSTYLES));
check('the API type carries expiresAt',
  /expiresAt\?:\s*string \| null;/.test(SERVICE));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all chat-code checks passed\n');
process.exit(failures ? 1 : 0);
