// scripts/check-permission-mirror.ts — prove lib/groups/permissions.ts and
// internal/groups/groups.go still agree.
//
// The two files are a deliberate mirror, and the failure mode when they drift
// is quiet: resolvePermissions() DROPS permission names the client has not
// heard of, so a capability the server grants simply does not appear in the UI.
// Nobody gets an error; the feature is just missing for the people entitled to
// it. Two hand-written test tables agreeing is not evidence of that — this
// compares every decision both sides can make.
//
//   cd vaultchat-backend-go && go run ./internal/groups/mirrorcheck \
//     | npx tsx ../scripts/check-permission-mirror.ts
//
// Reads the Go dump on stdin.

import {
  ALL_PERMISSIONS, ROLES, RoleDef,
  canManageRole, canRemoveMember, canTransferOwnership, catalogLayer,
} from '../lib/groups/permissions';

const read = () =>
  new Promise<string>((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });

(async () => {
  const raw = (await read()).trim();
  if (!raw) {
    console.error('no input — pipe `go run ./internal/groups/mirrorcheck` into this');
    process.exit(2);
  }
  const go = JSON.parse(raw);
  const problems: string[] = [];
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  if (!eq(ALL_PERMISSIONS, go.permissions)) {
    problems.push(`permissions differ\n    ts: ${ALL_PERMISSIONS.join(', ')}\n    go: ${go.permissions.join(', ')}`);
  }
  if (!eq(ROLES, go.roles)) {
    problems.push(`roles differ\n    ts: ${ROLES.join(', ')}\n    go: ${go.roles.join(', ')}`);
  }

  let checked = 0;
  for (const [a, t, n, want] of go.manageRole as [string, string, string, boolean][]) {
    checked++;
    const got = canManageRole(a, t, n);
    if (got !== want) problems.push(`canManageRole(${a}, ${t}, ${n}): ts=${got} go=${want}`);
  }
  for (const [a, t, want] of go.removeMember as [string, string, boolean][]) {
    checked++;
    const got = canRemoveMember(a, t);
    if (got !== want) problems.push(`canRemoveMember(${a}, ${t}): ts=${got} go=${want}`);
  }
  for (const [a, t, want] of go.transfer as [string, string, boolean][]) {
    checked++;
    const got = canTransferOwnership(a, t);
    if (got !== want) problems.push(`canTransferOwnership(${a}, ${t}): ts=${got} go=${want}`);
  }

  // Role catalog (migration 084). The catalog itself comes from the Go dump, so
  // the two sides cannot be compared against different fixtures.
  const catalog = go.catalog as RoleDef[];
  for (const [key, role, wantSet, wantPerms] of go.catalogLayer as [string, string, boolean, string[]][]) {
    checked++;
    const got = catalogLayer(catalog, key, role);
    const gotSet = got !== null;
    if (gotSet !== wantSet) {
      problems.push(`catalogLayer(${key || '<none>'}, ${role}) present: ts=${gotSet} go=${wantSet}`);
    } else if (gotSet && !eq(got, wantPerms)) {
      problems.push(`catalogLayer(${key}, ${role}): ts=[${got}] go=[${wantPerms}]`);
    }
  }

  if (problems.length) {
    console.error(`permission mirror DRIFTED — ${problems.length} disagreement(s):`);
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }
  console.log(
    `permission mirror OK — ${go.permissions.length} permissions, ${go.roles.length} roles, ` +
    `${checked} decisions agree`,
  );
})();
