// lib/chatLockReceipts.selftest.ts — run: npx tsx lib/chatLockReceipts.selftest.ts
//
// A locked chat that is opened but NOT unlocked must not tell the other side it
// was read. The lock gate in app/chat.tsx only covers the screen; the read
// receipt, the "viewing" presence and the notification clear are separate
// effects, and each one used to fire under the veil. This pins all three to the
// gate's own state (`lockState === 'open'`), plus the menu entry that lets a
// user create a lock at all.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('app/chat.tsx', 'utf8');

// The state must be declared before the effects that read it (hook order and
// TDZ: a const used in a deps array is evaluated during render).
const decl = SRC.indexOf("const [lockState, setLockState] = useState<'checking' | 'open' | 'locked'>('checking')");
assert.ok(decl > 0, 'lockState state exists');
const readEffect = SRC.indexOf('// ── Mark-as-read (debounced)');
assert.ok(readEffect > decl, 'lockState is declared before the read effect');

// 1. Read receipts: scheduled only while open, re-checked when the timer fires
//    and when the cleanup flushes a pending read.
const readBody = SRC.slice(readEffect, SRC.indexOf('// ── Unread divider', readEffect));
assert.ok(/if \(!appActive \|\| !cvFocused \|\| lockState !== 'open'/.test(readBody), 'read effect bails while the gate is up');
assert.ok(/!chatFocusedRef\.current \|\| !lockOpenRef\.current\) return;/.test(readBody), 'timer re-checks the lock at send time');
assert.ok(/if \(!lockOpenRef\.current \|\| !latestId/.test(readBody), 'cleanup flush does not mark read on a re-veil');
assert.ok(/\[appActive, cvFocused, lockState, meId, chatId, messages\]/.test(readBody), 'read effect re-runs on lock changes');
assert.ok(/lockOpenRef\.current = lockState === 'open';/.test(SRC), 'lockOpenRef tracks the gate during render');

// 2. "Viewing" presence only while open.
assert.ok(/useChatViewers\(\{[^}]*enabled: cvShareOn && lockState === 'open'/.test(SRC), 'viewer presence gated on the lock');

// 3. Notifications are not cleared for a chat the user has not unlocked.
assert.ok(/if \(lockState === 'open'\) clearMessageNotifications\(chatId\);/.test(SRC), 'notification clear gated on the lock');
assert.equal((SRC.match(/clearMessageNotifications\(/g) || []).length, 1, 'no other ungated notification clear');

// 4. A lock can be created from the chat.
assert.ok(/pathname: '\/app-lock-chats'/.test(SRC), 'chat menu links to the per-chat lock screen');

console.log('chatLockReceipts selftest: ok');
