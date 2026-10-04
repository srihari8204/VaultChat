// components/chat/bubbleA11yLabel.selftest.ts — run: npx tsx components/chat/bubbleA11yLabel.selftest.ts
import assert from 'node:assert/strict';
import { bubbleA11yLabel } from './bubbleA11yLabel';

const base = { isMine: false, senderName: 'Asha', type: 'text', text: 'see you at 6', time: '10:42' };

assert.equal(bubbleA11yLabel(base), 'Asha: see you at 6, 10:42');
assert.equal(bubbleA11yLabel({ ...base, isMine: true, tick: 'read' }), 'You: see you at 6, 10:42, read');
assert.equal(bubbleA11yLabel({ ...base, isMine: true, tick: 'pending' }), 'You: see you at 6, 10:42, sending');
assert.equal(bubbleA11yLabel({ ...base, tick: 'read' }), 'Asha: see you at 6, 10:42', 'ticks are only spoken for your own');
assert.equal(bubbleA11yLabel({ ...base, senderName: null }), 'Someone: see you at 6, 10:42');
assert.equal(bubbleA11yLabel({ ...base, edited: true }), 'Asha: see you at 6, 10:42, edited');
assert.equal(bubbleA11yLabel({ ...base, isMine: true, failed: true, tick: null }),
  'You: see you at 6, 10:42, not sent, double tap to retry');

// Privacy: the label must never carry text the bubble itself hides.
const ink = bubbleA11yLabel({ ...base, inkHidden: true });
assert.ok(!ink.includes('see you'), 'unrevealed Invisible Ink text is never spoken');
assert.equal(ink, 'Asha: Invisible Ink message, tilt your phone to read, 10:42');
const vo = bubbleA11yLabel({ ...base, type: 'image', viewOnce: true, caption: 'secret' });
assert.equal(vo, 'Asha: View once photo, 10:42');
assert.equal(bubbleA11yLabel({ ...base, type: 'video', revoked: true }), 'Asha: Media revoked, 10:42');

// Media and other kinds.
assert.equal(bubbleA11yLabel({ ...base, type: 'image', text: '', caption: 'beach' }), 'Asha: Photo: beach, 10:42');
assert.equal(bubbleA11yLabel({ ...base, type: 'file', text: '', filename: 'a.pdf' }), 'Asha: File: a.pdf, 10:42');
assert.equal(bubbleA11yLabel({ ...base, type: 'audio', text: '' }), 'Asha: Voice message, 10:42');
assert.equal(bubbleA11yLabel({ ...base, type: 'sticker', text: '😀' }), 'Asha: 😀, 10:42');
assert.equal(bubbleA11yLabel({ ...base, type: 'text', text: '' }), 'Asha: Message, 10:42');

console.log('bubbleA11yLabel selftest: ok');
