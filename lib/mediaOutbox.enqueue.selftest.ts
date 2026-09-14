// lib/mediaOutbox.enqueue.selftest.ts — run: npx tsx lib/mediaOutbox.enqueue.selftest.ts
//
// THE MEDIA TWIN OF THE messageQueue.enqueue() DATA-LOSS BUG.
//
// save() wrapped queueReplace in `catch {}`, so a failed write (disk full, the
// cache DEK not loaded yet, a locked database) returned normally. enqueueMedia
// then returned the item unconditionally, chat.tsx painted an optimistic pending
// bubble from it, and flush() went on to read a queue the row was never in.
//
// Nothing sends, and nothing can ever SAY nothing sent: emit('failed') is only
// ever reached for items found in the queue. The spinner turns forever and the
// bubble is simply gone after a restart — "acked to the UI, never persisted",
// indistinguishable from being offline, so never reported as data loss.
//
// The fix mirrors lib/messageQueue.ts exactly: the write reports whether it
// landed, and enqueue throws when it did not. Callers already alert on a
// throwing send.
//
// lib/mediaOutbox.ts imports react-native / expo modules, so it cannot be loaded
// under Node. This asserts against the SOURCE, like lib/messageQueue.latency
// does, and is honest about being a source-level check.

import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'lib', 'mediaOutbox.ts'), 'utf8');

// Strip line comments so the assertions test the code, not the prose above it —
// the fix deliberately quotes the old behaviour to explain what must not return.
const CODE = SRC.split('\n').map(l => {
  const i = l.indexOf('//');
  return i >= 0 ? l.slice(0, i) : l;
}).join('\n');

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

console.log('\nMedia outbox — a pending bubble must never outlive a failed write\n');

console.log('1. save() reports whether the queue reached SQLite:');
check('save() is typed Promise<boolean>',
  /async function save\(q: MediaOutboxItem\[\]\): Promise<boolean>/.test(CODE));
check('...returns true after queueReplace resolves',
  /await queueReplace\('media',[\s\S]*?\);\s*return true;/.test(CODE));
check('...and false on throw, instead of swallowing it',
  /catch \{ return false; \}/.test(CODE));
// The regression this guards: reverting to the silent catch.
check('no bare `catch {}` remains on the save path',
  !/queueReplace\([\s\S]{0,200}?\} catch \{\}/.test(CODE));

console.log('\n2. enqueueMedia throws rather than acking a row it did not store:');
check('the save result is tested',
  /if \(!\(await save\(q\)\)\)/.test(CODE));
check('...and a throw is what happens when it failed',
  /if \(!\(await save\(q\)\)\) \{[\s\S]{0,400}?throw new Error\(/.test(CODE));
check('...the durable file copy is not orphaned by that throw',
  /if \(!\(await save\(q\)\)\) \{[\s\S]{0,400}?deleteAsync\(srcPath[\s\S]{0,200}?throw new Error\(/.test(CODE));
check('...so the item is returned only AFTER a successful save',
  CODE.indexOf('if (!(await save(q)))') < CODE.lastIndexOf('return item;'));

console.log('\n3. The invariant the bug broke — no failure is silent:');
// emit('failed') only ever fires for items found in the queue, which is exactly
// why an unstored item could never produce one. Pin that shape so the throw
// stays the only notification path for a write that did not land.
check("every emit('failed') sits downstream of a load()",
  CODE.split("emit('failed'").length - 1 >= 3 && /const cur = await load\(\)/.test(CODE));

console.log(failures === 0 ? '\nPASS\n' : `\nFAIL — ${failures} check(s)\n`);
process.exit(failures === 0 ? 0 : 1);
