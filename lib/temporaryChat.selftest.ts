// lib/temporaryChat.selftest.ts — run: npx tsx lib/temporaryChat.selftest.ts
//
// The Chats header starts a TEMPORARY chat: pick 1 hour or 3 hours, then pick
// who with, and the chosen chat gets that disappearing-messages timer before it
// opens.
//
// This is guarded because its failure mode is silent and it is a PRIVACY
// promise. If the ttl stops being applied nothing errors — the chat opens, the
// banner still said "messages will disappear", and the person believes a
// conversation is temporary while it is permanent. Someone adding a second
// `router.push('/chat')` to new-chat.tsx would do exactly that.

import { readFileSync } from 'node:fs';

const CHATS = readFileSync('app/(tabs)/chats.tsx', 'utf8');
const NEW = readFileSync('app/new-chat.tsx', 'utf8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}`);
};

console.log('\nTemporary chat\n');

// ── the header slot ───────────────────────────────────────────────────
check('the Mini Apps header shortcut is gone',
  !/router\.push\('\/mini'/.test(CHATS),
  'it duplicated the Apps tab; the slot is the temporary-chat entry point now');

check('...and the temporary-chat button took its place',
  /setTempSheet\(true\)/.test(CHATS) && /timer-outline/.test(CHATS));

// ── the two durations that were asked for ─────────────────────────────
check('offers 1 hour', /startTemporary\(3600\)/.test(CHATS));
check('offers 3 hours', /startTemporary\(10800\)/.test(CHATS));
check('carries the choice to /new-chat as ttl',
  /pathname: '\/new-chat', params: \{ ttl:/.test(CHATS));

// ── the receiving side ────────────────────────────────────────────────
check('new-chat reads the ttl', /useLocalSearchParams<\{ ttl\?: string \}>/.test(NEW));
check('...and only treats a positive number as a ttl',
  /Number\(ttl\) > 0 \? Number\(ttl\) : null/.test(NEW),
  'a junk param must mean "normal chat", never NaN seconds');

check('applies it with setDisappearing before opening',
  /setDisappearing\(chatId, ttlSeconds\)/.test(NEW));

// EVERY route out of this screen must go through openWithTtl. A direct
// router.push to /chat is the silent regression this file exists to catch.
const directPushes = NEW.match(/router\.(push|replace)\(\{\s*pathname: '\/chat'/g) ?? [];
check('no route to /chat bypasses openWithTtl',
  directPushes.length === 0,
  `${directPushes.length} direct navigation(s) to /chat — those would open a chat with NO timer`);

check('openWithTtl is defined',
  /const openWithTtl = async \(/.test(NEW));

// Both ways off this screen: picking an existing contact, and adding by phone
// number. Missing either one makes the feature work "sometimes", which is worse
// than not working at all.
check('both entry points use it — the contact list and the phone-number add',
  (NEW.match(/openWithTtl\(/g) ?? []).length === 2,
  `${(NEW.match(/openWithTtl\(/g) ?? []).length} call sites, expected 2`);

// ── the promise has to be honest ──────────────────────────────────────
check('a failed setDisappearing tells the user rather than opening quietly',
  /Could not make this chat temporary/.test(NEW),
  'silently opening a permanent chat is the one outcome this must never have');

check('the mode is visible while choosing a person',
  /ttlBanner/.test(NEW) && /will disappear/.test(NEW));

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all temporary-chat checks passed\n');
process.exit(failures ? 1 : 0);
