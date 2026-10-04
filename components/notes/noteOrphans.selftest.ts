// components/notes/noteOrphans.selftest.ts — run: npx tsx components/notes/noteOrphans.selftest.ts
import assert from 'node:assert/strict';
import { orphanAttachmentIds } from './noteOrphans';

const notes = [{ attachments: [{ id: 'a' }, { id: 'b' }] }, { attachments: undefined }, { attachments: [{ id: 't' }] }];
// rerate7/J: a kept draft (its files d1, d2) was replaced by a newer one (n1).
assert.deepEqual(orphanAttachmentIds(['a', 'b', 't', 'd1', 'd2', 'n1'], notes, ['n1']), ['d1', 'd2'], 'the replaced draft\'s files go; the restored draft keeps its own');
assert.deepEqual(orphanAttachmentIds(['a', 'b', 't'], notes), [], 'every saved note keeps its files, trash included');
assert.deepEqual(orphanAttachmentIds([], notes, ['x']), []);
assert.deepEqual(orphanAttachmentIds(['x', 'y'], [], ['y']), ['x']);
console.log('noteOrphans.selftest: all checks passed');
