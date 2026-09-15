// Execute the actual chat-screen receipt handlers, not a duplicate algorithm.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../app/chat.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('chat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const handlers = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
    ['onMemberDelivered', 'onMemberRead'].includes(node.name.text)) {
    assert(!handlers.has(node.name.text), `ambiguous handler ${node.name.text}`);
    handlers.set(node.name.text, node.initializer.getText(tree));
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(handlers.size, 2, 'both production receipt handlers must be extracted');
type Member = { userId: string; lastDeliveredMessageId: number; lastReadMessageId: number };
type Chat = { members: Member[] };
let chat: Chat | null = { members: [
  { userId: 'peer', lastDeliveredMessageId: 50, lastReadMessageId: 40 },
  { userId: 'other', lastDeliveredMessageId: 7, lastReadMessageId: 6 },
] };
const queued: { chatId: string; cursor: number }[] = [];
const exports: Record<string, (event: any) => void> = {};
const code = [...handlers].map(([name, fn]) => `exports.${name} = ${fn};`).join('\n');
vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, {
  exports, chatId: 'test-chat',
  setChat: (update: (prev: Chat | null) => Chat | null) => { chat = update(chat); },
  queueNoteDelivered: (chatId: string, cursor: number) => { queued.push({ chatId, cursor }); },
});
for (const cursor of [60, 55, 60, '65', 2]) exports.onMemberDelivered({ userId: 'peer', lastDeliveredMessageId: cursor });
for (const cursor of [52, 44, 52, '58', 1]) exports.onMemberRead({ userId: 'peer', lastReadMessageId: cursor });
assert.equal(chat!.members[0].lastDeliveredMessageId, 65, 'delivery cannot regress on delayed events');
assert.equal(chat!.members[0].lastReadMessageId, 58, 'read cannot regress on delayed events');
assert.equal(chat!.members[1].lastDeliveredMessageId, 7, 'other member delivery unchanged');
assert.equal(chat!.members[1].lastReadMessageId, 6, 'other member read unchanged');
assert.deepEqual(queued.map(x => x.cursor), [60, 55, 60, 65, 2], 'queue gets validated numeric delivery cursors only');
assert(queued.every(x => x.chatId === 'test-chat'));
const before = JSON.stringify(chat), count = queued.length;
for (const cursor of [null, undefined, '', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'bad', {}]) {
  exports.onMemberDelivered({ userId: 'peer', lastDeliveredMessageId: cursor });
  exports.onMemberRead({ userId: 'peer', lastReadMessageId: cursor });
}
for (const event of [null, undefined, {}, { userId: '', lastDeliveredMessageId: 99, lastReadMessageId: 99 }]) {
  exports.onMemberDelivered(event); exports.onMemberRead(event);
}
assert.equal(JSON.stringify(chat), before, 'invalid events cannot change displayed ticks');
assert.equal(queued.length, count, 'invalid events cannot release outbox recovery copies');
chat = null;
exports.onMemberRead({ userId: 'peer', lastReadMessageId: 99 });
assert.equal(chat, null, 'receipt before chat hydration is harmless');
console.log('Actual chat receipt handlers passed reordered/duplicate cursors, numeric wire IDs, malformed events and validated outbox delivery.');
