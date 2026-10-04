// lib/media/videoResumeKey.selftest.ts — run: npx tsx lib/media/videoResumeKey.selftest.ts
import assert from 'node:assert/strict';
import { videoResumeKey } from './videoResumeKey';
import { resumeKey } from '../videoSeek';

const dir = 'file:///data/user/0/com.vaultchat/cache/media/';
const a = videoResumeKey(dir + 'holiday.mp4');
const b = videoResumeKey(dir + 'meeting.mp4');
assert.notEqual(a, b, 'two videos in one folder get two keys');
// The old key could not tell them apart — the bug this replaces.
assert.equal(resumeKey(dir + 'holiday.mp4'), resumeKey(dir + 'meeting.mp4'));
assert.equal(a, videoResumeKey(dir + 'holiday.mp4'), 'stable for the same file');
assert.ok(!a.includes('data') && !a.includes(Buffer.from(dir).toString('base64').slice(0, 12)), 'no readable path');
assert.match(videoResumeKey('file:///x/नमस्ते.mp4'), /^vc_video_pos_h_[0-9a-f]{32}$/, 'non-Latin names hash too');
console.log('videoResumeKey selftest: all passed');
