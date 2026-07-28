// vaultchat-backend/loadtest/seed.js
//
// Seeds a BENCH dataset directly in Postgres (bypasses OTP flows) and mints
// long-lived access JWTs so the load tools can drive the API like real users.
// Idempotent — re-running updates the same bench users.
//
// Output:
//   loadtest/bench-state.json  { users:[{id,email,jwt}], groupChatId, directChatIds }
//   loadtest/jwt-list.txt      one JWT per line (consumed by sockets.js)
//
// Run (against the docker-compose bench stack):
//   DB_HOST=127.0.0.1 DB_PORT=15432 DB_NAME=vaultchat DB_USER=vaultchat \
//   DB_PASS=vaultchat_dev JWT_SECRET=<same as the api container> \
//   node loadtest/seed.js --users 1000 --group-members 50
//
// JWT_SECRET must match the api under test (compose api reads it from
// vaultchat-backend/.env via env_file).

require('dotenv').config();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { argv } = require('process');

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : def;
}

const USERS = parseInt(arg('users', '1000'), 10);
const GROUP_MEMBERS = parseInt(arg('group-members', '50'), 10);
const DIRECT_PAIRS = parseInt(arg('direct-pairs', '100'), 10);
const SECRET = process.env.JWT_SECRET;
if (!SECRET) { console.error('JWT_SECRET required'); process.exit(1); }

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '15432', 10),
  database: process.env.DB_NAME || 'vaultchat',
  user: process.env.DB_USER || 'vaultchat',
  password: process.env.DB_PASS || 'vaultchat_dev',
  max: 10,
});

async function main() {
  console.log(`seeding ${USERS} bench users…`);
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const email = `bench${i}@vaultchat.test`;
    const r = await pool.query(
      `INSERT INTO users (email, name, email_verified_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [email, `Bench User ${i}`],
    );
    const id = r.rows[0].id;
    users.push({
      id,
      email,
      jwt: jwt.sign({ sub: id, email }, SECRET, { algorithm: 'HS256', expiresIn: '24h' }),
    });
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${USERS}`);
  }

  // One bench group chat with the first GROUP_MEMBERS users.
  console.log(`creating bench group (${GROUP_MEMBERS} members)…`);
  let groupChatId;
  const g = await pool.query(
    `SELECT c.id FROM chats c WHERE c.type = 'group' AND c.name = 'bench-group' LIMIT 1`,
  );
  if (g.rows[0]) {
    groupChatId = g.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO chats (type, name, created_by) VALUES ('group', 'bench-group', $1) RETURNING id`,
      [users[0].id],
    );
    groupChatId = c.rows[0].id;
  }
  for (let i = 0; i < Math.min(GROUP_MEMBERS, users.length); i++) {
    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
      [groupChatId, users[i].id, i === 0 ? 'owner' : 'member'],
    );
  }

  // 1:1 chats between consecutive user pairs (for direct-message latency runs).
  console.log(`creating ${DIRECT_PAIRS} direct chats…`);
  const directChatIds = [];
  for (let p = 0; p < DIRECT_PAIRS && p * 2 + 1 < users.length; p++) {
    const a = users[p * 2], b = users[p * 2 + 1];
    const existing = await pool.query(
      `SELECT c.id FROM chats c
        JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = $1
        JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = $2
       WHERE c.type = 'direct' LIMIT 1`,
      [a.id, b.id],
    );
    let cid = existing.rows[0]?.id;
    if (!cid) {
      const c = await pool.query(
        `INSERT INTO chats (type, created_by) VALUES ('direct', $1) RETURNING id`,
        [a.id],
      );
      cid = c.rows[0].id;
      for (const u of [a, b]) {
        await pool.query(
          `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)
           ON CONFLICT (chat_id, user_id) DO UPDATE SET left_at = NULL`,
          [cid, u.id],
        );
      }
    }
    directChatIds.push(cid);
  }

  const out = { users, groupChatId, directChatIds, seededAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, 'bench-state.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, 'jwt-list.txt'), users.map(u => u.jwt).join('\n') + '\n');
  console.log(`done: ${users.length} users, group=${groupChatId}, ${directChatIds.length} direct chats`);
  console.log('wrote loadtest/bench-state.json + loadtest/jwt-list.txt');
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
