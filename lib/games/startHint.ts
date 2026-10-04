// lib/games/startHint.ts — why a lobby's Start button is disabled.
//
// The boards disable Start for anyone but the host, and below two players.
// A disabled button with no reason reads as broken, so the lobby says which.
export function startBlockedReason(host: boolean, players: number): string | null {
  if (!host) return 'Only the host can start the game — it begins when they do.';
  if (players < 2) return 'Two players minimum — invite a friend or add a bot.';
  return null;
}
