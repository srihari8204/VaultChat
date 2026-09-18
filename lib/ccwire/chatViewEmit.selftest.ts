// lib/ccwire/chatViewEmit.selftest.ts — run: npx tsx lib/ccwire/chatViewEmit.selftest.ts
//
// GUARDS A DELIBERATE REVERT: chat_view must stay on app_event (100), even
// against a server that advertises Capabilities.typed_app_bodies (9).
//
// This file previously asserted the opposite, with a full fake-wire harness.
// The emit side of the typed ViewerState (body 82) migration was correct; the
// REPLY is what breaks:
//
//   app_event chat_view -> handlers.go onChatViewPeer -> replies `viewer_list`
//                          as an app_event (100), which hooks/useChatViewers.ts
//                          consumes.
//   typed body 82       -> ccwire_presence.go viewerState -> replies with TYPED
//                          body 83 (ViewerList).
//
// transport.ts decodes only body 81 and body 100 — everything else returns
// early — and codec.ts has no reader for 83 at all (name-only). So the initial
// roster the server sends on `isNew || resync` would be decoded by nobody and
// silently dropped.
//
// It fails PARTIALLY, which is why it would have shipped: viewer_joined,
// viewer_left and viewer_activity still arrive as app_event, so an open chat
// keeps updating incrementally — the list just never populates on entry.
//
// WHY A SOURCE SCAN AND NOT A WIRE TEST. The behaviour being guarded is "this
// branch does not exist". Driving emit() to prove a body is absent needs the
// whole client/transport harness stood up to observe nothing happen — more
// machinery than the claim is worth, and machinery that can break for reasons
// unrelated to the claim. typingEmit.selftest.ts already exercises the real
// wire path for body 81, so the harness is not lost.
//
// TO REDO THE MIGRATION: add a body-83 reader to codec.ts and decode it in
// transport.ts FIRST. Then restore the branch and flip this file back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, 'eventsSocket.ts'), 'utf8');

let checks = 0;
function ok(name: string, cond: boolean): void {
  checks++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) {
    process.exitCode = 1;
    throw new assert.AssertionError({ message: name });
  }
}

console.log('\nchat_view stays on app_event (100)\n');

// The revert itself. Body 82 must not be emitted from anywhere in the event
// facade until a body-83 reader exists.
ok('eventsSocket never emits body_field 82',
  !/body_field:\s*82/.test(src));

// The revert must not have been applied too widely: typing stays migrated.
ok('typing is still migrated to body_field 81',
  /body_field:\s*81/.test(src));

// The app_event fallback is the single remaining send for chat_view.
ok('the app_event (100) send is still present',
  /body_field:\s*100/.test(src));

// The reason is recorded where the next person will look, not only here.
ok('the revert reason is documented at the site',
  src.includes('83') && /ViewerList|viewer_list/.test(src));

console.log(`\nchat_view revert guard: ${checks} checks passed\n`);
