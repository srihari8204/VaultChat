// lib/games/origin.ts — the games server's HTTPS origin, for its REST calls
// (wallet, leaderboard, /api/me). Derived from the one place that names the
// host (lib/gamesSocket.ts), so the boards and hooks cannot drift from it.
import { GAMES_WS_BASE } from '../gamesSocket';

export const GAMES_HTTP = GAMES_WS_BASE.replace(/^ws/, 'http');
