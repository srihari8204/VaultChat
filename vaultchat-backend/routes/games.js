// Gaming REST layer — durable profile + match history. The realtime
// matchmaking/move relay is in the Socket.IO layer (server.js); this exposes
// the persisted state (game_profiles / game_matches) to the lobby UI.

const express   = require('express');
const jwtUtil   = require('../jwt');
const db        = require('../db');
const gameStore = require('../gameStore');

const router = express.Router();
router.use(jwtUtil.requireAuth);

// GET /games/profile — coin balance + win/loss record
router.get('/profile', async (req, res) => {
  try {
    const p = await gameStore.loadProfile(req.user.id);
    res.json({ coins: p.coins, wins: p.wins, losses: p.losses, gamesPlayed: p.games_played });
  } catch (err) {
    console.error('[games profile]', err.message);
    res.status(500).json({ error: 'Failed to load game profile' });
  }
});

// GET /games/history — recent matches with opponent + result
router.get('/history', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT m.id, m.game_type, m.bet, m.winner_id, m.status, m.started_at, m.ended_at,
              CASE WHEN m.player_a = $1 THEN m.player_b ELSE m.player_a END AS opponent_id,
              COALESCE(NULLIF(u.name, ''), u.email) AS opponent_name
         FROM game_matches m
         JOIN users u ON u.id = CASE WHEN m.player_a = $1 THEN m.player_b ELSE m.player_a END
        WHERE m.player_a = $1 OR m.player_b = $1
        ORDER BY m.started_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json(r.rows.map(row => ({
      id:           row.id,
      gameType:     row.game_type,
      bet:          row.bet,
      opponentId:   row.opponent_id,
      opponentName: row.opponent_name,
      result:       row.status !== 'finished'
                      ? row.status
                      : (row.winner_id === req.user.id ? 'win' : (row.winner_id ? 'loss' : 'draw')),
      startedAt:    row.started_at,
      endedAt:      row.ended_at,
    })));
  } catch (err) {
    console.error('[games history]', err.message);
    res.status(500).json({ error: 'Failed to load match history' });
  }
});

// GET /games/leaderboard — top players by wins then coins
router.get('/leaderboard', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT gp.user_id, gp.coins, gp.wins, gp.losses, gp.games_played,
              COALESCE(NULLIF(u.name, ''), u.email) AS name
         FROM game_profiles gp JOIN users u ON u.id = gp.user_id
        WHERE gp.games_played > 0
        ORDER BY gp.wins DESC, gp.coins DESC
        LIMIT 50`
    );
    res.json(r.rows.map((row, i) => ({
      rank:        i + 1,
      userId:      row.user_id,
      name:        row.name,
      coins:       row.coins,
      wins:        row.wins,
      losses:      row.losses,
      gamesPlayed: row.games_played,
      isMe:        row.user_id === req.user.id,
    })));
  } catch (err) {
    console.error('[games leaderboard]', err.message);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

module.exports = router;
