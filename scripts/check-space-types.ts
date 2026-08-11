// scripts/check-space-types.ts — prove lib/groups/catalog.ts still lists every
// space type the migrations seed.
//
// WHY THIS IS A SCRIPT AND NOT PART OF THE CATALOG'S OWN SELF-CHECK
//
// It has to read the migration SQL, and lib/groups/catalog.ts is bundled into
// the app. Metro resolves `require('fs')` statically — even inside a branch
// guarded by `require.main === module`, which never runs on a device — and
// fails the build with "Unable to resolve module fs". So the file-reading half
// lives out here, where nothing bundles it.
//
// WHAT IT CATCHES
//
// group_type_config is seeded ONLY by migrations, so the migrations are the
// source of truth. Drift is silent in the direction that matters: a type the
// server knows and the client does not renders as UNTYPED — no icon, no colour,
// no label — with nothing logged. This is exactly what happened when migration
// 084 added school_transport and office_transport and the catalog's hardcoded
// count was never bumped: the check passed and two space types were broken.
//
//   npx tsx scripts/check-space-types.ts

import * as fs from 'fs';
import * as path from 'path';
import { GROUP_TYPES } from '../lib/groups/catalog';

const migDir = path.join(__dirname, '..', 'vaultchat-backend', 'migrations');

function seededTypes(): Set<string> {
  const out = new Set<string>();
  for (const f of fs.readdirSync(migDir).filter((n) => n.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    // Every INSERT INTO group_type_config … VALUES block, to its semicolon.
    for (const block of sql.match(/INSERT INTO group_type_config[\s\S]*?;/g) ?? []) {
      for (const m of block.matchAll(/\(\s*'([a-z_]+)'\s*,/g)) out.add(m[1]);
    }
  }
  return out;
}

const seeded = seededTypes();
if (seeded.size === 0) {
  console.error('no seeded types found — did the migrations move?');
  process.exit(2);
}

const client = new Set(GROUP_TYPES.map((g) => g.type as string));
const missing = [...seeded].filter((t) => !client.has(t));
const extra = [...client].filter((t) => !seeded.has(t));
const problems: string[] = [];

if (missing.length) {
  problems.push(
    `seeded by a migration but MISSING from lib/groups/catalog.ts — a space of ` +
    `${missing.length === 1 ? 'this type' : 'these types'} renders as UNTYPED: ${missing.join(', ')}`,
  );
}
if (extra.length) {
  problems.push(
    `in the catalog but NO migration seeds ${extra.length === 1 ? 'it' : 'them'} — ` +
    `creating one would be rejected by chatsKnownGroupType: ${extra.join(', ')}`,
  );
}

if (problems.length) {
  console.error('space type drift:');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log(`space types OK — ${seeded.size} seeded, all present in the catalog`);
