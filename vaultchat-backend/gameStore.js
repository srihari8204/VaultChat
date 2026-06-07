// Durable layer for multiplayer gaming. The Socket.IO handlers in server.js
// keep the live match state in memory; these write-through helpers persist the
// parts that must survive a restart: coin balance, win/loss record, match log.

const db = require('./db');

// Load (creating if absent) a user's game profile.
async function loadProfile(uid) {
  const r = await db.query(
    `INSERT INTO game_profiles (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = game_profiles.user_id
     RETURNING coins, wins, losses, games_played`,
    [uid]
  );
  return r.rows[0];
}

// Adjust a balance by delta (clamped at 0). Returns the new balance.
async function adjustCoins(uid, delta) {
  const r = await db.query(
    `UPDATE game_profiles SET coins = GREATEST(0, coins + $2), updated_at = NOW()
      WHERE user_id = $1 RETURNING coins`,
    [uid, delta]
  );
  return r.rows[0]?.coins ?? 0;
}

// Record a started match.
async function recordMatch(room) {
  await db.query(
    `INSERT INTO game_matches (id, game_type, player_a, player_b, bet)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
    [room.id, room.gameType, room.players[0].uid, room.players[1].uid, room.bet]
  );
}

// Finalize a match: stamp the winner + bump win/loss/games_played, and pay the
// winner the pot. Returns the winner's and loser's new balances.
async function finishMatch(roomId, winnerId, loserId, pot) {
  await db.query(
    `UPDATE game_matches SET winner_id = $2, status = 'finished', ended_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [roomId, winnerId || null]
  );
  let winnerCoins = null, loserCoins = null;
  if (winnerId) {
    const w = await db.query(
      `UPDATE game_profiles
          SET coins = coins + $2, wins = wins + 1, games_played = games_played + 1, updated_at = NOW()
        WHERE user_id = $1 RETURNING coins`,
      [winnerId, pot]
    );
    winnerCoins = w.rows[0]?.coins ?? null;
  }
  if (loserId) {
    const l = await db.query(
      `UPDATE game_profiles
          SET losses = losses + 1, games_played = games_played + 1, updated_at = NOW()
        WHERE user_id = $1 RETURNING coins`,
      [loserId]
    );
    loserCoins = l.rows[0]?.coins ?? null;
  }
  return { winnerCoins, loserCoins };
}

// Mark an abandoned (disconnect/resign without a declared winner) match.
async function abandonMatch(roomId) {
  await db.query(
    `UPDATE game_matches SET status = 'abandoned', ended_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [roomId]
  );
}

module.exports = { loadProfile, adjustCoins, recordMatch, finishMatch, abandonMatch };
