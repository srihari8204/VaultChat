// Exercise the shipping sync loop, replacing only RN/network/storage imports.
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = readFileSync(new URL('./syncEngine.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function scenario(count: number, sameTime = false, legacy = false, failAt = 0) {
  const initial = '2026-01-01T00:00:00.000Z';
  const rows = Array.from({ length: count }, (_, i) => ({
    id: i + 1, chatId: 'c', content: 'edited',
    editedAt: new Date(Date.parse(initial) + (sameTime ? 1 : i + 1) * 1000).toISOString(),
  }));
  const applied = new Set<number>();
  const writes: string[] = [];
  const meta = new Map<string, string>([['vc_mutated_since_v1', initial]]);
  let requests = 0, stores = 0;
  let failing = failAt;
  const stubs = {
    getAccessToken: async () => 'test-owner', tokenSubject: (token: string) => token,
    api: async (path: string) => {
      requests++;
      const q = new URL(path, 'https://fixture.invalid').searchParams;
      const token = legacy ? null : q.get('mutationCursor');
      const [at, id] = token?.split('|') ?? [q.get('mutatedSince') ?? initial, '0'];
      const page = rows.filter(r => token
        ? r.editedAt > at || (r.editedAt === at && r.id > Number(id))
        : r.editedAt > at).slice(0, 500);
      const last = page.at(-1);
      return {
        messages: [], mutations: page, more: false, nextSince: 20000,
        serverTime: '2026-01-02T00:00:00.000Z',
        ...(!legacy ? { nextMutationCursor: last ? `${last.editedAt}|${last.id}` : '' } : {}),
      };
    },
    getGlobalSyncCursor: async () => 20025,
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => {
      meta.set(key, value);
      if (key === 'vc_mutated_since_v1') writes.push(value);
    },
    getCachedMessagesByIds: async () => [],
    cacheMessages: async (_chat: string, page: typeof rows) => {
      if (++stores === failing) throw new Error('storage unavailable');
      page.forEach(r => applied.add(r.id));
    },
    hydrateMessages: async (_chat: string, page: typeof rows) => page,
    normalizeMsgIds: () => {}, metric: () => {}, looksEncrypted: () => false,
  };
  const exports: { catchUp?: () => Promise<number> } = {};
  runInNewContext(compiled, { exports, require: () => stubs, console, URL, Date, Map, Set, Promise });
  await exports.catchUp!();
  if (failAt) {
    assert.equal(meta.get('vc_mutated_since_v1'), writes[0], 'failed storage cannot advance the checkpoint');
    failing = 0;
  }
  const firstCount = applied.size;
  await exports.catchUp!();
  return { applied, saved: meta.get('vc_mutated_since_v1')!, requests, firstCount, writes, initial };
}

async function coldContinuationScenario() {
  const events: string[] = [];
  const requests: string[] = [];
  const meta = new Map<string, string>();
  let page = 0;
  const stubs = {
    getAccessToken: async () => 'test-owner', tokenSubject: (token: string) => token,
    api: async (path: string) => {
      requests.push(path);
      page++;
      return page === 1
        ? { messages: [{ id: '1', chatId: 'c', content: 'one' }], mutations: [], nextSince: 1, more: true, syncContinuation: 'opaque' }
        : page === 2
          ? { messages: [{ id: '2', chatId: 'c', content: 'two' }], mutations: [], nextSince: 2, more: true, syncContinuation: 'opaque' }
          : { messages: [], mutations: [], nextSince: 2, more: false };
    },
    getGlobalSyncCursor: async () => 0,
    noteGlobalSyncCursor: async (n: number) => { events.push(`cursor:${n}`); },
    getMeta: async (key: string) => meta.get(key) ?? null,
    setMeta: async (key: string, value: string) => { meta.set(key, value); events.push(`meta:${key}:${value}`); },
    getCachedMessagesByIds: async () => [],
    cacheMessages: async (_chat: string, rows: any[]) => { events.push(`cache:${rows[0].id}`); },
    hydrateMessages: async (_chat: string, rows: any[]) => rows,
    normalizeMsgIds: (m: any) => { m.id = Number(m.id); },
    markDeliveredDurable: async () => {}, notifyBatch: async () => {},
    onConnectionState: () => {}, metric: () => {}, looksEncrypted: () => false,
  };
  const exports: { catchUp?: () => Promise<number> } = {};
  runInNewContext(compiled, { exports, require: () => stubs, console, URL, Date, Map, Set, Promise });
  assert.equal(await exports.catchUp!(), 2);
  assert.match(requests[1], /syncContinuation=opaque/);
  assert.ok(events.indexOf('cache:1') < events.indexOf('meta:vc_sync_continuation_v1:opaque'));
  assert.ok(events.indexOf('meta:vc_sync_continuation_v1:opaque') < events.indexOf('cursor:1'));
  assert.equal(meta.get('vc_sync_continuation_v1'), '', 'empty terminal page clears the continuation');
  await exports.catchUp!();
  assert.doesNotMatch(requests.at(-1)!, /syncContinuation=/, 'later catch-up is no longer cold-filtered');
}

async function accountSwitchScenario(switchDuring: 'fetch' | 'decrypt') {
  let owner = 'A', cached = 0, delivered = 0;
  const stubs = {
    getAccessToken: async () => owner, tokenSubject: (token: string) => token,
    api: async (_path: string, opts: any) => {
      assert.equal(opts.expectedUserId, 'A');
      if (switchDuring === 'fetch') owner = 'B';
      return { messages: [{ id: 1, chatId: 'c', content: 'one' }], mutations: [], nextSince: 1, more: false };
    },
    getGlobalSyncCursor: async () => 0, getMeta: async () => null,
    getCachedMessagesByIds: async () => [],
    hydrateMessages: async (_chat: string, rows: any[]) => { owner = 'B'; return rows; },
    cacheMessages: async () => { cached++; },
    markDeliveredDurable: async () => { delivered++; },
    setMeta: async () => {}, noteGlobalSyncCursor: async () => {},
    normalizeMsgIds: () => {}, metric: () => {}, looksEncrypted: () => false,
  };
  const exports: { resyncRequired?: () => Promise<void> } = {};
  runInNewContext(compiled, { exports, require: () => stubs, console, URL, Date, Map, Set, Promise });
  await assert.rejects(exports.resyncRequired!(), /Sync account changed/);
  assert.equal(cached, 0, 'old sync page must not enter the new account cache');
  assert.equal(delivered, 0, 'old sync page must not acknowledge as the new user');
}

async function main() {
  await accountSwitchScenario('fetch');
  await accountSwitchScenario('decrypt');
  const capped = await scenario(11000);
  assert.equal(capped.firstCount, 10000);
  assert.equal(capped.applied.size, 11000, 'next run must resume beyond the page cap');
  const tied = await scenario(501, true);
  assert.equal(tied.applied.size, 501, 'timestamp ties must drain');
  assert.ok(tied.saved.endsWith('|501'), 'checkpoint includes the short final page');
  assert.equal((await scenario(1001, false, false, 2)).applied.size, 1001);
  assert.equal((await scenario(1001, false, true)).applied.size, 1001, 'old servers still receive timestamp requests');
  const oldTie = await scenario(501, true, true);
  assert.equal(oldTie.applied.size, 500);
  assert.ok(oldTie.requests < 6, 'old-server tie must stop without spinning');
  assert.ok(oldTie.saved < '2026-01-01T00:00:01.000Z', 'unsupported old-server tie must not be skipped');
  await coldContinuationScenario();
  console.log('PASS: mutation cap, ties, cold continuation, storage failure, and old-server compatibility');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
