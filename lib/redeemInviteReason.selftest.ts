// lib/redeemInviteReason.selftest.ts — npx tsx lib/redeemInviteReason.selftest.ts
//
// Runs the REAL redeemInviteLink from lib/broadcast.ts against a stubbed api(),
// to pin how each failure is classified. lib/broadcast.ts pulls in the app's
// native-backed api client, so the function is lifted out of the source and
// transpiled with its one dependency injected.
//
// The point: a server error or no connection must NOT read as "this invitation
// isn't valid" — the code was never judged and may be perfectly good.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..');
const src = readFileSync(join(ROOT, 'lib/broadcast.ts'), 'utf8');
const start = src.indexOf('export async function redeemInviteLink');
assert.ok(start >= 0, 'redeemInviteLink exists in lib/broadcast.ts');
const end = src.indexOf('\n}\n', start);
const fnSrc = src.slice(start, end + 2).replace(/^export /, '');
const js = ts.transpileModule(fnSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

type Api = (path: string, opts?: unknown) => Promise<unknown>;
const make = new Function('api', `${js}\nreturn redeemInviteLink;`) as
  (api: Api) => (code: string, opts?: { passcode?: string; displayName?: string }) => Promise<{ ok: boolean; reason?: string }>;

const failWith = (status?: number): Api => async () => {
  const e: any = new Error('x');
  if (status !== undefined) e.status = status;
  throw e;
};

let n = 0;
async function reason(api: Api): Promise<string | undefined> { return (await make(api)('CODE')).reason; }
async function eq(api: Api, want: string | undefined, what: string) { assert.equal(await reason(api), want, what); n++; }

async function main(): Promise<void> {
  await eq(async () => ({ broadcastId: 'b1' }), undefined, '1. success has no reason');
  await eq(failWith(403), 'passcode', '2. 403 is the passcode gate');
  await eq(failWith(404), 'invalid', '3. 404 is an invalid / expired / revoked invitation');
  await eq(failWith(), 'network', '4. no HTTP status (offline, timeout) is a network failure, not invalid');
  await eq(failWith(500), 'network', '5. a 5xx is a network/server failure, not invalid');
  await eq(failWith(503), 'network', '5a. 503 too');
  await eq(failWith(429), 'network', '6. the redeem rate limit never judged the code');
  await eq(async () => ({}), 'invalid', '7. a 200 without a broadcast id is not a usable invitation');

  // The join screen uses the reason instead of guessing from device connectivity.
  const screen = readFileSync(join(ROOT, 'app/live/join/[code].tsx'), 'utf8');
  assert.ok(/res\.reason === 'network'/.test(screen), '8. the join screen reads the network reason'); n++;
  assert.ok(!/NetInfo/.test(screen), '8a. and no longer guesses from NetInfo'); n++;

  console.log(`redeemInviteReason.selftest: ${n} assertions passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
