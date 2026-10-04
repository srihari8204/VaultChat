// lib/viewerPrefs.selftest.ts — run: npx tsx lib/viewerPrefs.selftest.ts
//
// setShareViewing must REJECT when the value is not stored. It used to swallow
// the error, so the group-info and contact-info switches showed a setting that
// had not been saved; both screens now revert the switch and say so on a
// rejection, which only works if the rejection reaches them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getShareViewing, setShareViewing } from './viewerPrefs';

async function main() {
  const store = new Map<string, string>();
  (AsyncStorage as any).getItem = async (k: string) => store.get(k) ?? null;
  (AsyncStorage as any).setItem = async (k: string, v: string) => { store.set(k, v); };

  assert.equal(await getShareViewing('c1', true), true, 'default is on');
  await setShareViewing('c1', false);
  assert.equal(await getShareViewing('c1', true), false, 'a stored off reads back');

  (AsyncStorage as any).setItem = async () => { throw new Error('disk full'); };
  await assert.rejects(setShareViewing('c1', true), /disk full/, 'a failed write rejects');
  assert.equal(await getShareViewing('c1', true), false, 'and nothing changed');

  // Both switches act on the rejection (structural: the screens cannot run here).
  const root = path.resolve(__dirname, '..');
  for (const f of ['app/group-info.tsx', 'app/contact-info.tsx']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /try \{\s*await setShareViewing\(chatId, on\);\s*\} catch \{[\s\S]{0,120}setShareViewingState\(!on\)/,
      `${f} reverts the switch when the write fails`);
  }
  console.log('viewerPrefs.selftest: all checks passed');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
