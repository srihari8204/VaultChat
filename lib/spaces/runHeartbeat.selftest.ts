// Execute the screen's actual focus callback with a fake timer, without RN or a server.
// Run: npx tsx lib/spaces/runHeartbeat.selftest.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const source = readFileSync(join(__dirname, '../../app/space-run-driver.tsx'), 'utf8');
const tree = ts.createSourceFile('driver.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let focus: ts.CallExpression | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useFocusEffect'
    && node.getText(tree).includes('pingRun(')) focus = node;
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(focus, 'heartbeat belongs to a focus effect, which cleans up on blur');
const memo = focus.arguments[0] as ts.CallExpression;
assert.equal(memo.expression.getText(tree), 'useCallback');
const dependencies = (memo.arguments[1] as ts.ArrayLiteralExpression).elements.map(n => n.getText(tree));
for (const dependency of ['spaceId', 'runId', 'loadedSpaceId', 'run?.id', 'run?.status']) {
  assert.ok(dependencies.includes(dependency), `${dependency} changes must clean up/re-evaluate the timer`);
}
const make = new Function('spaceId', 'runId', 'run', 'loadedSpaceId', 'setInterval', 'clearInterval', 'pingRun', 'PING_MS',
  `return (${memo.arguments[0].getText(tree)});`);
const timers = new Map<number, () => void>();
const pings: string[][] = [];
let next = 0;
function mount(spaceId: string, runId: string, run: { id: string; status: string } | null, loadedSpaceId = spaceId) {
  return make(spaceId, runId, run, loadedSpaceId,
    (tick: () => void, ms: number) => {
      assert.equal(ms, 60_000, 'keep the existing heartbeat cadence');
      timers.set(++next, tick); return next;
    },
    (id: number) => timers.delete(id),
    (...ids: string[]) => { pings.push(ids); return Promise.resolve(); }, 60_000)() as (() => void) | undefined;
}

for (const status of ['scheduled', 'completed', 'cancelled']) {
  assert.equal(mount('space', 'run', { id: 'run', status }), undefined, status);
}
for (const [spaceId, runId, run, loaded] of [
  ['', 'run', { id: 'run', status: 'started' }, ''],
  ['space', '', { id: '', status: 'started' }, 'space'],
  [' ', 'run', { id: 'run', status: 'started' }, ' '],
  ['space', 'run', null, 'space'],
  ['space', 'run', { id: 'previous', status: 'started' }, 'space'],
  ['space', 'run', { id: 'run', status: 'started' }, 'previous-space'],
  ['space', 'run', { id: 'run', status: 'started' }, ''],
] as const) assert.equal(mount(spaceId, runId, run, loaded), undefined, 'unloaded/mismatched route cannot ping');
assert.equal(timers.size, 0);
const stop = mount('space', 'run', { id: 'run', status: 'started' });
assert.ok(stop);
assert.equal(timers.size, 1);
for (const tick of timers.values()) tick();
assert.deepEqual(pings, [['space', 'run']]);
stop(); // Same cleanup React invokes on blur, dependency changes and unmount.
assert.equal(timers.size, 0);
mount('space', 'run', { id: 'run', status: 'completed' });
assert.equal(timers.size, 0, 'completion must not rearm the old heartbeat');
console.log('Driver heartbeat lifecycle checks passed');
