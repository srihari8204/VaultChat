// Executes production receipts and API with controlled account/storage/network races.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { URL } from 'node:url';
import ts from 'typescript';
const compile = (file: string) => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
class SessionEndedError extends Error {}
function harness() {
  const timers = new Map<number, () => void>();
  const sent: { kind: string; id: number; owner: string }[] = [];
  const disk = new Map<string, string>();
  let serial = 0, owner = 'A', failStorage = false, failRead = false;
  let storageRead: Promise<string | null> | null = null;
  let deliveryWait: Promise<void> | null = null;
  const exports: any = {};
  const dependencies: Record<string, any> = {
    '@react-native-async-storage/async-storage': { default: {
      getItem: async (key: string) => { if (failRead) throw new Error('read failed'); return storageRead ?? disk.get(key) ?? null; },
      setItem: async (key: string, value: string) => { if (failStorage) throw new Error('disk unavailable'); disk.set(key, value); },
    } },
    './api': { getAccessToken: async () => owner },
    './tokenIdentity': { tokenSubject: (token: string) => token },
    './sessionEnded': { SessionEndedError },
    './chatService': {
      markDelivered: async (_chat: string, id: number, expected: string) => {
        assert.equal(expected, owner); sent.push({ kind: 'delivered', id, owner }); await deliveryWait;
      },
      markRead: async (_chat: string, id: number, expected: string) => {
        assert.equal(expected, owner); sent.push({ kind: 'read', id, owner });
      },
    },
    './socket': { onConnectionState: () => {} },
  };
  vm.runInNewContext(compile('./receipts.ts'), {
    exports, require: (name: string) => { assert.ok(dependencies[name], name); return dependencies[name]; },
    setTimeout: (fn: () => void) => { timers.set(++serial, fn); return serial; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    api: exports, sent, disk,
    get saved() { return JSON.parse(disk.get(`vc_receipts_v2:${owner}`) || '{}'); },
    set owner(value: string) { owner = value; },
    set storageRead(value: Promise<string | null> | null) { storageRead = value; },
    set failRead(value: boolean) { failRead = value; },
    set failStorage(value: boolean) { failStorage = value; },
    set deliveryWait(value: Promise<void> | null) { deliveryWait = value; },
    fireTimers() { const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn()); },
  };
}
async function apiOwnership() {
  let access = 'A', refresh = 'RA', deletes = 0, refreshes = 0;
  let response = deferred<any>();
  let refreshReply: ReturnType<typeof deferred<any>> | null = null;
  const exports: any = {};
  const deps: Record<string, any> = {
    '@sentry/react-native': {}, 'expo-router': { router: {} },
    './sessionEnded': { SessionEndedError }, './tokenIdentity': { tokenSubject: (token: string) => token },
    './authNav': { resetTo() {} }, '../constants/server': { SERVER_URL: 'https://test' },
    '../constants/flags': { VAULT_SESSION_SEALED: false },
    'expo-secure-store': {
      getItemAsync: async (key: string) => key === 'vc_access_token' ? access : refresh,
      setItemAsync: async (key: string, value: string) => { if (key === 'vc_access_token') access = value; else refresh = value; },
      deleteItemAsync: async () => { deletes++; },
    },
  };
  vm.runInNewContext(compile('./api.ts'), {
    exports, require: (name: string) => { assert.ok(deps[name], name); return deps[name]; },
    fetch: async (url: string) => {
      if (url.endsWith('/auth/refresh')) { refreshes++; return (refreshReply ?? response).promise; }
      return response.promise;
    },
    Headers, AbortController, setTimeout: () => 1, clearTimeout() {}, console, __DEV__: false,
  });
  const stale = exports.api('/receipt', { expectedUserId: 'A' });
  await tick();
  await exports.setTokens('B', 'RB');
  response.resolve({ status: 401 });
  await assert.rejects(stale, SessionEndedError);
  assert.equal(refreshes, 0, 'old request must not refresh new account');
  assert.equal(deletes, 0);
  await assert.rejects(exports.api('/receipt', { expectedUserId: 'A' }), SessionEndedError);

  // A refresh already on the wire must not overwrite a later login.
  response = deferred<any>();
  const oldRefresh = exports.refreshAccessToken();
  await tick();
  await exports.setTokens('C', 'RC');
  response.resolve({ status: 200, ok: true, json: async () => ({ accessToken: 'B2', refreshToken: 'RB2' }) });
  assert.equal(await oldRefresh, 'transient');
  assert.equal(access, 'C');
  assert.equal(refresh, 'RC');

  response = deferred<any>(); refreshReply = deferred<any>();
  const terminal = exports.api('/receipt', { expectedUserId: 'C' });
  await tick(); response.resolve({ status: 401 }); await tick();
  await exports.setTokens('D', 'RD');
  refreshReply.resolve({ status: 401, ok: false });
  await assert.rejects(terminal, SessionEndedError);
  assert.equal(deletes, 0, 'old refresh rejection must not sign out a later login');
  assert.equal(access, 'D');
}
async function main() {
  const disk = deferred<string | null>();
  const h = harness(); h.storageRead = disk.promise;
  const first = h.api.markDeliveredDurable('chat', 40);
  const concurrent = h.api.markDeliveredDurable('chat', 50);
  disk.resolve(JSON.stringify({ chat: { read: 0, delivered: 30, ackedRead: 0, ackedDelivered: 30 } }));
  await Promise.all([first, concurrent]);
  assert.equal(h.saved.chat.delivered, 50);
  const network = deferred<void>(); h.deliveryWait = network.promise;
  const sending = h.api.flush(); await tick();
  await h.api.markDeliveredDurable('chat', 60);
  h.fireTimers(); await tick();
  network.resolve(); await sending; h.deliveryWait = null;
  h.fireTimers(); await tick();
  assert.deepEqual(h.sent.map(x => x.id), [50, 60]);
  assert.equal(h.sent.some(x => x.kind === 'read'), false);

  const retry = harness(); retry.failStorage = true;
  await assert.rejects(retry.api.markReadDurable('chat', 7), /disk unavailable/);
  assert.equal(retry.sent.length, 0);
  retry.failStorage = false; await retry.api.markReadDurable('chat', 7); await retry.api.flush();
  assert.deepEqual(retry.sent, [{ kind: 'read', id: 7, owner: 'A' }]);
  await retry.api.markDeliveredDurable('chat', -1); await retry.api.markDeliveredDurable('chat', NaN);
  assert.equal(retry.saved.chat.delivered, 0);

  const failedRead = harness(); failedRead.failRead = true;
  await assert.rejects(failedRead.api.markReadDurable('chat', 8), /read failed/);
  assert.equal(failedRead.disk.size, 0);
  failedRead.failRead = false; await failedRead.api.markReadDurable('chat', 8);
  assert.equal(failedRead.saved.chat.read, 8);

  const switching = harness(), slowRead = deferred<string | null>();
  switching.storageRead = slowRead.promise;
  const oldMark = switching.api.markReadDurable('old', 9, 'A');
  const oldRejected = assert.rejects(oldMark, SessionEndedError);
  await tick(); switching.owner = 'B'; switching.storageRead = null;
  switching.disk.set('vc_receipts_v1', JSON.stringify({ unsafe: { read: 999 } }));
  await switching.api.markReadDurable('new', 10, 'B');
  slowRead.resolve(null); await oldRejected;
  assert.equal(switching.saved.old, undefined);
  assert.equal(switching.saved.unsafe, undefined);
  await assert.rejects(switching.api.markReadDurable('old', 9, 'A'), SessionEndedError);

  const race = harness(), wire = deferred<void>();
  await race.api.markDeliveredDurable('old', 22, 'A'); race.deliveryWait = wire.promise;
  const oldFlush = race.api.flush(); await tick(); race.owner = 'B';
  await race.api.markReadDurable('new', 33, 'B'); wire.resolve(); await oldFlush;
  await race.api.flush();
  assert.deepEqual(race.sent, [{ kind: 'delivered', id: 22, owner: 'A' }, { kind: 'read', id: 33, owner: 'B' }]);
  assert.equal(race.saved.old, undefined);
  race.owner = 'A'; await race.api.flush();
  assert.equal(race.sent.at(-1)?.owner, 'A', 'old unacknowledged intent remains retryable under its own owner');
  await apiOwnership();
  console.log('PASS account-isolated receipts, storage failures, in-flight races, legacy isolation and stale API refresh');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
