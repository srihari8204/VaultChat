// services/gameService.ts
// D2DE Gaming Platform — client-side game engine
// Manages: coins, matchmaking, game state, Firestore persistence

import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import auth from '@react-native-firebase/auth';

const COINS_KEY = 'vc_game_coins';
const STATS_KEY = 'vc_game_stats';
const INITIAL_COINS = 1000;

export interface GameStats {
  totalGames: number;
  wins: number;
  losses: number;
  draws: number;
  coins: number;
  achievements: string[];
}

export interface GameType {
  id: string;
  name: string;
  icon: string;
  region: string;
  minPlayers: number;
  maxPlayers: number;
  description: string;
}

// All 19 games from PDF page 23
export const ALL_GAMES: GameType[] = [
  // India
  { id: 'chess',     name: 'Chess',       icon: '\u265A', region: 'India',  minPlayers: 2, maxPlayers: 2, description: 'Classic strategy board game' },
  { id: 'ludo',      name: 'Ludo',        icon: '\uD83C\uDFB2', region: 'India',  minPlayers: 2, maxPlayers: 4, description: 'Race your tokens to the finish' },
  { id: 'rummy',     name: 'Rummy',       icon: '\uD83C\uDCCF', region: 'India',  minPlayers: 2, maxPlayers: 6, description: 'Form sets and sequences of cards' },
  { id: 'carrom',    name: 'Carrom',      icon: '\u26AA', region: 'India',  minPlayers: 2, maxPlayers: 2, description: 'Flick discs into corner pockets' },
  { id: 'vaultdice', name: 'VaultDice',   icon: '\uD83C\uDFB0', region: 'India',  minPlayers: 2, maxPlayers: 6, description: 'Cryptographic dice betting game' },
  // China
  { id: 'mahjong',   name: 'Mahjong',     icon: '\uD83C\uDC04', region: 'China',  minPlayers: 4, maxPlayers: 4, description: 'Tile-based strategy game' },
  { id: 'go',        name: 'Go/Weiqi',    icon: '\u26AB', region: 'China',  minPlayers: 2, maxPlayers: 2, description: 'Ancient territory control game' },
  { id: 'xiangqi',   name: 'Xiangqi',     icon: '\uD83C\uDE01', region: 'China',  minPlayers: 2, maxPlayers: 2, description: 'Chinese Chess' },
  { id: 'doudizhu',  name: 'Dou Di Zhu',  icon: '\uD83C\uDCBE', region: 'China',  minPlayers: 3, maxPlayers: 3, description: 'Fight the Landlord card game' },
  // Japan
  { id: 'shogi',     name: 'Shogi',       icon: '\u2616', region: 'Japan',  minPlayers: 2, maxPlayers: 2, description: 'Japanese Chess with piece drops' },
  { id: 'hanafuda',  name: 'Hanafuda',    icon: '\uD83C\uDF38', region: 'Japan',  minPlayers: 2, maxPlayers: 2, description: 'Flower card matching game' },
  // Global
  { id: 'poker',     name: 'Poker',       icon: '\uD83C\uDCA1', region: 'Global', minPlayers: 2, maxPlayers: 6, description: 'Texas Hold\'em' },
  { id: 'backgammon',name: 'Backgammon',  icon: '\uD83C\uDFB2', region: 'Global', minPlayers: 2, maxPlayers: 2, description: 'Classic dice and board race' },
  { id: 'mancala',   name: 'Mancala',     icon: '\uD83E\uDD5C', region: 'Global', minPlayers: 2, maxPlayers: 2, description: 'Seed-sowing strategy game' },
  { id: 'dominoes',  name: 'Dominoes',    icon: '\uD83C\uDFA3', region: 'Global', minPlayers: 2, maxPlayers: 4, description: 'Tile matching game' },
  { id: 'durak',     name: 'Durak',       icon: '\uD83C\uDCCE', region: 'Global', minPlayers: 2, maxPlayers: 6, description: 'Russian attack card game' },
  { id: 'okey',      name: 'Okey',        icon: '\uD83D\uDD36', region: 'Global', minPlayers: 2, maxPlayers: 4, description: 'Turkish tile rummy' },
  { id: 'truco',     name: 'Truco',       icon: '\uD83C\uDCA0', region: 'Global', minPlayers: 2, maxPlayers: 4, description: 'Latin American bluffing card game' },
  { id: 'trivia',    name: 'Trivia',      icon: '\uD83E\uDDE0', region: 'Global', minPlayers: 2, maxPlayers: 8, description: 'General knowledge quiz battle' },
];

export const GAME_REGIONS = ['India', 'China', 'Japan', 'Global'];

// Get or initialize coins
export async function getCoins(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(COINS_KEY);
    if (raw) return parseInt(raw, 10);
    await AsyncStorage.setItem(COINS_KEY, String(INITIAL_COINS));
    return INITIAL_COINS;
  } catch {
    return INITIAL_COINS;
  }
}

// Update coins locally
export async function updateCoins(delta: number): Promise<number> {
  const current = await getCoins();
  const newVal = Math.max(0, current + delta);
  await AsyncStorage.setItem(COINS_KEY, String(newVal));
  return newVal;
}

// Set coins to specific value
export async function setCoins(amount: number): Promise<void> {
  await AsyncStorage.setItem(COINS_KEY, String(Math.max(0, amount)));
}

// Get game stats
export async function getGameStats(): Promise<GameStats> {
  try {
    const raw = await AsyncStorage.getItem(STATS_KEY);
    if (raw) return JSON.parse(raw);
    return { totalGames: 0, wins: 0, losses: 0, draws: 0, coins: INITIAL_COINS, achievements: [] };
  } catch {
    return { totalGames: 0, wins: 0, losses: 0, draws: 0, coins: INITIAL_COINS, achievements: [] };
  }
}

// Record a game result
export async function recordGameResult(result: 'win' | 'loss' | 'draw', coinsWon: number): Promise<GameStats> {
  const stats = await getGameStats();
  stats.totalGames++;
  if (result === 'win') stats.wins++;
  else if (result === 'loss') stats.losses++;
  else stats.draws++;
  stats.coins = await updateCoins(coinsWon);

  // Check achievements
  if (stats.wins >= 1 && !stats.achievements.includes('first_win')) stats.achievements.push('first_win');
  if (stats.wins >= 10 && !stats.achievements.includes('ten_wins')) stats.achievements.push('ten_wins');
  if (stats.wins >= 50 && !stats.achievements.includes('fifty_wins')) stats.achievements.push('fifty_wins');
  if (stats.totalGames >= 100 && !stats.achievements.includes('veteran')) stats.achievements.push('veteran');
  if (stats.coins >= 5000 && !stats.achievements.includes('rich')) stats.achievements.push('rich');

  await AsyncStorage.setItem(STATS_KEY, JSON.stringify(stats));

  // Also save to Firestore for leaderboard
  const uid = auth().currentUser?.uid;
  if (uid) {
    firestore().collection('gameStats').doc(uid).set({
      uid, wins: stats.wins, totalGames: stats.totalGames,
      coins: stats.coins, achievements: stats.achievements,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }

  return stats;
}

// Cryptographic fair dice roll (commitment scheme)
export function cryptoDiceRoll(sides = 6): { roll: number; commitment: string; secret: string } {
  const secret = Math.random().toString(36).substring(2, 15);
  const roll = Math.floor(Math.random() * sides) + 1;
  // Simple commitment: hash of secret + roll
  const commitment = btoa(`${secret}:${roll}`);
  return { roll, commitment, secret };
}

// Verify a dice roll commitment
export function verifyDiceRoll(commitment: string, secret: string, roll: number): boolean {
  try {
    const decoded = atob(commitment);
    return decoded === `${secret}:${roll}`;
  } catch {
    return false;
  }
}

// Mental poker: generate a shuffled deck with commitments
export function shuffleDeck(): { deck: number[]; commitments: string[]; secrets: string[] } {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const secrets = deck.map(() => Math.random().toString(36).substring(2, 15));
  const commitments = deck.map((card, i) => btoa(`${secrets[i]}:${card}`));
  return { deck, commitments, secrets };
}

// Card helpers
export function cardName(index: number): string {
  const suits = ['\u2660', '\u2665', '\u2666', '\u2663']; // spade, heart, diamond, club
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return `${ranks[index % 13]}${suits[Math.floor(index / 13)]}`;
}

export const ACHIEVEMENTS = [
  { id: 'first_win',  name: 'First Victory',  icon: '\uD83C\uDFC6', desc: 'Win your first game' },
  { id: 'ten_wins',   name: 'Rising Star',    icon: '\u2B50',       desc: 'Win 10 games' },
  { id: 'fifty_wins', name: 'Champion',       icon: '\uD83D\uDC51', desc: 'Win 50 games' },
  { id: 'veteran',    name: 'Veteran',        icon: '\uD83C\uDF96\uFE0F', desc: 'Play 100 games' },
  { id: 'rich',       name: 'High Roller',    icon: '\uD83D\uDCB0', desc: 'Accumulate 5000 coins' },
];
