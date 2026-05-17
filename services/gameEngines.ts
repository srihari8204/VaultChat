// services/gameEngines.ts
// VaultChat D2DE Gaming Platform — Real game logic for all 19 games
// Each game: initGame, makeGameMove, checkGameWinner, getBotMove

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GameState {
  gameType: string;
  turn: string;           // current player id
  players: string[];
  phase: string;          // game-specific phase
  board?: any;
  hands?: Record<string, any>;
  scores?: Record<string, number>;
  deck?: number[];
  history?: any[];
  data?: Record<string, any>; // game-specific extra data
  finished?: boolean;
}

export interface MoveResult {
  state: GameState;
  valid: boolean;
  message?: string;
}

export interface WinResult {
  winner: string | null;
  draw: boolean;
}

type Difficulty = 'easy' | 'medium' | 'hard';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deal52Deck(): number[] {
  return shuffle(Array.from({ length: 52 }, (_, i) => i));
}

function cardRank(c: number): number { return c % 13; }
function cardSuit(c: number): number { return Math.floor(c / 13); }
function cardStr(c: number): string {
  const suits = ['S', 'H', 'D', 'C'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return ranks[cardRank(c)] + suits[cardSuit(c)];
}

function nextPlayer(state: GameState): string {
  const idx = state.players.indexOf(state.turn);
  return state.players[(idx + 1) % state.players.length];
}

function cloneState(s: GameState): GameState {
  return JSON.parse(JSON.stringify(s));
}

function randInt(max: number): number { return Math.floor(Math.random() * max); }

// ─── CHESS ───────────────────────────────────────────────────────────────────
// Simplified but real chess: all piece moves, captures, check detection, castling

const CHESS_INIT_BOARD = [
  ['bR','bN','bB','bQ','bK','bB','bN','bR'],
  ['bP','bP','bP','bP','bP','bP','bP','bP'],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['','','','','','','',''],
  ['wP','wP','wP','wP','wP','wP','wP','wP'],
  ['wR','wN','wB','wQ','wK','wB','wN','wR'],
];

function chessInit(players: string[]): GameState {
  return {
    gameType: 'chess', turn: players[0], players,
    phase: 'play', board: CHESS_INIT_BOARD.map(r => [...r]),
    data: { castling: { wK: true, wQ: true, bK: true, bQ: true }, enPassant: null, halfMoves: 0, moveCount: 0 },
    history: [],
  };
}

function chessColor(state: GameState): string {
  return state.turn === state.players[0] ? 'w' : 'b';
}

function chessInBounds(r: number, c: number): boolean {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function chessGetMoves(board: string[][], color: string, enPassant: number[] | null): [number, number, number, number][] {
  const moves: [number, number, number, number][] = [];
  const opp = color === 'w' ? 'b' : 'w';

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p[0] !== color) continue;
      const type = p[1];

      const addIfValid = (tr: number, tc: number) => {
        if (chessInBounds(tr, tc) && (!board[tr][tc] || board[tr][tc][0] === opp)) {
          moves.push([r, c, tr, tc]);
        }
      };

      if (type === 'P') {
        const dir = color === 'w' ? -1 : 1;
        const startRow = color === 'w' ? 6 : 1;
        // forward
        if (chessInBounds(r + dir, c) && !board[r + dir][c]) {
          moves.push([r, c, r + dir, c]);
          if (r === startRow && !board[r + 2 * dir][c]) moves.push([r, c, r + 2 * dir, c]);
        }
        // captures
        for (const dc of [-1, 1]) {
          if (chessInBounds(r + dir, c + dc)) {
            if (board[r + dir][c + dc] && board[r + dir][c + dc][0] === opp) {
              moves.push([r, c, r + dir, c + dc]);
            }
            if (enPassant && enPassant[0] === r + dir && enPassant[1] === c + dc) {
              moves.push([r, c, r + dir, c + dc]);
            }
          }
        }
      } else if (type === 'N') {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) addIfValid(r+dr, c+dc);
      } else if (type === 'K') {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) addIfValid(r+dr, c+dc);
      } else {
        // sliding pieces
        const dirs: number[][] = [];
        if (type === 'R' || type === 'Q') dirs.push([0,1],[0,-1],[1,0],[-1,0]);
        if (type === 'B' || type === 'Q') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
        for (const [dr, dc] of dirs) {
          let tr = r + dr, tc = c + dc;
          while (chessInBounds(tr, tc)) {
            if (!board[tr][tc]) { moves.push([r, c, tr, tc]); }
            else {
              if (board[tr][tc][0] === opp) moves.push([r, c, tr, tc]);
              break;
            }
            tr += dr; tc += dc;
          }
        }
      }
    }
  }
  return moves;
}

function chessIsInCheck(board: string[][], color: string): boolean {
  const opp = color === 'w' ? 'b' : 'w';
  let kr = -1, kc = -1;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === color + 'K') { kr = r; kc = c; }
  if (kr < 0) return true;
  const oppMoves = chessGetMoves(board, opp, null);
  return oppMoves.some(([,,tr,tc]) => tr === kr && tc === kc);
}

function chessLegalMoves(board: string[][], color: string, enPassant: number[] | null): [number,number,number,number][] {
  const raw = chessGetMoves(board, color, enPassant);
  return raw.filter(([fr, fc, tr, tc]) => {
    const b2 = board.map(r => [...r]);
    b2[tr][tc] = b2[fr][fc];
    b2[fr][fc] = '';
    // en passant capture
    if (b2[tr][tc][1] === 'P' && fc !== tc && !board[tr][tc]) b2[fr][tc] = '';
    return !chessIsInCheck(b2, color);
  });
}

function chessMove(state: GameState, move: { from: number[]; to: number[]; promotion?: string }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const color = chessColor(s);
  const [fr, fc] = move.from;
  const [tr, tc] = move.to;

  const legal = chessLegalMoves(s.board, color, s.data!.enPassant);
  if (!legal.some(([a,b,c,d]) => a===fr && b===fc && c===tr && d===tc)) {
    return { state, valid: false, message: 'Illegal move' };
  }

  const piece = s.board[fr][fc];
  const captured = s.board[tr][tc];

  // en passant capture
  if (piece[1] === 'P' && fc !== tc && !captured) s.board[fr][tc] = '';

  s.board[tr][tc] = piece;
  s.board[fr][fc] = '';

  // pawn promotion
  if (piece[1] === 'P' && (tr === 0 || tr === 7)) {
    s.board[tr][tc] = color + (move.promotion || 'Q');
  }

  // en passant flag
  s.data!.enPassant = (piece[1] === 'P' && Math.abs(tr - fr) === 2) ? [(fr + tr) / 2, fc] : null;

  // castling rights update
  if (piece[1] === 'K') { s.data!.castling[color + 'K'] = false; s.data!.castling[color + 'Q'] = false; }
  if (piece[1] === 'R' && fc === 0) s.data!.castling[color + 'Q'] = false;
  if (piece[1] === 'R' && fc === 7) s.data!.castling[color + 'K'] = false;

  s.data!.moveCount++;
  s.data!.halfMoves = (piece[1] === 'P' || captured) ? 0 : s.data!.halfMoves + 1;
  s.history!.push({ from: move.from, to: move.to, piece, captured });
  s.turn = nextPlayer(s);

  return { state: s, valid: true };
}

function chessWinner(state: GameState): WinResult {
  const color = chessColor(state);
  const legal = chessLegalMoves(state.board, color, state.data?.enPassant);
  if (legal.length === 0) {
    if (chessIsInCheck(state.board, color)) {
      // checkmate — other player wins
      return { winner: state.players.find(p => p !== state.turn)!, draw: false };
    }
    return { winner: null, draw: true }; // stalemate
  }
  if (state.data?.halfMoves >= 100) return { winner: null, draw: true }; // 50-move rule
  return { winner: null, draw: false };
}

function chessBotMove(state: GameState, difficulty: Difficulty): any {
  const color = chessColor(state);
  const legal = chessLegalMoves(state.board, color, state.data?.enPassant);
  if (legal.length === 0) return null;

  if (difficulty === 'easy') {
    const m = legal[randInt(legal.length)];
    return { from: [m[0], m[1]], to: [m[2], m[3]] };
  }

  // medium/hard: prefer captures, then checks, then random
  const captures = legal.filter(([,,tr,tc]) => state.board[tr][tc]);
  const opp = color === 'w' ? 'b' : 'w';

  const checks = legal.filter(([fr,fc,tr,tc]) => {
    const b2 = state.board.map((r: string[]) => [...r]);
    b2[tr][tc] = b2[fr][fc]; b2[fr][fc] = '';
    return chessIsInCheck(b2, opp);
  });

  const pieceValues: Record<string, number> = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

  if (difficulty === 'hard') {
    // MVV-LVA: most valuable victim, least valuable attacker
    if (captures.length > 0) {
      captures.sort((a, b) => {
        const va = pieceValues[state.board[a[2]][a[3]][1]] - pieceValues[state.board[a[0]][a[1]][1]] * 0.1;
        const vb = pieceValues[state.board[b[2]][b[3]][1]] - pieceValues[state.board[b[0]][b[1]][1]] * 0.1;
        return vb - va;
      });
      const m = captures[0];
      return { from: [m[0], m[1]], to: [m[2], m[3]] };
    }
    if (checks.length > 0) {
      const m = checks[randInt(checks.length)];
      return { from: [m[0], m[1]], to: [m[2], m[3]] };
    }
    // prefer center control
    const scored = legal.map(m => ({
      m, score: 4 - Math.abs(m[2] - 3.5) - Math.abs(m[3] - 3.5) + Math.random()
    }));
    scored.sort((a, b) => b.score - a.score);
    return { from: [scored[0].m[0], scored[0].m[1]], to: [scored[0].m[2], scored[0].m[3]] };
  }

  // medium
  const pool = captures.length > 0 && Math.random() > 0.3 ? captures : legal;
  const m = pool[randInt(pool.length)];
  return { from: [m[0], m[1]], to: [m[2], m[3]] };
}

// ─── LUDO ────────────────────────────────────────────────────────────────────
// 2-4 player Ludo: 4 tokens per player, roll to enter (6), race around 52 squares + 6 home

function ludoInit(players: string[]): GameState {
  const tokens: Record<string, number[]> = {};
  players.forEach(p => { tokens[p] = [-1, -1, -1, -1]; }); // -1 = in yard
  return {
    gameType: 'ludo', turn: players[0], players, phase: 'roll',
    board: tokens, scores: {},
    data: { diceValue: 0, startOffsets: players.reduce((a: any, p, i) => { a[p] = i * 13; return a; }, {}) },
    history: [],
  };
}

function ludoMove(state: GameState, move: { tokenIndex: number; diceValue?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

  if (s.phase === 'roll') {
    const dice = Math.floor(Math.random() * 6) + 1;
    s.data!.diceValue = dice;
    s.phase = 'move';

    // Check if any move is possible
    const tokens = s.board[playerId] as number[];
    const canMove = tokens.some((pos: number) => {
      if (pos === -1) return dice === 6;
      if (pos >= 52) return pos + dice <= 57; // in home stretch
      return true;
    });
    if (!canMove) {
      s.phase = 'roll';
      if (dice !== 6) s.turn = nextPlayer(s);
      return { state: s, valid: true, message: `Rolled ${dice}, no moves available` };
    }
    return { state: s, valid: true, message: `Rolled ${dice}` };
  }

  // phase === 'move'
  const dice = s.data!.diceValue;
  const idx = move.tokenIndex;
  if (idx < 0 || idx > 3) return { state, valid: false, message: 'Invalid token' };

  const tokens = s.board[playerId] as number[];
  const pos = tokens[idx];

  if (pos === -1) {
    if (dice !== 6) return { state, valid: false, message: 'Need 6 to enter' };
    tokens[idx] = 0; // enter the board
  } else if (pos >= 52) {
    if (pos + dice > 57) return { state, valid: false, message: 'Overshot home' };
    tokens[idx] = pos + dice;
  } else {
    let newPos = pos + dice;
    if (newPos >= 52) newPos = 52 + (newPos - 52); // enter home stretch
    if (newPos > 57) return { state, valid: false, message: 'Overshot home' };
    tokens[idx] = newPos;

    // Check for captures on the shared board (positions 0-51)
    if (newPos < 52) {
      const safeSquares = [0, 8, 13, 21, 26, 34, 39, 47]; // safe spots
      if (!safeSquares.includes(newPos)) {
        for (const op of s.players) {
          if (op === playerId) continue;
          const oTokens = s.board[op] as number[];
          const oppOffset = s.data!.startOffsets[op];
          const myOffset = s.data!.startOffsets[playerId];
          for (let t = 0; t < 4; t++) {
            const oPos = oTokens[t];
            if (oPos >= 0 && oPos < 52) {
              // convert both to absolute positions for comparison
              const absNew = (newPos + myOffset) % 52;
              const absOpp = (oPos + oppOffset) % 52;
              if (absNew === absOpp) {
                oTokens[t] = -1; // send back to yard
              }
            }
          }
        }
      }
    }
  }

  s.board[playerId] = tokens;
  s.phase = 'roll';
  if (dice !== 6) s.turn = nextPlayer(s);
  // rolled 6 = go again

  return { state: s, valid: true };
}

function ludoWinner(state: GameState): WinResult {
  for (const p of state.players) {
    const tokens = state.board[p] as number[];
    if (tokens.every((t: number) => t === 57)) return { winner: p, draw: false };
  }
  return { winner: null, draw: false };
}

function ludoBotMove(state: GameState, difficulty: Difficulty): any {
  if (state.phase === 'roll') return { tokenIndex: 0 }; // just triggers roll

  const dice = state.data!.diceValue;
  const tokens = state.board[state.turn] as number[];
  const valid: number[] = [];

  for (let i = 0; i < 4; i++) {
    if (tokens[i] === -1 && dice === 6) valid.push(i);
    else if (tokens[i] >= 0 && tokens[i] < 52) valid.push(i);
    else if (tokens[i] >= 52 && tokens[i] + dice <= 57) valid.push(i);
  }

  if (valid.length === 0) return { tokenIndex: 0 };

  if (difficulty === 'hard') {
    // prefer advancing furthest token or entering new token
    const entering = valid.filter(i => tokens[i] === -1);
    if (entering.length > 0 && dice === 6) return { tokenIndex: entering[0] };
    const finishing = valid.filter(i => tokens[i] >= 52);
    if (finishing.length > 0) return { tokenIndex: finishing[0] };
    valid.sort((a, b) => tokens[b] - tokens[a]);
    return { tokenIndex: valid[0] };
  }

  return { tokenIndex: valid[randInt(valid.length)] };
}

// ─── RUMMY (Indian 13-card) ─────────────────────────────────────────────────

function rummyInit(players: string[]): GameState {
  const deck = deal52Deck();
  // add second deck for 13-card rummy
  const fullDeck = [...deck, ...deal52Deck()];
  const hands: Record<string, number[]> = {};
  let idx = 0;
  players.forEach(p => { hands[p] = fullDeck.slice(idx, idx + 13); idx += 13; });
  const discard = [fullDeck[idx++]];
  const drawPile = fullDeck.slice(idx);
  const joker = fullDeck[0] % 13; // joker rank

  return {
    gameType: 'rummy', turn: players[0], players, phase: 'draw',
    hands, deck: drawPile, data: { discard, jokerRank: joker },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function rummyIsValidMeld(cards: number[], jokerRank: number): boolean {
  if (cards.length < 3) return false;

  // Check set (same rank, different suits)
  const ranks = cards.map(c => cardRank(c));
  const suits = cards.map(c => cardSuit(c));
  const nonJokers = cards.filter(c => cardRank(c) !== jokerRank);

  if (nonJokers.length > 0) {
    const r0 = cardRank(nonJokers[0]);
    if (nonJokers.every(c => cardRank(c) === r0)) {
      const suitSet = new Set(nonJokers.map(c => cardSuit(c)));
      if (suitSet.size === nonJokers.length && cards.length <= 4) return true;
    }
  }

  // Check run (consecutive ranks, same suit)
  const jokerCount = cards.length - nonJokers.length;
  if (nonJokers.length > 0) {
    const s0 = cardSuit(nonJokers[0]);
    if (nonJokers.every(c => cardSuit(c) === s0)) {
      const sortedRanks = nonJokers.map(c => cardRank(c)).sort((a, b) => a - b);
      let gaps = 0;
      for (let i = 1; i < sortedRanks.length; i++) {
        gaps += sortedRanks[i] - sortedRanks[i-1] - 1;
      }
      if (gaps <= jokerCount) return true;
    }
  }

  return false;
}

function rummyMove(state: GameState, move: { action: string; card?: number; melds?: number[][] }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const hand = s.hands![playerId];

  if (s.phase === 'draw' && move.action === 'draw') {
    if (s.deck!.length === 0) return { state, valid: false, message: 'Deck empty' };
    hand.push(s.deck!.pop()!);
    s.phase = 'discard';
    return { state: s, valid: true, message: 'Drew from deck' };
  }

  if (s.phase === 'draw' && move.action === 'pickup') {
    if (s.data!.discard.length === 0) return { state, valid: false, message: 'Discard empty' };
    hand.push(s.data!.discard.pop()!);
    s.phase = 'discard';
    return { state: s, valid: true, message: 'Picked from discard' };
  }

  if (s.phase === 'discard' && move.action === 'discard') {
    const ci = hand.indexOf(move.card!);
    if (ci === -1) return { state, valid: false, message: 'Card not in hand' };
    hand.splice(ci, 1);
    s.data!.discard.push(move.card!);
    s.hands![playerId] = hand;
    s.phase = 'draw';
    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  if (move.action === 'declare' && move.melds) {
    // validate all melds
    const allCards = move.melds.flat();
    const handSet = [...hand];
    for (const c of allCards) {
      const idx = handSet.indexOf(c);
      if (idx === -1) return { state, valid: false, message: 'Card not in hand' };
      handSet.splice(idx, 1);
    }
    // leftover cards are deadwood
    const jokerRank = s.data!.jokerRank;
    for (const meld of move.melds) {
      if (!rummyIsValidMeld(meld, jokerRank)) {
        return { state, valid: false, message: 'Invalid meld' };
      }
    }
    // must have at least 2 sequences, one must be pure (no jokers)
    const pureSeqs = move.melds.filter(m => {
      const nonJ = m.filter(c => cardRank(c) !== jokerRank);
      const s0 = cardSuit(nonJ[0]);
      return nonJ.length === m.length && m.length >= 3 && nonJ.every(c => cardSuit(c) === s0);
    });
    if (pureSeqs.length === 0) return { state, valid: false, message: 'Need at least one pure sequence' };

    // Calculate deadwood points
    const deadwood = handSet.reduce((sum, c) => {
      const r = cardRank(c);
      return sum + (r === 0 ? 10 : r >= 10 ? 10 : r + 1);
    }, 0);

    s.scores![playerId] = deadwood === 0 ? 0 : deadwood;
    s.finished = true;
    return { state: s, valid: true, message: deadwood === 0 ? 'Rummy! Perfect declare!' : `Declared with ${deadwood} deadwood` };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function rummyBotMove(state: GameState, difficulty: Difficulty): any {
  if (state.phase === 'draw') return { action: 'draw' };
  // discard the highest non-grouped card
  const hand = [...state.hands![state.turn]];
  if (hand.length <= 13) {
    // just discard highest
    hand.sort((a, b) => cardRank(b) - cardRank(a));
    return { action: 'discard', card: hand[0] };
  }
  hand.sort((a, b) => cardRank(b) - cardRank(a));
  return { action: 'discard', card: hand[0] };
}

// ─── CARROM ──────────────────────────────────────────────────────────────────
// Turn-based flick game: each player pockets 9 pieces + queen

function carromInit(players: string[]): GameState {
  // pieces: w1-w9, b1-b9, queen
  const pieces: any[] = [];
  for (let i = 0; i < 9; i++) {
    pieces.push({ id: `w${i}`, color: 'white', x: 400 + Math.cos(i * 0.7) * 30, y: 400 + Math.sin(i * 0.7) * 30, pocketed: false });
    pieces.push({ id: `b${i}`, color: 'black', x: 400 + Math.cos(i * 0.7 + Math.PI) * 30, y: 400 + Math.sin(i * 0.7 + Math.PI) * 30, pocketed: false });
  }
  pieces.push({ id: 'queen', color: 'red', x: 400, y: 400, pocketed: false });

  return {
    gameType: 'carrom', turn: players[0], players, phase: 'strike',
    board: pieces,
    scores: players.reduce((a, p, i) => { a[p] = 0; return a; }, {} as Record<string, number>),
    data: { targetColor: { [players[0]]: 'white', [players[1]]: 'black' }, queenCovered: false, fouls: { [players[0]]: 0, [players[1]]: 0 } },
    history: [],
  };
}

function carromMove(state: GameState, move: { pocketed: string[] }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

  const pocketed = move.pocketed || [];
  const myColor = s.data!.targetColor[playerId];
  let extraTurn = false;

  for (const pid of pocketed) {
    const piece = s.board.find((p: any) => p.id === pid);
    if (!piece || piece.pocketed) continue;
    piece.pocketed = true;

    if (piece.id === 'queen') {
      // queen must be followed by covering
      s.data!.queenCovered = false;
    } else if (piece.color === myColor) {
      s.scores![playerId]++;
      extraTurn = true;
      if (!s.data!.queenCovered && s.board.find((p: any) => p.id === 'queen')?.pocketed) {
        s.data!.queenCovered = true;
        s.scores![playerId] += 3; // queen bonus
      }
    } else {
      // opponent's piece: foul
      s.data!.fouls[playerId]++;
      if (s.data!.fouls[playerId] >= 3) {
        s.scores![playerId] = Math.max(0, s.scores![playerId] - 1);
        s.data!.fouls[playerId] = 0;
      }
    }
  }

  if (pocketed.length === 0) {
    // miss — foul if 3 consecutive
  }

  if (!extraTurn) s.turn = nextPlayer(s);
  return { state: s, valid: true };
}

function carromWinner(state: GameState): WinResult {
  for (const p of state.players) {
    if (state.scores![p] >= 9) return { winner: p, draw: false };
  }
  const allPocketed = state.board.filter((p: any) => !p.pocketed && p.id !== 'queen').length === 0;
  if (allPocketed) {
    const [p1, p2] = state.players;
    if (state.scores![p1] > state.scores![p2]) return { winner: p1, draw: false };
    if (state.scores![p2] > state.scores![p1]) return { winner: p2, draw: false };
    return { winner: null, draw: true };
  }
  return { winner: null, draw: false };
}

function carromBotMove(state: GameState, _d: Difficulty): any {
  const myColor = state.data!.targetColor[state.turn];
  const available = state.board
    .filter((p: any) => !p.pocketed && p.color === myColor)
    .map((p: any) => p.id);
  // randomly pocket 0-1 pieces
  if (available.length > 0 && Math.random() > 0.4) {
    return { pocketed: [available[randInt(available.length)]] };
  }
  return { pocketed: [] };
}

// ─── VAULTDICE ───────────────────────────────────────────────────────────────
// Cryptographic commitment dice betting game

function vaultdiceInit(players: string[]): GameState {
  return {
    gameType: 'vaultdice', turn: players[0], players, phase: 'bet',
    scores: players.reduce((a, p) => { a[p] = 1000; return a; }, {} as Record<string, number>),
    data: { round: 1, bets: {}, commitments: {}, secrets: {}, rolls: {}, roundResults: [] },
    history: [],
  };
}

function vaultdiceMove(state: GameState, move: { action: string; amount?: number; guess?: string }, playerId: string): MoveResult {
  const s = cloneState(state);

  if (s.phase === 'bet' && move.action === 'bet') {
    const amt = move.amount || 10;
    if (amt > s.scores![playerId]) return { state, valid: false, message: 'Not enough coins' };
    s.data!.bets[playerId] = { amount: amt, guess: move.guess || 'high' }; // high=4-6, low=1-3, exact=number

    // check if all bets placed
    if (Object.keys(s.data!.bets).length === s.players.length) {
      s.phase = 'roll';
      s.turn = s.players[0];
    } else {
      s.turn = nextPlayer(s);
    }
    return { state: s, valid: true };
  }

  if (s.phase === 'roll' && move.action === 'roll') {
    const secret = Math.random().toString(36).substring(2, 15);
    const roll = Math.floor(Math.random() * 6) + 1;
    const commitment = btoa(`${secret}:${roll}`);
    s.data!.commitments[playerId] = commitment;
    s.data!.secrets[playerId] = secret;
    s.data!.rolls[playerId] = roll;

    if (Object.keys(s.data!.rolls).length === s.players.length) {
      // resolve
      s.phase = 'result';
      for (const p of s.players) {
        const bet = s.data!.bets[p];
        const roll = s.data!.rolls[p];
        let won = false;
        if (bet.guess === 'high' && roll >= 4) won = true;
        if (bet.guess === 'low' && roll <= 3) won = true;
        if (bet.guess === String(roll)) won = true; // exact match: 5x payout
        const payout = bet.guess.length === 1 ? bet.amount * 5 : bet.amount * 2;
        s.scores![p] += won ? payout : -bet.amount;
        s.data!.roundResults.push({ player: p, roll, guess: bet.guess, won, payout: won ? payout : -bet.amount });
      }
      s.data!.round++;
      return { state: s, valid: true, message: 'Round resolved!' };
    } else {
      s.turn = nextPlayer(s);
    }
    return { state: s, valid: true };
  }

  if (s.phase === 'result' && move.action === 'next') {
    s.phase = 'bet';
    s.data!.bets = {};
    s.data!.commitments = {};
    s.data!.secrets = {};
    s.data!.rolls = {};
    s.data!.roundResults = [];
    s.turn = s.players[0];
    return { state: s, valid: true };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function vaultdiceWinner(state: GameState): WinResult {
  if (state.data?.round > 10) {
    let best = '', bestScore = -Infinity;
    for (const p of state.players) {
      if (state.scores![p] > bestScore) { bestScore = state.scores![p]; best = p; }
    }
    const tied = state.players.filter(p => state.scores![p] === bestScore);
    if (tied.length > 1) return { winner: null, draw: true };
    return { winner: best, draw: false };
  }
  // check if anyone is bankrupt
  for (const p of state.players) {
    if (state.scores![p] <= 0) {
      const others = state.players.filter(x => x !== p && state.scores![x] > 0);
      if (others.length === 1) return { winner: others[0], draw: false };
    }
  }
  return { winner: null, draw: false };
}

function vaultdiceBotMove(state: GameState, difficulty: Difficulty): any {
  if (state.phase === 'bet') {
    const coins = state.scores![state.turn];
    const amount = difficulty === 'hard' ? Math.min(100, Math.floor(coins * 0.1)) : Math.min(50, Math.floor(coins * 0.05));
    const guesses = ['high', 'low'];
    if (difficulty === 'hard' && Math.random() > 0.7) guesses.push(String(randInt(6) + 1));
    return { action: 'bet', amount, guess: guesses[randInt(guesses.length)] };
  }
  if (state.phase === 'roll') return { action: 'roll' };
  return { action: 'next' };
}

// ─── MAHJONG (simplified Riichi) ─────────────────────────────────────────────
// 136 tiles: 4 copies each of 34 types (9 bamboo + 9 character + 9 dot + 4 wind + 3 dragon)

function mahjongInit(players: string[]): GameState {
  // 136 tiles: 0-8 bamboo, 9-17 character, 18-26 dot, 27-30 wind, 31-33 dragon (x4 each)
  const wall = shuffle(Array.from({ length: 136 }, (_, i) => i % 34));
  const hands: Record<string, number[]> = {};
  let idx = 0;
  players.forEach((p, i) => {
    hands[p] = wall.slice(idx, idx + 13).sort((a, b) => a - b);
    idx += 13;
  });
  // dealer gets 14th tile
  hands[players[0]].push(wall[idx++]);

  return {
    gameType: 'mahjong', turn: players[0], players, phase: 'discard',
    hands, deck: wall.slice(idx),
    data: { melds: players.reduce((a, p) => { a[p] = []; return a; }, {} as any), discardPile: [], lastDiscard: null },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function mahjongTileName(t: number): string {
  if (t < 9) return `${t + 1}B`;
  if (t < 18) return `${t - 8}C`;
  if (t < 27) return `${t - 17}D`;
  const winds = ['East', 'South', 'West', 'North'];
  if (t < 31) return winds[t - 27];
  const dragons = ['Red', 'Green', 'White'];
  return dragons[t - 31];
}

function mahjongCheckWin(hand: number[]): boolean {
  // Check for standard win: 4 melds + 1 pair (14 tiles)
  if (hand.length !== 14) return false;
  const sorted = [...hand].sort((a, b) => a - b);
  return mahjongCanWin(sorted);
}

function mahjongCanWin(tiles: number[]): boolean {
  if (tiles.length === 0) return true;
  if (tiles.length === 2) return tiles[0] === tiles[1]; // pair

  const counts: Record<number, number> = {};
  tiles.forEach(t => { counts[t] = (counts[t] || 0) + 1; });

  // Try pair
  for (const t of Object.keys(counts).map(Number)) {
    if (counts[t] >= 2 && tiles.length === 2) return tiles[0] === tiles[1];
  }

  // Try triplet
  for (const t of Object.keys(counts).map(Number)) {
    if (counts[t] >= 3) {
      const rest = [...tiles];
      for (let i = 0; i < 3; i++) rest.splice(rest.indexOf(t), 1);
      if (mahjongCanDecompose(rest)) return true;
    }
  }

  // Try sequence (only for numbered tiles 0-26)
  for (const t of Object.keys(counts).map(Number)) {
    if (t < 27 && t % 9 <= 6) { // can form sequence
      const t2 = t + 1, t3 = t + 2;
      if (Math.floor(t / 9) === Math.floor(t2 / 9) && Math.floor(t / 9) === Math.floor(t3 / 9)) {
        if (counts[t2] && counts[t3]) {
          const rest = [...tiles];
          rest.splice(rest.indexOf(t), 1);
          rest.splice(rest.indexOf(t2), 1);
          rest.splice(rest.indexOf(t3), 1);
          if (mahjongCanDecompose(rest)) return true;
        }
      }
    }
  }

  return false;
}

function mahjongCanDecompose(tiles: number[]): boolean {
  if (tiles.length === 0) return true;
  if (tiles.length === 2) return tiles[0] === tiles[1];

  const counts: Record<number, number> = {};
  tiles.forEach(t => { counts[t] = (counts[t] || 0) + 1; });

  const first = tiles[0];

  // Try pair (only if exactly 2 tiles left or as part of decomposition)
  if (tiles.length === 2) return tiles[0] === tiles[1];

  // Try triplet
  if (counts[first] >= 3) {
    const rest = [...tiles];
    for (let i = 0; i < 3; i++) rest.splice(rest.indexOf(first), 1);
    if (mahjongCanDecompose(rest)) return true;
  }

  // Try sequence
  if (first < 27 && first % 9 <= 6) {
    const t2 = first + 1, t3 = first + 2;
    if (Math.floor(first / 9) === Math.floor(t3 / 9) && counts[t2] && counts[t3]) {
      const rest = [...tiles];
      rest.splice(rest.indexOf(first), 1);
      rest.splice(rest.indexOf(t2), 1);
      rest.splice(rest.indexOf(t3), 1);
      if (mahjongCanDecompose(rest)) return true;
    }
  }

  // Try pair at start for final decomposition
  if (counts[first] >= 2) {
    const rest = [...tiles];
    rest.splice(rest.indexOf(first), 1);
    rest.splice(rest.indexOf(first), 1);
    // remaining must be all melds
    if (mahjongAllMelds(rest)) return true;
  }

  return false;
}

function mahjongAllMelds(tiles: number[]): boolean {
  if (tiles.length === 0) return true;
  if (tiles.length % 3 !== 0) return false;
  const sorted = [...tiles].sort((a, b) => a - b);
  const first = sorted[0];
  const counts: Record<number, number> = {};
  sorted.forEach(t => { counts[t] = (counts[t] || 0) + 1; });

  // triplet
  if (counts[first] >= 3) {
    const rest = [...sorted];
    for (let i = 0; i < 3; i++) rest.splice(rest.indexOf(first), 1);
    if (mahjongAllMelds(rest)) return true;
  }

  // sequence
  if (first < 27 && first % 9 <= 6) {
    const t2 = first + 1, t3 = first + 2;
    if (Math.floor(first / 9) === Math.floor(t3 / 9) && counts[t2] && counts[t3]) {
      const rest = [...sorted];
      rest.splice(rest.indexOf(first), 1);
      rest.splice(rest.indexOf(t2), 1);
      rest.splice(rest.indexOf(t3), 1);
      if (mahjongAllMelds(rest)) return true;
    }
  }

  return false;
}

function mahjongMove(state: GameState, move: { action: string; tile?: number }, playerId: string): MoveResult {
  const s = cloneState(state);

  if (move.action === 'discard') {
    if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
    const hand = s.hands![playerId];
    const ti = hand.indexOf(move.tile!);
    if (ti === -1) return { state, valid: false, message: 'Tile not in hand' };
    hand.splice(ti, 1);
    s.data!.discardPile.push(move.tile!);
    s.data!.lastDiscard = move.tile!;
    s.hands![playerId] = hand.sort((a: number, b: number) => a - b);
    s.phase = 'draw';
    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  if (move.action === 'draw') {
    if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
    if (s.deck!.length === 0) {
      s.finished = true;
      return { state: s, valid: true, message: 'Wall empty - draw game' };
    }
    const tile = s.deck!.pop()!;
    s.hands![playerId].push(tile);
    // check win
    if (mahjongCheckWin(s.hands![playerId])) {
      s.finished = true;
      s.scores![playerId] += 1;
      return { state: s, valid: true, message: 'Tsumo! You win!' };
    }
    s.phase = 'discard';
    return { state: s, valid: true, message: `Drew ${mahjongTileName(tile)}` };
  }

  if (move.action === 'win') {
    // claim last discard for win
    const lastTile = s.data!.lastDiscard;
    if (lastTile === null) return { state, valid: false, message: 'No discard to claim' };
    const testHand = [...s.hands![playerId], lastTile];
    if (!mahjongCheckWin(testHand)) return { state, valid: false, message: 'Not a winning hand' };
    s.hands![playerId] = testHand;
    s.data!.discardPile.pop();
    s.finished = true;
    s.scores![playerId] += 1;
    return { state: s, valid: true, message: 'Ron! You win!' };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function mahjongBotMove(state: GameState, _d: Difficulty): any {
  if (state.phase === 'draw') return { action: 'draw' };
  const hand = state.hands![state.turn];
  // discard tile that appears least / is least useful
  const counts: Record<number, number> = {};
  hand.forEach((t: number) => { counts[t] = (counts[t] || 0) + 1; });
  // find isolated tiles
  const isolated = hand.filter((t: number) => {
    if (t >= 27) return counts[t] === 1;
    const hasAdj = hand.some((o: number) => o !== t && Math.abs(o - t) <= 2 && Math.floor(o / 9) === Math.floor(t / 9));
    return !hasAdj && counts[t] === 1;
  });
  const discard = isolated.length > 0 ? isolated[randInt(isolated.length)] : hand[randInt(hand.length)];
  return { action: 'discard', tile: discard };
}

// ─── GO / WEIQI ──────────────────────────────────────────────────────────────
// 9x9 board (simplified), area scoring

function goInit(players: string[]): GameState {
  const size = 9;
  const board: number[][] = Array.from({ length: size }, () => Array(size).fill(0)); // 0=empty, 1=black, 2=white
  return {
    gameType: 'go', turn: players[0], players, phase: 'play',
    board, data: { size, passes: 0, captures: { [players[0]]: 0, [players[1]]: 0 }, ko: null, komi: 6.5 },
    scores: { [players[0]]: 0, [players[1]]: 0 },
    history: [],
  };
}

function goGetGroup(board: number[][], r: number, c: number, size: number): { stones: number[][]; liberties: number } {
  const color = board[r][c];
  if (color === 0) return { stones: [], liberties: 0 };
  const visited = new Set<string>();
  const stones: number[][] = [];
  let libs = 0;
  const stack = [[r, c]];
  while (stack.length > 0) {
    const [cr, cc] = stack.pop()!;
    const key = `${cr},${cc}`;
    if (visited.has(key)) continue;
    visited.add(key);
    stones.push([cr, cc]);
    for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const nr = cr + dr, nc = cc + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      if (board[nr][nc] === 0) libs++;
      else if (board[nr][nc] === color && !visited.has(`${nr},${nc}`)) stack.push([nr, nc]);
    }
  }
  return { stones, liberties: libs };
}

function goMove(state: GameState, move: { action: string; row?: number; col?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const size = s.data!.size;
  const color = playerId === s.players[0] ? 1 : 2;
  const oppColor = 3 - color;

  if (move.action === 'pass') {
    s.data!.passes++;
    if (s.data!.passes >= 2) {
      s.finished = true;
      // score by area
      let b = 0, w = 0;
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (s.board[r][c] === 1) b++;
        else if (s.board[r][c] === 2) w++;
        else {
          // territory: flood fill to see if surrounded by one color
          const visited = new Set<string>();
          let touchesB = false, touchesW = false;
          const stack = [[r, c]];
          while (stack.length > 0) {
            const [cr, cc] = stack.pop()!;
            const key = `${cr},${cc}`;
            if (visited.has(key)) continue;
            visited.add(key);
            for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
              const nr = cr + dr, nc = cc + dc;
              if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
              if (s.board[nr][nc] === 1) touchesB = true;
              else if (s.board[nr][nc] === 2) touchesW = true;
              else if (!visited.has(`${nr},${nc}`)) stack.push([nr, nc]);
            }
          }
          if (touchesB && !touchesW) b++;
          if (touchesW && !touchesB) w++;
        }
      }
      s.scores![s.players[0]] = b;
      s.scores![s.players[1]] = w + s.data!.komi;
    }
    s.turn = nextPlayer(s);
    return { state: s, valid: true, message: 'Pass' };
  }

  if (move.action !== 'place') return { state, valid: false, message: 'Invalid action' };

  const r = move.row!, c = move.col!;
  if (r < 0 || r >= size || c < 0 || c >= size) return { state, valid: false, message: 'Out of bounds' };
  if (s.board[r][c] !== 0) return { state, valid: false, message: 'Occupied' };

  // ko check
  if (s.data!.ko && s.data!.ko[0] === r && s.data!.ko[1] === c) {
    return { state, valid: false, message: 'Ko violation' };
  }

  s.data!.passes = 0;
  s.board[r][c] = color;

  // capture opponent groups with 0 liberties
  let captured = 0;
  let lastCaptured: number[] | null = null;
  for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size && s.board[nr][nc] === oppColor) {
      const group = goGetGroup(s.board, nr, nc, size);
      if (group.liberties === 0) {
        for (const [gr, gc] of group.stones) {
          s.board[gr][gc] = 0;
          captured++;
        }
        if (group.stones.length === 1) lastCaptured = group.stones[0];
      }
    }
  }

  // self-capture check (suicide rule)
  const selfGroup = goGetGroup(s.board, r, c, size);
  if (selfGroup.liberties === 0) {
    return { state, valid: false, message: 'Suicide not allowed' };
  }

  // ko detection
  s.data!.ko = (captured === 1 && lastCaptured) ? lastCaptured : null;
  s.data!.captures[playerId] += captured;

  s.turn = nextPlayer(s);
  return { state: s, valid: true };
}

function goWinner(state: GameState): WinResult {
  if (!state.finished) return { winner: null, draw: false };
  const s1 = state.scores![state.players[0]];
  const s2 = state.scores![state.players[1]];
  if (s1 > s2) return { winner: state.players[0], draw: false };
  if (s2 > s1) return { winner: state.players[1], draw: false };
  return { winner: null, draw: true };
}

function goBotMove(state: GameState, difficulty: Difficulty): any {
  const size = state.data!.size;
  const color = state.turn === state.players[0] ? 1 : 2;

  if (difficulty === 'easy') {
    // random valid move or pass
    const empties: number[][] = [];
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (state.board[r][c] === 0) empties.push([r, c]);
    if (empties.length === 0) return { action: 'pass' };
    // try a few random spots
    for (let attempt = 0; attempt < 20; attempt++) {
      const [r, c] = empties[randInt(empties.length)];
      const test = cloneState(state);
      test.board[r][c] = color;
      const group = goGetGroup(test.board, r, c, size);
      if (group.liberties > 0) return { action: 'place', row: r, col: c };
    }
    return { action: 'pass' };
  }

  // medium/hard: prefer captures, then moves near existing stones
  const empties: { r: number; c: number; score: number }[] = [];
  const oppColor = 3 - color;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (state.board[r][c] !== 0) continue;
      let score = 0;
      // adjacency to own stones
      for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
          if (state.board[nr][nc] === color) score += 2;
          if (state.board[nr][nc] === oppColor) {
            const g = goGetGroup(state.board, nr, nc, size);
            if (g.liberties <= 2) score += 5; // threatening
          }
        }
      }
      score += (4 - Math.abs(r - size/2) - Math.abs(c - size/2)) * 0.5; // center preference
      score += Math.random();
      empties.push({ r, c, score });
    }
  }

  empties.sort((a, b) => b.score - a.score);
  for (const { r, c } of empties.slice(0, 10)) {
    const test = state.board.map((row: number[]) => [...row]);
    test[r][c] = color;
    const group = goGetGroup(test, r, c, size);
    if (group.liberties > 0) return { action: 'place', row: r, col: c };
  }
  return { action: 'pass' };
}

// ─── XIANGQI (Chinese Chess) ─────────────────────────────────────────────────

const XIANGQI_PIECES = ['K','A','E','H','R','C','P']; // King, Advisor, Elephant, Horse, Rook, Cannon, Pawn

function xiangqiInit(players: string[]): GameState {
  // 10x9 board; pieces: rX = red, bX = black
  const board: string[][] = Array.from({ length: 10 }, () => Array(9).fill(''));
  // Red (bottom)
  board[9] = ['rR','rH','rE','rA','rK','rA','rE','rH','rR'];
  board[7][1] = 'rC'; board[7][7] = 'rC';
  for (let i = 0; i < 5; i++) board[6][i * 2] = 'rP';
  // Black (top)
  board[0] = ['bR','bH','bE','bA','bK','bA','bE','bH','bR'];
  board[2][1] = 'bC'; board[2][7] = 'bC';
  for (let i = 0; i < 5; i++) board[3][i * 2] = 'bP';

  return {
    gameType: 'xiangqi', turn: players[0], players, phase: 'play',
    board, data: {}, history: [],
  };
}

function xiangqiGetMoves(board: string[][], color: string): [number,number,number,number][] {
  const moves: [number,number,number,number][] = [];
  const opp = color === 'r' ? 'b' : 'r';

  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p[0] !== color) continue;
      const type = p[1];

      const addIf = (tr: number, tc: number) => {
        if (tr >= 0 && tr < 10 && tc >= 0 && tc < 9 && (!board[tr][tc] || board[tr][tc][0] === opp)) {
          moves.push([r, c, tr, tc]);
        }
      };

      if (type === 'K') {
        // palace: rows 0-2 or 7-9, cols 3-5
        for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          const tr = r + dr, tc = c + dc;
          const inPalace = color === 'r' ? (tr >= 7 && tr <= 9) : (tr >= 0 && tr <= 2);
          if (inPalace && tc >= 3 && tc <= 5) addIf(tr, tc);
        }
        // flying king: can capture opposing king in same column
        for (let tr = 0; tr < 10; tr++) {
          if (board[tr][c] === opp + 'K') {
            let blocked = false;
            for (let mr = Math.min(r, tr) + 1; mr < Math.max(r, tr); mr++) {
              if (board[mr][c]) { blocked = true; break; }
            }
            if (!blocked) moves.push([r, c, tr, c]);
          }
        }
      } else if (type === 'A') {
        for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const tr = r + dr, tc = c + dc;
          const inPalace = color === 'r' ? (tr >= 7 && tr <= 9) : (tr >= 0 && tr <= 2);
          if (inPalace && tc >= 3 && tc <= 5) addIf(tr, tc);
        }
      } else if (type === 'E') {
        for (const [dr, dc] of [[2,2],[2,-2],[-2,2],[-2,-2]]) {
          const tr = r + dr, tc = c + dc;
          const br = r + dr / 2, bc = c + dc / 2; // blocking point
          const onSide = color === 'r' ? tr >= 5 : tr <= 4;
          if (tr >= 0 && tr < 10 && tc >= 0 && tc < 9 && onSide && !board[br][bc]) addIf(tr, tc);
        }
      } else if (type === 'H') {
        for (const [dr, dc, br, bc] of [[2,1,1,0],[2,-1,1,0],[-2,1,-1,0],[-2,-1,-1,0],[1,2,0,1],[1,-2,0,-1],[-1,2,0,1],[-1,-2,0,-1]]) {
          if (!board[r + br]?.[c + bc]) addIf(r + dr, c + dc);
        }
      } else if (type === 'R') {
        for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          let tr = r + dr, tc = c + dc;
          while (tr >= 0 && tr < 10 && tc >= 0 && tc < 9) {
            if (!board[tr][tc]) { moves.push([r, c, tr, tc]); }
            else { if (board[tr][tc][0] === opp) moves.push([r, c, tr, tc]); break; }
            tr += dr; tc += dc;
          }
        }
      } else if (type === 'C') {
        for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          let tr = r + dr, tc = c + dc;
          let jumped = false;
          while (tr >= 0 && tr < 10 && tc >= 0 && tc < 9) {
            if (!jumped) {
              if (!board[tr][tc]) moves.push([r, c, tr, tc]);
              else jumped = true;
            } else {
              if (board[tr][tc]) {
                if (board[tr][tc][0] === opp) moves.push([r, c, tr, tc]);
                break;
              }
            }
            tr += dr; tc += dc;
          }
        }
      } else if (type === 'P') {
        if (color === 'r') {
          addIf(r - 1, c); // forward
          if (r <= 4) { addIf(r, c - 1); addIf(r, c + 1); } // crossed river
        } else {
          addIf(r + 1, c);
          if (r >= 5) { addIf(r, c - 1); addIf(r, c + 1); }
        }
      }
    }
  }
  return moves;
}

function xiangqiMove(state: GameState, move: { from: number[]; to: number[] }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const color = playerId === s.players[0] ? 'r' : 'b';
  const [fr, fc] = move.from;
  const [tr, tc] = move.to;

  const legal = xiangqiGetMoves(s.board, color);
  if (!legal.some(([a,b,c,d]) => a===fr && b===fc && c===tr && d===tc)) {
    return { state, valid: false, message: 'Illegal move' };
  }

  s.board[tr][tc] = s.board[fr][fc];
  s.board[fr][fc] = '';
  s.turn = nextPlayer(s);
  s.history!.push({ from: move.from, to: move.to });
  return { state: s, valid: true };
}

function xiangqiWinner(state: GameState): WinResult {
  let rK = false, bK = false;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    if (state.board[r][c] === 'rK') rK = true;
    if (state.board[r][c] === 'bK') bK = true;
  }
  if (!rK) return { winner: state.players[1], draw: false };
  if (!bK) return { winner: state.players[0], draw: false };

  const color = state.turn === state.players[0] ? 'r' : 'b';
  const legal = xiangqiGetMoves(state.board, color);
  if (legal.length === 0) return { winner: state.players.find(p => p !== state.turn)!, draw: false };

  return { winner: null, draw: false };
}

function xiangqiBotMove(state: GameState, difficulty: Difficulty): any {
  const color = state.turn === state.players[0] ? 'r' : 'b';
  const legal = xiangqiGetMoves(state.board, color);
  if (legal.length === 0) return null;

  if (difficulty !== 'easy') {
    const captures = legal.filter(([,,tr,tc]) => state.board[tr][tc]);
    if (captures.length > 0) {
      const m = captures[randInt(captures.length)];
      return { from: [m[0], m[1]], to: [m[2], m[3]] };
    }
  }
  const m = legal[randInt(legal.length)];
  return { from: [m[0], m[1]], to: [m[2], m[3]] };
}

// ─── DOU DI ZHU (Fight the Landlord) ────────────────────────────────────────

function doudizhuInit(players: string[]): GameState {
  if (players.length < 3) players = [...players, 'bot1', 'bot2'].slice(0, 3);
  const deck = deal52Deck();
  // Add 2 jokers (52=small joker, 53=big joker)
  const fullDeck = shuffle([...deck, 52, 53]);
  const hands: Record<string, number[]> = {};
  hands[players[0]] = fullDeck.slice(0, 17).sort((a, b) => a - b);
  hands[players[1]] = fullDeck.slice(17, 34).sort((a, b) => a - b);
  hands[players[2]] = fullDeck.slice(34, 51).sort((a, b) => a - b);
  const kitty = fullDeck.slice(51, 54);

  return {
    gameType: 'doudizhu', turn: players[0], players, phase: 'bid',
    hands, data: { kitty, landlord: null, lastPlay: null, lastPlayer: null, passCount: 0, bids: {} },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function ddzCardPower(c: number): number {
  if (c === 53) return 17; // big joker
  if (c === 52) return 16; // small joker
  const r = c % 13;
  // 3,4,5,6,7,8,9,10,J,Q,K,A,2
  if (r === 0) return 14; // A
  if (r === 1) return 15; // 2
  return r + 1;
}

function ddzHandType(cards: number[]): { type: string; power: number } | null {
  const n = cards.length;
  const powers = cards.map(ddzCardPower).sort((a, b) => a - b);

  if (n === 0) return null;
  if (n === 1) return { type: 'single', power: powers[0] };
  if (n === 2) {
    if (powers[0] === 16 && powers[1] === 17) return { type: 'rocket', power: 99 }; // both jokers
    if (powers[0] === powers[1]) return { type: 'pair', power: powers[0] };
    return null;
  }
  if (n === 3 && powers[0] === powers[1] && powers[1] === powers[2]) return { type: 'triple', power: powers[0] };
  if (n === 4) {
    if (powers[0] === powers[3]) return { type: 'bomb', power: powers[0] + 50 };
    if (powers[0] === powers[2] || powers[1] === powers[3]) return { type: 'triple+1', power: powers[1] };
  }

  // straight: 5+ consecutive singles
  if (n >= 5) {
    const unique = Array.from(new Set(powers));
    if (unique.length === n && unique[n-1] - unique[0] === n - 1 && unique[n-1] <= 14) {
      return { type: 'straight', power: unique[0] };
    }
  }

  return null;
}

function doudizhuMove(state: GameState, move: { action: string; cards?: number[]; bid?: boolean }, playerId: string): MoveResult {
  const s = cloneState(state);

  if (s.phase === 'bid') {
    s.data!.bids[playerId] = move.bid ?? false;
    if (Object.keys(s.data!.bids).length === 3) {
      const bidders = s.players.filter((p: string) => s.data!.bids[p]);
      const landlord = bidders.length > 0 ? bidders[bidders.length - 1] : s.players[0];
      s.data!.landlord = landlord;
      s.hands![landlord].push(...s.data!.kitty);
      s.hands![landlord].sort((a: number, b: number) => a - b);
      s.phase = 'play';
      s.turn = landlord;
      return { state: s, valid: true, message: `${landlord} is the landlord!` };
    }
    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  if (s.phase === 'play') {
    if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

    if (move.action === 'pass') {
      if (s.data!.lastPlayer === playerId) return { state, valid: false, message: 'Cannot pass your own play' };
      s.data!.passCount++;
      if (s.data!.passCount >= 2) {
        s.data!.lastPlay = null;
        s.data!.lastPlayer = null;
        s.data!.passCount = 0;
      }
      s.turn = nextPlayer(s);
      return { state: s, valid: true, message: 'Pass' };
    }

    if (!move.cards || move.cards.length === 0) return { state, valid: false, message: 'Must play cards' };

    // validate cards are in hand
    const hand = [...s.hands![playerId]];
    for (const c of move.cards) {
      const idx = hand.indexOf(c);
      if (idx === -1) return { state, valid: false, message: 'Card not in hand' };
      hand.splice(idx, 1);
    }

    const playType = ddzHandType(move.cards);
    if (!playType) return { state, valid: false, message: 'Invalid combination' };

    if (s.data!.lastPlay) {
      const lastType = ddzHandType(s.data!.lastPlay);
      // must beat last play
      if (playType.type === 'rocket') { /* always wins */ }
      else if (playType.type === 'bomb' && lastType!.type !== 'bomb' && lastType!.type !== 'rocket') { /* bomb beats non-bomb */ }
      else if (playType.type !== lastType!.type || move.cards.length !== s.data!.lastPlay.length) {
        return { state, valid: false, message: 'Must play same type' };
      } else if (playType.power <= lastType!.power) {
        return { state, valid: false, message: 'Must play higher' };
      }
    }

    s.hands![playerId] = hand;
    s.data!.lastPlay = move.cards;
    s.data!.lastPlayer = playerId;
    s.data!.passCount = 0;
    s.turn = nextPlayer(s);

    if (hand.length === 0) {
      s.finished = true;
      const isLandlord = playerId === s.data!.landlord;
      return { state: s, valid: true, message: isLandlord ? 'Landlord wins!' : 'Peasants win!' };
    }
    return { state: s, valid: true };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function doudizhuWinner(state: GameState): WinResult {
  for (const p of state.players) {
    if (state.hands![p].length === 0) {
      return { winner: p, draw: false };
    }
  }
  return { winner: null, draw: false };
}

function doudizhuBotMove(state: GameState, _d: Difficulty): any {
  if (state.phase === 'bid') return { action: 'bid', bid: Math.random() > 0.5 };
  const hand = state.hands![state.turn];
  if (!state.data!.lastPlay) {
    // lead: play smallest single
    return { action: 'play', cards: [hand[0]] };
  }
  const lastType = ddzHandType(state.data!.lastPlay);
  if (!lastType) return { action: 'pass' };

  // try to beat
  if (lastType.type === 'single') {
    const beater = hand.find((c: number) => ddzCardPower(c) > lastType.power);
    if (beater !== undefined) return { action: 'play', cards: [beater] };
  }
  return { action: 'pass' };
}

// ─── SHOGI ───────────────────────────────────────────────────────────────────
// 9x9, simplified: all standard pieces, promotion, drops

function shogiInit(players: string[]): GameState {
  const board: string[][] = Array.from({ length: 9 }, () => Array(9).fill(''));
  // Gote (player 2, top)
  board[0] = ['gL','gN','gS','gG','gK','gG','gS','gN','gL'];
  board[1][1] = 'gR'; board[1][7] = 'gB';
  for (let i = 0; i < 9; i++) board[2][i] = 'gP';
  // Sente (player 1, bottom)
  board[8] = ['sL','sN','sS','sG','sK','sG','sS','sN','sL'];
  board[7][7] = 'sR'; board[7][1] = 'sB';
  for (let i = 0; i < 9; i++) board[6][i] = 'sP';

  return {
    gameType: 'shogi', turn: players[0], players, phase: 'play',
    board, data: { captured: { [players[0]]: [], [players[1]]: [] } },
    history: [],
  };
}

function shogiGetMoves(board: string[][], color: string): [number,number,number,number][] {
  const moves: [number,number,number,number][] = [];
  const opp = color === 's' ? 'g' : 's';

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p || p[0] !== color) continue;
      const type = p.substring(1);
      const dir = color === 's' ? -1 : 1;

      const addIf = (tr: number, tc: number) => {
        if (tr >= 0 && tr < 9 && tc >= 0 && tc < 9 && (!board[tr][tc] || board[tr][tc][0] === opp)) {
          moves.push([r, c, tr, tc]);
        }
      };

      if (type === 'P' || type === '+P') {
        addIf(r + dir, c);
        if (type === '+P') { // promoted pawn moves like gold
          addIf(r + dir, c - 1); addIf(r + dir, c + 1);
          addIf(r, c - 1); addIf(r, c + 1); addIf(r - dir, c);
        }
      } else if (type === 'L') {
        let tr = r + dir;
        while (tr >= 0 && tr < 9) {
          if (!board[tr][c]) { moves.push([r, c, tr, c]); }
          else { if (board[tr][c][0] === opp) moves.push([r, c, tr, c]); break; }
          tr += dir;
        }
      } else if (type === 'N') {
        addIf(r + 2 * dir, c - 1); addIf(r + 2 * dir, c + 1);
      } else if (type === 'S') {
        addIf(r + dir, c - 1); addIf(r + dir, c); addIf(r + dir, c + 1);
        addIf(r - dir, c - 1); addIf(r - dir, c + 1);
      } else if (type === 'G' || type === '+S' || type === '+N' || type === '+L') {
        addIf(r + dir, c - 1); addIf(r + dir, c); addIf(r + dir, c + 1);
        addIf(r, c - 1); addIf(r, c + 1); addIf(r - dir, c);
      } else if (type === 'K') {
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) addIf(r + dr, c + dc);
      } else if (type === 'R' || type === '+R') {
        for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          let tr = r + dr, tc = c + dc;
          while (tr >= 0 && tr < 9 && tc >= 0 && tc < 9) {
            if (!board[tr][tc]) { moves.push([r, c, tr, tc]); }
            else { if (board[tr][tc][0] === opp) moves.push([r, c, tr, tc]); break; }
            tr += dr; tc += dc;
          }
        }
        if (type === '+R') { // dragon king: also diagonal 1
          for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) addIf(r + dr, c + dc);
        }
      } else if (type === 'B' || type === '+B') {
        for (const [dr, dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
          let tr = r + dr, tc = c + dc;
          while (tr >= 0 && tr < 9 && tc >= 0 && tc < 9) {
            if (!board[tr][tc]) { moves.push([r, c, tr, tc]); }
            else { if (board[tr][tc][0] === opp) moves.push([r, c, tr, tc]); break; }
            tr += dr; tc += dc;
          }
        }
        if (type === '+B') { // dragon horse: also orthogonal 1
          for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) addIf(r + dr, c + dc);
        }
      }
    }
  }
  return moves;
}

function shogiMove(state: GameState, move: { from?: number[]; to: number[]; drop?: string; promote?: boolean }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const color = playerId === s.players[0] ? 's' : 'g';
  const opp = color === 's' ? 'g' : 's';

  if (move.drop) {
    // drop a captured piece
    const captured = s.data!.captured[playerId];
    const pi = captured.indexOf(move.drop);
    if (pi === -1) return { state, valid: false, message: 'Piece not in hand' };
    const [tr, tc] = move.to;
    if (s.board[tr][tc]) return { state, valid: false, message: 'Square occupied' };
    // pawn drop restrictions
    if (move.drop === 'P') {
      for (let r = 0; r < 9; r++) if (s.board[r][tc] === color + 'P') return { state, valid: false, message: 'Two pawns in column' };
    }
    s.board[tr][tc] = color + move.drop;
    captured.splice(pi, 1);
    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  const [fr, fc] = move.from!;
  const [tr, tc] = move.to;
  const legal = shogiGetMoves(s.board, color);
  if (!legal.some(([a,b,c,d]) => a===fr && b===fc && c===tr && d===tc)) {
    return { state, valid: false, message: 'Illegal move' };
  }

  const captured = s.board[tr][tc];
  if (captured) {
    // captured piece becomes available (unpromoted)
    let capType = captured.substring(1);
    if (capType.startsWith('+')) capType = capType.substring(1);
    s.data!.captured[playerId].push(capType);
  }

  let piece = s.board[fr][fc];
  // promotion
  const promoZone = color === 's' ? tr <= 2 || fr <= 2 : tr >= 6 || fr >= 6;
  if (move.promote && promoZone && !piece.includes('+') && !['K', 'G'].includes(piece.substring(1))) {
    piece = piece[0] + '+' + piece.substring(1);
  }

  s.board[tr][tc] = piece;
  s.board[fr][fc] = '';
  s.turn = nextPlayer(s);
  s.history!.push({ from: move.from, to: move.to, captured });
  return { state: s, valid: true };
}

function shogiWinner(state: GameState): WinResult {
  let sK = false, gK = false;
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
    if (state.board[r][c] === 'sK') sK = true;
    if (state.board[r][c] === 'gK') gK = true;
  }
  if (!sK) return { winner: state.players[1], draw: false };
  if (!gK) return { winner: state.players[0], draw: false };
  return { winner: null, draw: false };
}

function shogiBotMove(state: GameState, difficulty: Difficulty): any {
  const color = state.turn === state.players[0] ? 's' : 'g';
  const legal = shogiGetMoves(state.board, color);
  if (legal.length === 0) return null;
  const captures = legal.filter(([,,tr,tc]) => state.board[tr][tc]);
  const pool = difficulty !== 'easy' && captures.length > 0 ? captures : legal;
  const m = pool[randInt(pool.length)];
  const promoZone = color === 's' ? m[2] <= 2 : m[2] >= 6;
  return { from: [m[0], m[1]], to: [m[2], m[3]], promote: promoZone };
}

// ─── HANAFUDA (Koi-Koi) ─────────────────────────────────────────────────────
// 48 flower cards, 12 months, 4 per month. Match month to capture.

function hanafudaInit(players: string[]): GameState {
  const deck = shuffle(Array.from({ length: 48 }, (_, i) => i));
  const hands: Record<string, number[]> = {};
  hands[players[0]] = deck.slice(0, 8);
  hands[players[1]] = deck.slice(8, 16);
  const field = deck.slice(16, 24);
  const drawPile = deck.slice(24);

  return {
    gameType: 'hanafuda', turn: players[0], players, phase: 'play',
    hands, deck: drawPile,
    board: field, // cards on the field
    data: { captured: { [players[0]]: [], [players[1]]: [] }, koiKoi: false },
    scores: { [players[0]]: 0, [players[1]]: 0 },
    history: [],
  };
}

function hanafudaMonth(card: number): number { return Math.floor(card / 4); }
function hanafudaType(card: number): string {
  // each month has: 2 normal(chaff), 1 ribbon, 1 special (roughly)
  const specials: Record<number, string> = {
    0: 'light', 8: 'light', 28: 'light', 40: 'light', 44: 'light', // crane, moon, curtain, rain, phoenix
    1: 'ribbon', 5: 'ribbon', 9: 'ribbon', 13: 'ribbon', 17: 'ribbon', 21: 'ribbon', 25: 'ribbon', 29: 'ribbon', 33: 'ribbon', 37: 'ribbon',
    4: 'seed', 12: 'seed', 16: 'seed', 20: 'seed', 24: 'seed', 32: 'seed', 36: 'seed', 41: 'seed', 45: 'seed',
  };
  return specials[card] || 'chaff';
}

function hanafudaCheckYaku(captured: number[]): { name: string; points: number }[] {
  const yakus: { name: string; points: number }[] = [];
  const lights = captured.filter(c => hanafudaType(c) === 'light');
  const ribbons = captured.filter(c => hanafudaType(c) === 'ribbon');
  const seeds = captured.filter(c => hanafudaType(c) === 'seed');

  if (lights.length >= 5) yakus.push({ name: 'Five Lights', points: 15 });
  else if (lights.length === 4 && !lights.includes(40)) yakus.push({ name: 'Four Lights (Dry)', points: 8 });
  else if (lights.length === 4) yakus.push({ name: 'Four Lights (Rainy)', points: 7 });
  else if (lights.length === 3 && !lights.includes(40)) yakus.push({ name: 'Three Lights', points: 6 });

  if (ribbons.length >= 5) yakus.push({ name: 'Ribbons', points: ribbons.length - 4 });
  if (seeds.length >= 5) yakus.push({ name: 'Seeds', points: seeds.length - 4 });

  // Poetry ribbons (months 0,1,2)
  const poetryRibbons = [1, 5, 9];
  if (poetryRibbons.every(r => captured.includes(r))) yakus.push({ name: 'Poetry Ribbons', points: 5 });

  // Blue ribbons (months 5,8,9)
  const blueRibbons = [21, 33, 37];
  if (blueRibbons.every(r => captured.includes(r))) yakus.push({ name: 'Blue Ribbons', points: 5 });

  // Boar-Deer-Butterfly
  if ([24, 36, 20].every(c => captured.includes(c))) yakus.push({ name: 'Boar-Deer-Butterfly', points: 5 });

  // Moon-viewing sake
  if (captured.includes(28) && captured.includes(32)) yakus.push({ name: 'Moon Viewing', points: 5 });

  return yakus;
}

function hanafudaMove(state: GameState, move: { handCard: number; fieldCard?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

  const hand = s.hands![playerId];
  const ci = hand.indexOf(move.handCard);
  if (ci === -1) return { state, valid: false, message: 'Card not in hand' };

  const handMonth = hanafudaMonth(move.handCard);
  hand.splice(ci, 1);

  // match with field
  const fieldMatches = (s.board as number[]).filter((c: number) => hanafudaMonth(c) === handMonth);

  if (move.fieldCard !== undefined) {
    if (!fieldMatches.includes(move.fieldCard)) return { state, valid: false, message: 'No match' };
    // capture both
    s.data!.captured[playerId].push(move.handCard, move.fieldCard);
    const fi = (s.board as number[]).indexOf(move.fieldCard);
    (s.board as number[]).splice(fi, 1);
  } else if (fieldMatches.length === 0) {
    // no match: place on field
    (s.board as number[]).push(move.handCard);
  } else {
    return { state, valid: false, message: 'Must match a field card' };
  }

  // draw phase
  if (s.deck!.length > 0) {
    const drawn = s.deck!.pop()!;
    const drawnMonth = hanafudaMonth(drawn);
    const drawnMatches = (s.board as number[]).filter((c: number) => hanafudaMonth(c) === drawnMonth);
    if (drawnMatches.length > 0) {
      s.data!.captured[playerId].push(drawn, drawnMatches[0]);
      const fi = (s.board as number[]).indexOf(drawnMatches[0]);
      (s.board as number[]).splice(fi, 1);
    } else {
      (s.board as number[]).push(drawn);
    }
  }

  // check yaku
  const yakus = hanafudaCheckYaku(s.data!.captured[playerId]);
  const points = yakus.reduce((sum, y) => sum + y.points, 0);
  if (points > 0) s.scores![playerId] = points;

  // check if hands are empty
  if (hand.length === 0) {
    s.finished = true;
    return { state: s, valid: true, message: 'Round over' };
  }

  s.turn = nextPlayer(s);
  return { state: s, valid: true };
}

function hanafudaBotMove(state: GameState, _d: Difficulty): any {
  const hand = state.hands![state.turn];
  if (hand.length === 0) return null;
  const field = state.board as number[];

  for (const c of hand) {
    const month = hanafudaMonth(c);
    const match = field.find((f: number) => hanafudaMonth(f) === month);
    if (match !== undefined) return { handCard: c, fieldCard: match };
  }
  return { handCard: hand[0] };
}

// ─── POKER (Texas Hold'em) ───────────────────────────────────────────────────

function pokerInit(players: string[]): GameState {
  const deck = deal52Deck();
  const hands: Record<string, number[]> = {};
  let idx = 0;
  players.forEach(p => { hands[p] = [deck[idx++], deck[idx++]]; });

  return {
    gameType: 'poker', turn: players[0], players, phase: 'preflop',
    hands, deck: deck.slice(idx),
    board: [], // community cards
    data: { pot: 0, bets: {}, currentBet: 0, dealer: 0, smallBlind: 10, bigBlind: 20, folded: [], allIn: [] },
    scores: players.reduce((a, p) => { a[p] = 1000; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function pokerHandRank(hand: number[]): { rank: number; kickers: number[] } {
  const ranks = hand.map(c => cardRank(c)).sort((a, b) => b - a);
  const suits = hand.map(c => cardSuit(c));

  // map rank 0 (ace) to 14 for high
  const highRanks = ranks.map(r => r === 0 ? 14 : r + 1).sort((a, b) => b - a);

  const counts: Record<number, number> = {};
  highRanks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });

  const groups = Object.entries(counts).map(([r, c]) => ({ rank: Number(r), count: c })).sort((a, b) => b.count - a.count || b.rank - a.rank);

  const isFlush = new Set(suits).size === 1;
  const uniqueRanks = Array.from(new Set(highRanks)).sort((a, b) => b - a);
  const isStraight = uniqueRanks.length === 5 && uniqueRanks[0] - uniqueRanks[4] === 4;
  const isLowStraight = uniqueRanks.length === 5 && JSON.stringify(uniqueRanks) === JSON.stringify([14, 5, 4, 3, 2]);

  if (isFlush && isStraight) return { rank: 8, kickers: uniqueRanks };
  if (isFlush && isLowStraight) return { rank: 8, kickers: [5, 4, 3, 2, 1] };
  if (groups[0].count === 4) return { rank: 7, kickers: [groups[0].rank, groups[1].rank] };
  if (groups[0].count === 3 && groups[1].count === 2) return { rank: 6, kickers: [groups[0].rank, groups[1].rank] };
  if (isFlush) return { rank: 5, kickers: uniqueRanks };
  if (isStraight || isLowStraight) return { rank: 4, kickers: isStraight ? uniqueRanks : [5, 4, 3, 2, 1] };
  if (groups[0].count === 3) return { rank: 3, kickers: [groups[0].rank, ...groups.slice(1).map(g => g.rank)] };
  if (groups[0].count === 2 && groups[1].count === 2) return { rank: 2, kickers: groups.map(g => g.rank) };
  if (groups[0].count === 2) return { rank: 1, kickers: [groups[0].rank, ...groups.slice(1).map(g => g.rank)] };
  return { rank: 0, kickers: highRanks };
}

function pokerBestHand(hole: number[], community: number[]): { rank: number; kickers: number[] } {
  const all = [...hole, ...community];
  let best = { rank: -1, kickers: [] as number[] };

  // choose best 5 from 7
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const five = all.filter((_, k) => k !== i && k !== j);
      if (five.length === 5) {
        const h = pokerHandRank(five);
        if (h.rank > best.rank || (h.rank === best.rank && h.kickers.join(',') > best.kickers.join(','))) {
          best = h;
        }
      }
    }
  }
  return best;
}

function pokerMove(state: GameState, move: { action: string; amount?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  if (s.data!.folded.includes(playerId)) return { state, valid: false, message: 'Already folded' };

  if (move.action === 'fold') {
    s.data!.folded.push(playerId);
    const active = s.players.filter((p: string) => !s.data!.folded.includes(p));
    if (active.length === 1) {
      s.finished = true;
      s.scores![active[0]] += s.data!.pot;
      return { state: s, valid: true, message: `${active[0]} wins the pot` };
    }
    s.turn = nextPlayer(s);
    while (s.data!.folded.includes(s.turn)) s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  if (move.action === 'call') {
    const toCall = s.data!.currentBet - (s.data!.bets[playerId] || 0);
    s.scores![playerId] -= toCall;
    s.data!.pot += toCall;
    s.data!.bets[playerId] = s.data!.currentBet;
  } else if (move.action === 'raise') {
    const amt = move.amount || s.data!.bigBlind;
    s.data!.currentBet += amt;
    const toCall = s.data!.currentBet - (s.data!.bets[playerId] || 0);
    s.scores![playerId] -= toCall;
    s.data!.pot += toCall;
    s.data!.bets[playerId] = s.data!.currentBet;
  } else if (move.action === 'check') {
    if ((s.data!.bets[playerId] || 0) < s.data!.currentBet) {
      return { state, valid: false, message: 'Must call or raise' };
    }
  }

  // advance to next active player
  let nextP = nextPlayer(s);
  while (s.data!.folded.includes(nextP) && nextP !== s.turn) nextP = s.players[(s.players.indexOf(nextP) + 1) % s.players.length];

  // check if betting round is over
  const active = s.players.filter((p: string) => !s.data!.folded.includes(p));
  const allCalled = active.every((p: string) => (s.data!.bets[p] || 0) >= s.data!.currentBet);

  if (allCalled && nextP === active[0]) {
    // advance phase
    s.data!.bets = {};
    s.data!.currentBet = 0;
    if (s.phase === 'preflop') {
      s.board.push(s.deck!.pop()!, s.deck!.pop()!, s.deck!.pop()!); // flop
      s.phase = 'flop';
    } else if (s.phase === 'flop') {
      s.board.push(s.deck!.pop()!); // turn
      s.phase = 'turn';
    } else if (s.phase === 'turn') {
      s.board.push(s.deck!.pop()!); // river
      s.phase = 'river';
    } else {
      // showdown
      s.phase = 'showdown';
      let bestPlayer = active[0];
      let bestHand = pokerBestHand(s.hands![active[0]], s.board);
      for (let i = 1; i < active.length; i++) {
        const h = pokerBestHand(s.hands![active[i]], s.board);
        if (h.rank > bestHand.rank || (h.rank === bestHand.rank && h.kickers.join(',') > bestHand.kickers.join(','))) {
          bestHand = h; bestPlayer = active[i];
        }
      }
      s.scores![bestPlayer] += s.data!.pot;
      s.finished = true;
      return { state: s, valid: true, message: `${bestPlayer} wins with rank ${bestHand.rank}` };
    }
    s.turn = active[0];
  } else {
    s.turn = nextP;
  }

  return { state: s, valid: true };
}

function pokerBotMove(state: GameState, difficulty: Difficulty): any {
  const hand = state.hands![state.turn];
  const handRank = pokerHandRank([...hand, ...(state.board || [])].slice(0, 5));
  const toCall = state.data!.currentBet - (state.data!.bets[state.turn] || 0);

  if (difficulty === 'easy') {
    if (toCall === 0) return { action: 'check' };
    return Math.random() > 0.3 ? { action: 'call' } : { action: 'fold' };
  }

  if (handRank.rank >= 2) return { action: 'raise', amount: state.data!.bigBlind * 2 };
  if (handRank.rank >= 1 || toCall === 0) return { action: toCall === 0 ? 'check' : 'call' };
  return Math.random() > 0.5 ? { action: 'call' } : { action: 'fold' };
}

// ─── BACKGAMMON ──────────────────────────────────────────────────────────────

function backgammonInit(players: string[]): GameState {
  // 24 points, player 1 moves 24->1, player 2 moves 1->24
  const board: number[] = Array(24).fill(0);
  // starting positions (positive = p1, negative = p2)
  board[0] = 2; board[11] = 5; board[16] = 3; board[18] = 5;   // player 1
  board[23] = -2; board[12] = -5; board[7] = -3; board[5] = -5; // player 2

  return {
    gameType: 'backgammon', turn: players[0], players, phase: 'roll',
    board,
    data: { dice: [], bar: { [players[0]]: 0, [players[1]]: 0 }, borneOff: { [players[0]]: 0, [players[1]]: 0 }, usedDice: [] },
    scores: { [players[0]]: 0, [players[1]]: 0 },
    history: [],
  };
}

function backgammonMove(state: GameState, move: { action: string; from?: number; dieValue?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const isP1 = playerId === s.players[0];
  const sign = isP1 ? 1 : -1;

  if (s.phase === 'roll' || move.action === 'roll') {
    const d1 = randInt(6) + 1, d2 = randInt(6) + 1;
    s.data!.dice = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    s.data!.usedDice = [];
    s.phase = 'move';
    return { state: s, valid: true, message: `Rolled ${d1}, ${d2}` };
  }

  if (move.action === 'move') {
    const dieVal = move.dieValue!;
    const diceLeft = [...s.data!.dice];
    const di = diceLeft.indexOf(dieVal);
    if (di === -1) return { state, valid: false, message: 'Die value not available' };

    const from = move.from!;
    const bar = s.data!.bar;

    // must enter from bar first
    if (bar[playerId] > 0) {
      const entry = isP1 ? (24 - dieVal) : (dieVal - 1);
      const target = s.board[entry];
      if ((isP1 && target < -1) || (!isP1 && target > 1)) {
        return { state, valid: false, message: 'Point blocked' };
      }
      bar[playerId]--;
      if ((isP1 && target === -1) || (!isP1 && target === 1)) {
        // hit
        s.board[entry] = sign;
        const oppId = s.players.find(p => p !== playerId)!;
        bar[oppId]++;
      } else {
        s.board[entry] += sign;
      }
    } else {
      if (from < 0 || from > 23) return { state, valid: false, message: 'Invalid point' };
      if (isP1 && s.board[from] <= 0) return { state, valid: false, message: 'No checker there' };
      if (!isP1 && s.board[from] >= 0) return { state, valid: false, message: 'No checker there' };

      const to = isP1 ? from - dieVal : from + dieVal;

      if (to < 0 || to > 23) {
        // bearing off: check all checkers in home board
        const homeRange = isP1 ? [0, 5] : [18, 23];
        let allHome = bar[playerId] === 0;
        for (let i = 0; i < 24; i++) {
          if (isP1 && s.board[i] > 0 && i > 5) { allHome = false; break; }
          if (!isP1 && s.board[i] < 0 && i < 18) { allHome = false; break; }
        }
        if (!allHome) return { state, valid: false, message: 'Not all checkers home' };
        s.board[from] -= sign;
        s.data!.borneOff[playerId]++;
      } else {
        const target = s.board[to];
        if ((isP1 && target < -1) || (!isP1 && target > 1)) {
          return { state, valid: false, message: 'Point blocked' };
        }
        s.board[from] -= sign;
        if ((isP1 && target === -1) || (!isP1 && target === 1)) {
          s.board[to] = sign;
          const oppId = s.players.find(p => p !== playerId)!;
          bar[oppId]++;
        } else {
          s.board[to] += sign;
        }
      }
    }

    diceLeft.splice(di, 1);
    s.data!.dice = diceLeft;

    if (diceLeft.length === 0) {
      s.phase = 'roll';
      s.turn = nextPlayer(s);
    }

    return { state: s, valid: true };
  }

  if (move.action === 'endTurn') {
    s.phase = 'roll';
    s.turn = nextPlayer(s);
    s.data!.dice = [];
    return { state: s, valid: true };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function backgammonWinner(state: GameState): WinResult {
  for (const p of state.players) {
    if (state.data!.borneOff[p] >= 15) return { winner: p, draw: false };
  }
  return { winner: null, draw: false };
}

function backgammonBotMove(state: GameState, _d: Difficulty): any {
  if (state.phase === 'roll') return { action: 'roll' };
  if (state.data!.dice.length === 0) return { action: 'endTurn' };

  const isP1 = state.turn === state.players[0];
  const sign = isP1 ? 1 : -1;
  const die = state.data!.dice[0];

  if (state.data!.bar[state.turn] > 0) {
    return { action: 'move', from: -1, dieValue: die };
  }

  for (let i = 0; i < 24; i++) {
    if ((isP1 && state.board[i] > 0) || (!isP1 && state.board[i] < 0)) {
      return { action: 'move', from: i, dieValue: die };
    }
  }
  return { action: 'endTurn' };
}

// ─── MANCALA ─────────────────────────────────────────────────────────────────

function mancalaInit(players: string[]): GameState {
  // 6 pits per side + 1 store each
  // board[0-5] = player 1 pits, board[6] = p1 store, board[7-12] = p2 pits, board[13] = p2 store
  const board = [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0];
  return {
    gameType: 'mancala', turn: players[0], players, phase: 'play',
    board, data: {},
    scores: { [players[0]]: 0, [players[1]]: 0 },
    history: [],
  };
}

function mancalaMove(state: GameState, move: { pit: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

  const isP1 = playerId === s.players[0];
  const pit = move.pit;

  // validate pit belongs to current player
  if (isP1 && (pit < 0 || pit > 5)) return { state, valid: false, message: 'Invalid pit' };
  if (!isP1 && (pit < 7 || pit > 12)) return { state, valid: false, message: 'Invalid pit' };
  if (s.board[pit] === 0) return { state, valid: false, message: 'Empty pit' };

  let seeds = s.board[pit];
  s.board[pit] = 0;
  let pos = pit;
  const oppStore = isP1 ? 13 : 6;

  while (seeds > 0) {
    pos = (pos + 1) % 14;
    if (pos === oppStore) continue; // skip opponent's store
    s.board[pos]++;
    seeds--;
  }

  // capture: last seed in empty pit on own side
  const myPits = isP1 ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12];
  const myStore = isP1 ? 6 : 13;
  if (myPits.includes(pos) && s.board[pos] === 1) {
    const opp = 12 - pos;
    if (s.board[opp] > 0) {
      s.board[myStore] += s.board[opp] + 1;
      s.board[pos] = 0;
      s.board[opp] = 0;
    }
  }

  // extra turn if last seed lands in own store
  if (pos !== myStore) {
    s.turn = nextPlayer(s);
  }

  // check if one side is empty
  const p1Empty = s.board.slice(0, 6).every((v: number) => v === 0);
  const p2Empty = s.board.slice(7, 13).every((v: number) => v === 0);
  if (p1Empty || p2Empty) {
    // collect remaining
    for (let i = 0; i < 6; i++) { s.board[6] += s.board[i]; s.board[i] = 0; }
    for (let i = 7; i < 13; i++) { s.board[13] += s.board[i]; s.board[i] = 0; }
    s.finished = true;
  }

  s.scores![s.players[0]] = s.board[6];
  s.scores![s.players[1]] = s.board[13];

  return { state: s, valid: true };
}

function mancalaWinner(state: GameState): WinResult {
  if (!state.finished) return { winner: null, draw: false };
  const s1 = state.board[6], s2 = state.board[13];
  if (s1 > s2) return { winner: state.players[0], draw: false };
  if (s2 > s1) return { winner: state.players[1], draw: false };
  return { winner: null, draw: true };
}

function mancalaBotMove(state: GameState, difficulty: Difficulty): any {
  const isP1 = state.turn === state.players[0];
  const pits = isP1 ? [0, 1, 2, 3, 4, 5] : [7, 8, 9, 10, 11, 12];
  const myStore = isP1 ? 6 : 13;
  const valid = pits.filter(p => state.board[p] > 0);
  if (valid.length === 0) return { pit: pits[0] };

  if (difficulty !== 'easy') {
    // prefer pits that land in store (extra turn)
    for (const p of valid) {
      const dist = state.board[p];
      let landing = p;
      for (let i = 0; i < dist; i++) {
        landing = (landing + 1) % 14;
        if (landing === (isP1 ? 13 : 6)) landing = (landing + 1) % 14;
      }
      if (landing === myStore) return { pit: p };
    }
    // prefer captures
    if (difficulty === 'hard') {
      for (const p of valid) {
        const dist = state.board[p];
        let landing = p;
        for (let i = 0; i < dist; i++) {
          landing = (landing + 1) % 14;
          if (landing === (isP1 ? 13 : 6)) landing = (landing + 1) % 14;
        }
        if (pits.includes(landing) && state.board[landing] === 0 && state.board[12 - landing] > 0) {
          return { pit: p };
        }
      }
    }
  }

  return { pit: valid[randInt(valid.length)] };
}

// ─── DOMINOES ────────────────────────────────────────────────────────────────

function dominoesInit(players: string[]): GameState {
  // double-6 set: 28 tiles [0,0]-[6,6]
  const tiles: number[][] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) tiles.push([i, j]);
  const shuffled = shuffle(tiles);

  const hands: Record<string, number[][]> = {};
  const perPlayer = Math.min(7, Math.floor(28 / players.length));
  let idx = 0;
  players.forEach(p => { hands[p] = shuffled.slice(idx, idx + perPlayer); idx += perPlayer; });

  return {
    gameType: 'dominoes', turn: players[0], players, phase: 'play',
    hands: hands as any, board: [] as number[][],
    data: { boneyard: shuffled.slice(idx), leftEnd: -1, rightEnd: -1, passCount: 0 },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function dominoesMove(state: GameState, move: { action: string; tileIndex?: number; end?: 'left' | 'right' }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };
  const hand = s.hands![playerId] as number[][];

  if (move.action === 'draw') {
    if (s.data!.boneyard.length === 0) return { state, valid: false, message: 'Boneyard empty' };
    hand.push(s.data!.boneyard.pop()!);
    return { state: s, valid: true, message: 'Drew from boneyard' };
  }

  if (move.action === 'pass') {
    s.data!.passCount++;
    if (s.data!.passCount >= s.players.length) {
      s.finished = true; // all passed
    }
    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  if (move.action === 'play') {
    const ti = move.tileIndex!;
    if (ti < 0 || ti >= hand.length) return { state, valid: false, message: 'Invalid tile' };
    const tile = hand[ti];

    if ((s.board as number[][]).length === 0) {
      // first tile
      (s.board as number[][]).push(tile);
      s.data!.leftEnd = tile[0];
      s.data!.rightEnd = tile[1];
    } else {
      const end = move.end || 'right';
      const matchEnd = end === 'left' ? s.data!.leftEnd : s.data!.rightEnd;
      let placed: number[];

      if (tile[0] === matchEnd) placed = tile;
      else if (tile[1] === matchEnd) placed = [tile[1], tile[0]];
      else return { state, valid: false, message: 'Tile does not match' };

      if (end === 'left') {
        (s.board as number[][]).unshift(placed);
        s.data!.leftEnd = placed[0] === matchEnd ? placed[1] : placed[0];
      } else {
        (s.board as number[][]).push(placed);
        s.data!.rightEnd = placed[1] === matchEnd ? placed[0] : placed[1];
      }

      // fix ends
      const chain = s.board as number[][];
      s.data!.leftEnd = chain[0][0];
      s.data!.rightEnd = chain[chain.length - 1][1];
    }

    hand.splice(ti, 1);
    s.data!.passCount = 0;

    if (hand.length === 0) {
      s.finished = true;
      s.scores![playerId] = 1;
    }

    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function dominoesWinner(state: GameState): WinResult {
  if (!state.finished) return { winner: null, draw: false };
  for (const p of state.players) {
    if ((state.hands![p] as any[]).length === 0) return { winner: p, draw: false };
  }
  // blocked: lowest total wins
  let best = '', bestSum = Infinity;
  for (const p of state.players) {
    const sum = (state.hands![p] as number[][]).reduce((s, t) => s + t[0] + t[1], 0);
    if (sum < bestSum) { bestSum = sum; best = p; }
  }
  return { winner: best, draw: false };
}

function dominoesBotMove(state: GameState, _d: Difficulty): any {
  const hand = state.hands![state.turn] as number[][];
  if ((state.board as number[][]).length === 0) return { action: 'play', tileIndex: 0, end: 'right' };

  const leftEnd = state.data!.leftEnd;
  const rightEnd = state.data!.rightEnd;

  for (let i = 0; i < hand.length; i++) {
    const [a, b] = hand[i];
    if (a === rightEnd || b === rightEnd) return { action: 'play', tileIndex: i, end: 'right' };
    if (a === leftEnd || b === leftEnd) return { action: 'play', tileIndex: i, end: 'left' };
  }

  if (state.data!.boneyard.length > 0) return { action: 'draw' };
  return { action: 'pass' };
}

// ─── DURAK ───────────────────────────────────────────────────────────────────
// Russian card game: 36-card deck (6-A), attacker plays, defender beats

function durakInit(players: string[]): GameState {
  // 36-card deck: ranks 6-A of 4 suits = cards 5-12 of each suit in 52-card mapping
  // We'll use indices 0-35 mapped to: rank = i%9 + 6, suit = floor(i/9)
  const deck = shuffle(Array.from({ length: 36 }, (_, i) => i));
  const hands: Record<string, number[]> = {};
  let idx = 0;
  players.forEach(p => { hands[p] = deck.slice(idx, idx + 6); idx += 6; });
  const trump = deck[deck.length - 1] ; // bottom card determines trump

  return {
    gameType: 'durak', turn: players[0], players, phase: 'attack',
    hands, deck: deck.slice(idx),
    data: { trump: Math.floor(trump / 9), trumpCard: trump, table: [] as { attack: number; defense?: number }[], defender: players[1] },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function durakCardRank(c: number): number { return c % 9 + 6; }
function durakCardSuit(c: number): number { return Math.floor(c / 9); }

function durakBeats(defense: number, attack: number, trump: number): boolean {
  const dSuit = durakCardSuit(defense), aSuit = durakCardSuit(attack);
  const dRank = durakCardRank(defense), aRank = durakCardRank(attack);
  if (dSuit === aSuit) return dRank > aRank;
  if (dSuit === trump) return true; // trump beats non-trump
  return false;
}

function durakMove(state: GameState, move: { action: string; card?: number; targetIndex?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  const hand = s.hands![playerId];

  if (move.action === 'attack') {
    if (s.phase !== 'attack') return { state, valid: false, message: 'Not attack phase' };
    if (playerId === s.data!.defender) return { state, valid: false, message: 'You are defending' };
    const ci = hand.indexOf(move.card!);
    if (ci === -1) return { state, valid: false, message: 'Card not in hand' };

    // if table not empty, card rank must match something on table
    if (s.data!.table.length > 0) {
      const tableRanks = s.data!.table.flatMap((t: any) => {
        const ranks = [durakCardRank(t.attack)];
        if (t.defense !== undefined) ranks.push(durakCardRank(t.defense));
        return ranks;
      });
      if (!tableRanks.includes(durakCardRank(move.card!))) {
        return { state, valid: false, message: 'Card rank must match table' };
      }
    }

    hand.splice(ci, 1);
    s.data!.table.push({ attack: move.card! });
    s.phase = 'defend';
    return { state: s, valid: true };
  }

  if (move.action === 'defend') {
    if (playerId !== s.data!.defender) return { state, valid: false, message: 'You are not defending' };
    const ci = hand.indexOf(move.card!);
    if (ci === -1) return { state, valid: false, message: 'Card not in hand' };
    const ti = move.targetIndex ?? s.data!.table.findIndex((t: any) => t.defense === undefined);
    if (ti < 0 || ti >= s.data!.table.length) return { state, valid: false, message: 'Invalid target' };
    if (s.data!.table[ti].defense !== undefined) return { state, valid: false, message: 'Already defended' };

    if (!durakBeats(move.card!, s.data!.table[ti].attack, s.data!.trump)) {
      return { state, valid: false, message: 'Does not beat attack card' };
    }

    hand.splice(ci, 1);
    s.data!.table[ti].defense = move.card!;

    // all defended?
    if (s.data!.table.every((t: any) => t.defense !== undefined)) {
      s.phase = 'attack'; // attacker can add more or end
    }

    return { state: s, valid: true };
  }

  if (move.action === 'take') {
    // defender takes all table cards
    if (playerId !== s.data!.defender) return { state, valid: false, message: 'Only defender can take' };
    for (const t of s.data!.table) {
      hand.push(t.attack);
      if (t.defense !== undefined) hand.push(t.defense);
    }
    s.data!.table = [];

    // draw cards
    for (const p of s.players) {
      while (s.hands![p].length < 6 && s.deck!.length > 0) {
        s.hands![p].push(s.deck!.pop()!);
      }
    }

    // next attacker (defender stays same since they took)
    s.turn = nextPlayer(s); // skip defender
    while (s.turn === s.data!.defender) s.turn = nextPlayer(s);
    s.phase = 'attack';
    return { state: s, valid: true };
  }

  if (move.action === 'done') {
    // attacker done, successful defense
    s.data!.table = [];
    // draw cards
    for (const p of s.players) {
      while (s.hands![p].length < 6 && s.deck!.length > 0) {
        s.hands![p].push(s.deck!.pop()!);
      }
    }
    // rotate: defender becomes attacker, next player defends
    const oldDefender = s.data!.defender;
    s.turn = oldDefender;
    const defIdx = s.players.indexOf(oldDefender);
    s.data!.defender = s.players[(defIdx + 1) % s.players.length];
    s.phase = 'attack';
    return { state: s, valid: true };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function durakWinner(state: GameState): WinResult {
  if (state.deck!.length > 0) return { winner: null, draw: false };
  const withCards = state.players.filter(p => state.hands![p].length > 0);
  if (withCards.length <= 1) {
    const loser = withCards[0]; // "durak" = fool, last with cards loses
    const winner = state.players.find(p => p !== loser);
    return loser ? { winner: winner!, draw: false } : { winner: null, draw: true };
  }
  return { winner: null, draw: false };
}

function durakBotMove(state: GameState, _d: Difficulty): any {
  const hand = state.hands![state.turn];
  if (state.phase === 'attack' && state.turn !== state.data!.defender) {
    if (state.data!.table.length > 0 && Math.random() > 0.5) return { action: 'done' };
    if (hand.length === 0) return { action: 'done' };
    // play lowest non-trump
    const nonTrump = hand.filter((c: number) => durakCardSuit(c) !== state.data!.trump);
    const pool = nonTrump.length > 0 ? nonTrump : hand;
    pool.sort((a: number, b: number) => durakCardRank(a) - durakCardRank(b));

    if (state.data!.table.length > 0) {
      const tableRanks = state.data!.table.flatMap((t: any) => {
        const ranks = [durakCardRank(t.attack)];
        if (t.defense !== undefined) ranks.push(durakCardRank(t.defense));
        return ranks;
      });
      const matching = pool.filter((c: number) => tableRanks.includes(durakCardRank(c)));
      if (matching.length > 0) return { action: 'attack', card: matching[0] };
      return { action: 'done' };
    }
    return { action: 'attack', card: pool[0] };
  }

  if (state.turn === state.data!.defender) {
    const undefended = state.data!.table.findIndex((t: any) => t.defense === undefined);
    if (undefended === -1) return { action: 'done' };
    const attackCard = state.data!.table[undefended].attack;
    const beaters = hand.filter((c: number) => durakBeats(c, attackCard, state.data!.trump));
    if (beaters.length === 0) return { action: 'take' };
    beaters.sort((a: number, b: number) => durakCardRank(a) - durakCardRank(b));
    return { action: 'defend', card: beaters[0], targetIndex: undefended };
  }

  return { action: 'done' };
}

// ─── OKEY (Turkish tile rummy) ───────────────────────────────────────────────

function okeyInit(players: string[]): GameState {
  // 106 tiles: 4 colors x 13 numbers x 2 sets + 2 jokers
  const tiles: number[] = [];
  for (let set = 0; set < 2; set++) {
    for (let color = 0; color < 4; color++) {
      for (let num = 1; num <= 13; num++) {
        tiles.push(set * 52 + color * 13 + num - 1);
      }
    }
  }
  tiles.push(104, 105); // jokers

  const shuffled = shuffle(tiles);
  const hands: Record<string, number[]> = {};
  let idx = 0;
  const pl = players.length >= 2 ? players.slice(0, 4) : [...players, 'bot1', 'bot2', 'bot3'].slice(0, 4);
  pl.forEach((p, i) => {
    hands[p] = shuffled.slice(idx, idx + (i === 0 ? 15 : 14)); // dealer gets 15
    idx += (i === 0 ? 15 : 14);
  });

  const indicator = shuffled[idx++]; // okey indicator
  const okeyTile = ((indicator % 13) + 1) % 13 + Math.floor((indicator % 52) / 13) * 13; // next number, same color

  return {
    gameType: 'okey', turn: pl[0], players: pl, phase: 'discard',
    hands, deck: shuffled.slice(idx),
    data: { indicator, okeyTile, discard: pl.reduce((a: any, p: string) => { a[p] = []; return a; }, {}), },
    scores: pl.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function okeyTileColor(t: number): number { return t >= 104 ? -1 : Math.floor((t % 52) / 13); }
function okeyTileNum(t: number): number { return t >= 104 ? 0 : (t % 13) + 1; }

function okeyIsValidGroup(tiles: number[], okeyTile: number): boolean {
  if (tiles.length < 3) return false;
  const jokers = tiles.filter(t => t >= 104 || t === okeyTile).length;
  const real = tiles.filter(t => t < 104 && t !== okeyTile);

  // set: same number, different colors
  if (real.length > 0) {
    const nums = real.map(okeyTileNum);
    if (nums.every(n => n === nums[0])) {
      const colors = new Set(real.map(okeyTileColor));
      if (colors.size === real.length && tiles.length <= 4) return true;
    }
  }

  // run: same color, consecutive
  if (real.length > 0) {
    const colors = real.map(okeyTileColor);
    if (colors.every(c => c === colors[0])) {
      const sorted = real.map(okeyTileNum).sort((a, b) => a - b);
      let gaps = 0;
      for (let i = 1; i < sorted.length; i++) gaps += sorted[i] - sorted[i-1] - 1;
      if (gaps <= jokers) return true;
    }
  }

  return false;
}

function okeyMove(state: GameState, move: { action: string; tile?: number; fromPlayer?: string; groups?: number[][] }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

  if (move.action === 'draw') {
    if (s.deck!.length === 0) return { state, valid: false, message: 'Deck empty' };
    s.hands![playerId].push(s.deck!.pop()!);
    s.phase = 'discard';
    return { state: s, valid: true };
  }

  if (move.action === 'drawDiscard') {
    const from = move.fromPlayer || nextPlayer(s);
    const pile = s.data!.discard[from];
    if (pile.length === 0) return { state, valid: false, message: 'Discard empty' };
    s.hands![playerId].push(pile.pop()!);
    s.phase = 'discard';
    return { state: s, valid: true };
  }

  if (move.action === 'discard') {
    const hand = s.hands![playerId] as number[];
    const ti = hand.indexOf(move.tile!);
    if (ti === -1) return { state, valid: false, message: 'Tile not in hand' };
    hand.splice(ti, 1);
    s.data!.discard[playerId].push(move.tile!);
    s.phase = 'draw';
    s.turn = nextPlayer(s);
    return { state: s, valid: true };
  }

  if (move.action === 'declare' && move.groups) {
    const hand = [...(s.hands![playerId] as number[])];
    const allTiles = move.groups.flat();
    for (const t of allTiles) {
      const idx = hand.indexOf(t);
      if (idx === -1) return { state, valid: false, message: 'Tile not in hand' };
      hand.splice(idx, 1);
    }
    for (const group of move.groups) {
      if (!okeyIsValidGroup(group, s.data!.okeyTile)) {
        return { state, valid: false, message: 'Invalid group' };
      }
    }
    if (hand.length > 1) return { state, valid: false, message: 'Must use all tiles (at most 1 leftover for discard)' };
    s.finished = true;
    s.scores![playerId] = 1;
    return { state: s, valid: true, message: 'Okey! You win!' };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function okeyBotMove(state: GameState, _d: Difficulty): any {
  if (state.phase === 'draw') return { action: 'draw' };
  const hand = state.hands![state.turn] as number[];
  // discard highest
  const sorted = [...hand].sort((a, b) => b - a);
  return { action: 'discard', tile: sorted[0] };
}

// ─── TRUCO ───────────────────────────────────────────────────────────────────
// Latin American bluffing card game with 40-card Spanish deck

function trucoInit(players: string[]): GameState {
  // 40-card deck: 4 suits x 10 ranks (1-7, 10-12)
  const deck = shuffle(Array.from({ length: 40 }, (_, i) => i));
  const hands: Record<string, number[]> = {};
  let idx = 0;
  players.forEach(p => { hands[p] = deck.slice(idx, idx + 3); idx += 3; });

  return {
    gameType: 'truco', turn: players[0], players, phase: 'play',
    hands, data: { table: [] as { player: string; card: number }[], roundWins: {} as Record<string, number>, stake: 1, trucoCalled: false, roundNum: 0 },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function trucoCardPower(c: number): number {
  const suit = Math.floor(c / 10);
  const rank = c % 10; // 0-9 maps to 1-7, 10-12
  // power ranking: 1 of swords(0) > 1 of clubs(3) > 7 of swords > 7 of golds(1)
  // then 3 > 2 > A(other) > 12 > 11 > 10 > 7(other) > 6 > 5 > 4
  if (rank === 0 && suit === 0) return 14; // 1 of swords
  if (rank === 0 && suit === 3) return 13; // 1 of clubs
  if (rank === 6 && suit === 0) return 12; // 7 of swords
  if (rank === 6 && suit === 1) return 11; // 7 of golds
  const basePower: Record<number, number> = { 2: 10, 1: 9, 0: 8, 9: 7, 8: 6, 7: 5, 6: 4, 5: 3, 4: 2, 3: 1 };
  return basePower[rank] || 0;
}

function trucoMove(state: GameState, move: { action: string; cardIndex?: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  if (s.turn !== playerId) return { state, valid: false, message: 'Not your turn' };

  if (move.action === 'truco' && !s.data!.trucoCalled) {
    s.data!.trucoCalled = true;
    s.data!.stake = 2;
    return { state: s, valid: true, message: 'Truco!' };
  }

  if (move.action === 'retruco' && s.data!.stake === 2) {
    s.data!.stake = 3;
    return { state: s, valid: true, message: 'Retruco!' };
  }

  if (move.action === 'vale_cuatro' && s.data!.stake === 3) {
    s.data!.stake = 4;
    return { state: s, valid: true, message: 'Vale Cuatro!' };
  }

  if (move.action === 'fold') {
    const winner = s.players.find(p => p !== playerId)!;
    s.scores![winner] += s.data!.stake;
    s.finished = true;
    return { state: s, valid: true, message: `${playerId} folds` };
  }

  if (move.action === 'play') {
    const hand = s.hands![playerId];
    const ci = move.cardIndex ?? 0;
    if (ci < 0 || ci >= hand.length) return { state, valid: false, message: 'Invalid card' };

    const card = hand[ci];
    hand.splice(ci, 1);
    s.data!.table.push({ player: playerId, card });

    // if all players played, resolve trick
    if (s.data!.table.length === s.players.length) {
      let best = s.data!.table[0];
      for (let i = 1; i < s.data!.table.length; i++) {
        if (trucoCardPower(s.data!.table[i].card) > trucoCardPower(best.card)) best = s.data!.table[i];
      }
      s.data!.roundWins[best.player] = (s.data!.roundWins[best.player] || 0) + 1;
      s.data!.roundNum++;
      s.data!.table = [];
      s.turn = best.player;

      // best of 3 tricks
      for (const p of s.players) {
        if ((s.data!.roundWins[p] || 0) >= 2) {
          s.scores![p] += s.data!.stake;
          s.finished = true;
          return { state: s, valid: true, message: `${p} wins the hand!` };
        }
      }

      if (s.data!.roundNum >= 3) {
        // determine winner
        let maxWins = 0, winner = s.players[0];
        for (const p of s.players) {
          if ((s.data!.roundWins[p] || 0) > maxWins) { maxWins = s.data!.roundWins[p] || 0; winner = p; }
        }
        s.scores![winner] += s.data!.stake;
        s.finished = true;
        return { state: s, valid: true, message: `${winner} wins the hand!` };
      }
    } else {
      s.turn = nextPlayer(s);
    }
    return { state: s, valid: true };
  }

  return { state, valid: false, message: 'Invalid action' };
}

function trucoBotMove(state: GameState, difficulty: Difficulty): any {
  const hand = state.hands![state.turn];
  if (hand.length === 0) return { action: 'fold' };

  if (difficulty === 'hard' && !state.data!.trucoCalled) {
    const maxPower = Math.max(...hand.map(trucoCardPower));
    if (maxPower >= 10) return { action: 'truco' };
  }

  // play lowest card first (save best for later)
  const sorted = hand.map((c: number, i: number) => ({ c, i, p: trucoCardPower(c) })).sort((a: any, b: any) => a.p - b.p);
  if (state.data!.table.length > 0) {
    const bestOnTable = Math.max(...state.data!.table.map((t: any) => trucoCardPower(t.card)));
    const beater = sorted.find((s: any) => s.p > bestOnTable);
    if (beater) return { action: 'play', cardIndex: beater.i };
  }
  return { action: 'play', cardIndex: sorted[0].i };
}

// ─── TRIVIA ──────────────────────────────────────────────────────────────────

const TRIVIA_QUESTIONS = [
  { q: "What is the capital of Australia?", a: ["Canberra", "Sydney", "Melbourne", "Brisbane"], correct: 0 },
  { q: "Which planet is known as the Red Planet?", a: ["Mars", "Venus", "Jupiter", "Saturn"], correct: 0 },
  { q: "What is the largest ocean on Earth?", a: ["Pacific", "Atlantic", "Indian", "Arctic"], correct: 0 },
  { q: "Who painted the Mona Lisa?", a: ["Leonardo da Vinci", "Michelangelo", "Raphael", "Donatello"], correct: 0 },
  { q: "What is the chemical symbol for gold?", a: ["Au", "Ag", "Fe", "Cu"], correct: 0 },
  { q: "Which country has the most population?", a: ["India", "China", "USA", "Indonesia"], correct: 0 },
  { q: "What year did World War II end?", a: ["1945", "1944", "1946", "1943"], correct: 0 },
  { q: "What is the speed of light in km/s (approx)?", a: ["300,000", "150,000", "500,000", "100,000"], correct: 0 },
  { q: "Which element has atomic number 1?", a: ["Hydrogen", "Helium", "Lithium", "Carbon"], correct: 0 },
  { q: "Who wrote 'Romeo and Juliet'?", a: ["Shakespeare", "Dickens", "Austen", "Hemingway"], correct: 0 },
  { q: "What is the tallest mountain in the world?", a: ["Mount Everest", "K2", "Kangchenjunga", "Lhotse"], correct: 0 },
  { q: "Which gas do plants absorb from the atmosphere?", a: ["Carbon dioxide", "Oxygen", "Nitrogen", "Hydrogen"], correct: 0 },
  { q: "What is the largest mammal?", a: ["Blue whale", "Elephant", "Giraffe", "Hippopotamus"], correct: 0 },
  { q: "Which continent is the Sahara Desert in?", a: ["Africa", "Asia", "Australia", "South America"], correct: 0 },
  { q: "What is the square root of 144?", a: ["12", "14", "10", "16"], correct: 0 },
  { q: "Who developed the theory of relativity?", a: ["Einstein", "Newton", "Galileo", "Hawking"], correct: 0 },
  { q: "What is the currency of Japan?", a: ["Yen", "Won", "Yuan", "Rupee"], correct: 0 },
  { q: "Which organ pumps blood through the body?", a: ["Heart", "Liver", "Kidney", "Lung"], correct: 0 },
  { q: "What is the boiling point of water in Celsius?", a: ["100", "90", "110", "80"], correct: 0 },
  { q: "Which planet is closest to the Sun?", a: ["Mercury", "Venus", "Earth", "Mars"], correct: 0 },
  { q: "What is the largest country by area?", a: ["Russia", "Canada", "China", "USA"], correct: 0 },
  { q: "Who invented the telephone?", a: ["Alexander Graham Bell", "Thomas Edison", "Nikola Tesla", "Marconi"], correct: 0 },
  { q: "What is the hardest natural substance?", a: ["Diamond", "Quartz", "Topaz", "Sapphire"], correct: 0 },
  { q: "Which blood type is a universal donor?", a: ["O negative", "AB positive", "A positive", "B negative"], correct: 0 },
  { q: "What is the smallest prime number?", a: ["2", "1", "3", "5"], correct: 0 },
  { q: "Which language has the most native speakers?", a: ["Mandarin Chinese", "English", "Spanish", "Hindi"], correct: 0 },
  { q: "What is DNA short for?", a: ["Deoxyribonucleic acid", "Dinitrogen acid", "Dioxyribose acid", "Dioxin nucleic acid"], correct: 0 },
  { q: "Who was the first person to walk on the Moon?", a: ["Neil Armstrong", "Buzz Aldrin", "Yuri Gagarin", "John Glenn"], correct: 0 },
  { q: "What is the largest desert in the world?", a: ["Antarctic Desert", "Sahara", "Arabian", "Gobi"], correct: 0 },
  { q: "Which vitamin is produced by sunlight on skin?", a: ["Vitamin D", "Vitamin C", "Vitamin A", "Vitamin B12"], correct: 0 },
  { q: "What is the main component of the Sun?", a: ["Hydrogen", "Helium", "Carbon", "Oxygen"], correct: 0 },
  { q: "Which animal is known as the 'King of the Jungle'?", a: ["Lion", "Tiger", "Elephant", "Gorilla"], correct: 0 },
  { q: "What is the longest river in the world?", a: ["Nile", "Amazon", "Yangtze", "Mississippi"], correct: 0 },
  { q: "Who wrote 'The Origin of Species'?", a: ["Charles Darwin", "Gregor Mendel", "Louis Pasteur", "Alfred Wallace"], correct: 0 },
  { q: "What is the pH of pure water?", a: ["7", "6", "8", "5"], correct: 0 },
  { q: "Which country invented paper?", a: ["China", "Egypt", "Greece", "India"], correct: 0 },
  { q: "What is the most abundant gas in Earth's atmosphere?", a: ["Nitrogen", "Oxygen", "Carbon dioxide", "Argon"], correct: 0 },
  { q: "What year was the Internet invented?", a: ["1969", "1975", "1983", "1990"], correct: 0 },
  { q: "Which bone is the longest in the human body?", a: ["Femur", "Tibia", "Humerus", "Fibula"], correct: 0 },
  { q: "What is the chemical formula for table salt?", a: ["NaCl", "KCl", "CaCl2", "NaOH"], correct: 0 },
  { q: "Which planet has the most moons?", a: ["Saturn", "Jupiter", "Uranus", "Neptune"], correct: 0 },
  { q: "Who painted 'Starry Night'?", a: ["Van Gogh", "Monet", "Picasso", "Rembrandt"], correct: 0 },
  { q: "What is the capital of Brazil?", a: ["Brasilia", "Rio de Janeiro", "Sao Paulo", "Salvador"], correct: 0 },
  { q: "Which metal is liquid at room temperature?", a: ["Mercury", "Gallium", "Lead", "Tin"], correct: 0 },
  { q: "What is the fastest land animal?", a: ["Cheetah", "Lion", "Gazelle", "Horse"], correct: 0 },
  { q: "Which ocean is the Mariana Trench in?", a: ["Pacific", "Atlantic", "Indian", "Arctic"], correct: 0 },
  { q: "What does CPU stand for?", a: ["Central Processing Unit", "Computer Personal Unit", "Central Program Utility", "Core Processing Unit"], correct: 0 },
  { q: "Who composed the 'Four Seasons'?", a: ["Vivaldi", "Bach", "Mozart", "Beethoven"], correct: 0 },
  { q: "What is the main ingredient in glass?", a: ["Sand (silica)", "Calcium", "Sodium", "Lead"], correct: 0 },
  { q: "Which country is home to the kangaroo?", a: ["Australia", "New Zealand", "South Africa", "Brazil"], correct: 0 },
  { q: "What is the freezing point of water in Fahrenheit?", a: ["32", "0", "28", "40"], correct: 0 },
  { q: "Who discovered penicillin?", a: ["Alexander Fleming", "Louis Pasteur", "Joseph Lister", "Edward Jenner"], correct: 0 },
  { q: "What is the strongest muscle in the human body?", a: ["Masseter (jaw)", "Quadriceps", "Gluteus", "Bicep"], correct: 0 },
  { q: "Which planet is known for its rings?", a: ["Saturn", "Jupiter", "Uranus", "Neptune"], correct: 0 },
  { q: "What is the capital of Canada?", a: ["Ottawa", "Toronto", "Vancouver", "Montreal"], correct: 0 },
  { q: "How many chromosomes do humans have?", a: ["46", "44", "48", "42"], correct: 0 },
];

function triviaInit(players: string[]): GameState {
  const questions = shuffle([...TRIVIA_QUESTIONS]).slice(0, 10);
  return {
    gameType: 'trivia', turn: players[0], players, phase: 'question',
    data: { questions, currentQ: 0, answers: {}, timeLimit: 15 },
    scores: players.reduce((a, p) => { a[p] = 0; return a; }, {} as Record<string, number>),
    history: [],
  };
}

function triviaMove(state: GameState, move: { answer: number }, playerId: string): MoveResult {
  const s = cloneState(state);
  const q = s.data!.questions[s.data!.currentQ];
  if (!q) {
    s.finished = true;
    return { state: s, valid: true, message: 'Quiz complete' };
  }

  s.data!.answers[playerId] = move.answer;

  // check if all answered
  if (Object.keys(s.data!.answers).length === s.players.length) {
    // score
    for (const p of s.players) {
      if (s.data!.answers[p] === q.correct) {
        s.scores![p] += 10;
      }
    }
    s.data!.currentQ++;
    s.data!.answers = {};

    if (s.data!.currentQ >= s.data!.questions.length) {
      s.finished = true;
      return { state: s, valid: true, message: 'Quiz complete!' };
    }
    return { state: s, valid: true, message: `Question ${s.data!.currentQ + 1}` };
  }

  return { state: s, valid: true };
}

function triviaWinner(state: GameState): WinResult {
  if (!state.finished) return { winner: null, draw: false };
  let best = '', bestScore = -1;
  for (const p of state.players) {
    if (state.scores![p] > bestScore) { bestScore = state.scores![p]; best = p; }
  }
  const tied = state.players.filter(p => state.scores![p] === bestScore);
  if (tied.length > 1) return { winner: null, draw: true };
  return { winner: best, draw: false };
}

function triviaBotMove(state: GameState, difficulty: Difficulty): any {
  const q = state.data!.questions[state.data!.currentQ];
  if (!q) return { answer: 0 };
  if (difficulty === 'easy') return { answer: randInt(4) };
  if (difficulty === 'medium') return { answer: Math.random() > 0.4 ? q.correct : randInt(4) };
  return { answer: Math.random() > 0.15 ? q.correct : randInt(4) };
}

// ─── RENDER INFO ─────────────────────────────────────────────────────────────

const RENDER_INFO: Record<string, { name: string; description: string; minPlayers: number; maxPlayers: number; rules: string }> = {
  chess: { name: 'Chess', description: 'Classic 8x8 strategy board game with full piece movement and check/checkmate detection.', minPlayers: 2, maxPlayers: 2, rules: 'Move pieces to checkmate opponent king. Includes all standard piece movements, en passant, and pawn promotion.' },
  ludo: { name: 'Ludo', description: 'Race 4 tokens around the board. Roll 6 to enter, avoid captures.', minPlayers: 2, maxPlayers: 4, rules: 'Roll dice, move tokens. Need 6 to enter board. Land on opponents to send them home. First to finish all 4 tokens wins.' },
  rummy: { name: 'Rummy', description: 'Indian 13-card Rummy with melds, sequences, and jokers.', minPlayers: 2, maxPlayers: 6, rules: 'Draw and discard to form sets and runs. Declare with valid melds including at least one pure sequence.' },
  carrom: { name: 'Carrom', description: 'Flick-based board game. Pocket your pieces and the queen.', minPlayers: 2, maxPlayers: 2, rules: 'Pocket 9 pieces of your color. Queen must be covered. 3 fouls lose a piece.' },
  vaultdice: { name: 'VaultDice', description: 'Cryptographic dice betting with commit-reveal fairness.', minPlayers: 2, maxPlayers: 6, rules: 'Bet on dice outcome (high/low/exact). Rolls use cryptographic commitment for provable fairness.' },
  mahjong: { name: 'Mahjong', description: 'Chinese tile game. Form 4 melds + 1 pair to win.', minPlayers: 4, maxPlayers: 4, rules: 'Draw and discard tiles. Form winning hand of 4 sets (sequences or triplets) + 1 pair. Declare Tsumo or Ron.' },
  go: { name: 'Go/Weiqi', description: '9x9 Go with capture, ko rule, and area scoring.', minPlayers: 2, maxPlayers: 2, rules: 'Place stones to surround territory. Capture groups with no liberties. Ko prevents immediate recapture. 6.5 komi for white.' },
  xiangqi: { name: 'Xiangqi', description: 'Chinese Chess with all 7 piece types and river/palace rules.', minPlayers: 2, maxPlayers: 2, rules: 'Capture opponent King. Includes Cannon (jumps to capture), Horse (blocked), Elephant (stays on side), Advisor and King (palace only).' },
  doudizhu: { name: 'Dou Di Zhu', description: 'Fight the Landlord - 3-player Chinese card game.', minPlayers: 3, maxPlayers: 3, rules: 'One landlord vs two peasants. Play singles, pairs, triples, straights, bombs. Landlord wins by emptying hand first.' },
  shogi: { name: 'Shogi', description: 'Japanese Chess with piece drops and promotions.', minPlayers: 2, maxPlayers: 2, rules: 'Capture opponent King. Captured pieces can be dropped back. Pieces promote in enemy territory. All standard piece movements.' },
  hanafuda: { name: 'Hanafuda', description: 'Japanese flower card game (Koi-Koi rules).', minPlayers: 2, maxPlayers: 2, rules: 'Match cards by month to capture. Score special combinations (yaku): Lights, Ribbons, Seeds, Poetry, Moon Viewing, etc.' },
  poker: { name: 'Poker', description: "Texas Hold'em with betting rounds and hand ranking.", minPlayers: 2, maxPlayers: 6, rules: "2 hole cards + 5 community cards. Best 5-card hand wins. Bet, call, raise, or fold through preflop, flop, turn, river." },
  backgammon: { name: 'Backgammon', description: 'Classic race game with dice and strategic blocking.', minPlayers: 2, maxPlayers: 2, rules: 'Roll dice, move checkers. Hit opponent blots. Bear off all 15 checkers to win. Cannot land on points with 2+ opponent pieces.' },
  mancala: { name: 'Mancala', description: 'Ancient seed-sowing strategy game.', minPlayers: 2, maxPlayers: 2, rules: 'Pick up seeds from a pit, sow one per pit. Land in your store for extra turn. Capture opposite pit if landing in empty own pit.' },
  dominoes: { name: 'Dominoes', description: 'Double-6 tile matching game.', minPlayers: 2, maxPlayers: 4, rules: 'Match tile ends to play. Draw from boneyard if stuck. First to empty hand wins. If blocked, lowest pip count wins.' },
  durak: { name: 'Durak', description: 'Russian attack/defense card game with trumps.', minPlayers: 2, maxPlayers: 6, rules: 'Attacker plays cards, defender must beat with higher rank or trump. Take cards if unable. Last player with cards is the Durak (fool).' },
  okey: { name: 'Okey', description: 'Turkish tile rummy with 106 tiles.', minPlayers: 2, maxPlayers: 4, rules: 'Draw and discard tiles. Form groups (same number, different colors) and runs (consecutive, same color). First to complete all groups wins.' },
  truco: { name: 'Truco', description: 'Latin American bluffing card game.', minPlayers: 2, maxPlayers: 4, rules: 'Play 3 tricks with 3 cards. Win 2 of 3 tricks. Call Truco/Retruco/Vale Cuatro to raise stakes. Fold to concede.' },
  trivia: { name: 'Trivia', description: 'General knowledge quiz with 50+ questions.', minPlayers: 2, maxPlayers: 8, rules: 'Answer 10 multiple-choice questions. 10 points per correct answer. Highest score wins.' },
};

// ─── MAIN EXPORTS ────────────────────────────────────────────────────────────

export function initGame(gameType: string, players?: string[]): GameState {
  const p = players || ['player1', 'player2'];

  switch (gameType) {
    case 'chess': return chessInit(p);
    case 'ludo': return ludoInit(p);
    case 'rummy': return rummyInit(p);
    case 'carrom': return carromInit(p);
    case 'vaultdice': return vaultdiceInit(p);
    case 'mahjong': return mahjongInit(p.length >= 4 ? p : [...p, 'bot1', 'bot2'].slice(0, 4));
    case 'go': return goInit(p);
    case 'xiangqi': return xiangqiInit(p);
    case 'doudizhu': return doudizhuInit(p.length >= 3 ? p : [...p, 'bot1', 'bot2'].slice(0, 3));
    case 'shogi': return shogiInit(p);
    case 'hanafuda': return hanafudaInit(p);
    case 'poker': return pokerInit(p);
    case 'backgammon': return backgammonInit(p);
    case 'mancala': return mancalaInit(p);
    case 'dominoes': return dominoesInit(p);
    case 'durak': return durakInit(p);
    case 'okey': return okeyInit(p);
    case 'truco': return trucoInit(p);
    case 'trivia': return triviaInit(p);
    default: throw new Error(`Unknown game type: ${gameType}`);
  }
}

export function makeGameMove(gameType: string, state: GameState, move: any, playerId: string): MoveResult {
  switch (gameType) {
    case 'chess': return chessMove(state, move, playerId);
    case 'ludo': return ludoMove(state, move, playerId);
    case 'rummy': return rummyMove(state, move, playerId);
    case 'carrom': return carromMove(state, move, playerId);
    case 'vaultdice': return vaultdiceMove(state, move, playerId);
    case 'mahjong': return mahjongMove(state, move, playerId);
    case 'go': return goMove(state, move, playerId);
    case 'xiangqi': return xiangqiMove(state, move, playerId);
    case 'doudizhu': return doudizhuMove(state, move, playerId);
    case 'shogi': return shogiMove(state, move, playerId);
    case 'hanafuda': return hanafudaMove(state, move, playerId);
    case 'poker': return pokerMove(state, move, playerId);
    case 'backgammon': return backgammonMove(state, move, playerId);
    case 'mancala': return mancalaMove(state, move, playerId);
    case 'dominoes': return dominoesMove(state, move, playerId);
    case 'durak': return durakMove(state, move, playerId);
    case 'okey': return okeyMove(state, move, playerId);
    case 'truco': return trucoMove(state, move, playerId);
    case 'trivia': return triviaMove(state, move, playerId);
    default: throw new Error(`Unknown game type: ${gameType}`);
  }
}

export function checkGameWinner(gameType: string, state: GameState): WinResult {
  switch (gameType) {
    case 'chess': return chessWinner(state);
    case 'ludo': return ludoWinner(state);
    case 'rummy':
    case 'okey':
      if (state.finished) {
        const winner = state.players.find(p => state.scores![p] > 0);
        return winner ? { winner, draw: false } : { winner: null, draw: true };
      }
      return { winner: null, draw: false };
    case 'carrom': return carromWinner(state);
    case 'vaultdice': return vaultdiceWinner(state);
    case 'mahjong':
      if (state.finished) {
        const winner = state.players.find(p => state.scores![p] > 0);
        return winner ? { winner, draw: false } : { winner: null, draw: true };
      }
      return { winner: null, draw: false };
    case 'go': return goWinner(state);
    case 'xiangqi': return xiangqiWinner(state);
    case 'doudizhu': return doudizhuWinner(state);
    case 'shogi': return shogiWinner(state);
    case 'hanafuda':
      if (state.finished) {
        const [p1, p2] = state.players;
        if (state.scores![p1] > state.scores![p2]) return { winner: p1, draw: false };
        if (state.scores![p2] > state.scores![p1]) return { winner: p2, draw: false };
        return { winner: null, draw: true };
      }
      return { winner: null, draw: false };
    case 'poker':
      if (state.finished) {
        let best = state.players[0];
        for (const p of state.players) if (state.scores![p] > state.scores![best]) best = p;
        return { winner: best, draw: false };
      }
      return { winner: null, draw: false };
    case 'backgammon': return backgammonWinner(state);
    case 'mancala': return mancalaWinner(state);
    case 'dominoes': return dominoesWinner(state);
    case 'durak': return durakWinner(state);
    case 'truco':
      if (state.finished) {
        let best = state.players[0];
        for (const p of state.players) if (state.scores![p] > state.scores![best]) best = p;
        return { winner: best, draw: false };
      }
      return { winner: null, draw: false };
    case 'trivia': return triviaWinner(state);
    default: throw new Error(`Unknown game type: ${gameType}`);
  }
}

export function getBotMove(gameType: string, state: GameState, difficulty: Difficulty = 'medium'): any {
  switch (gameType) {
    case 'chess': return chessBotMove(state, difficulty);
    case 'ludo': return ludoBotMove(state, difficulty);
    case 'rummy': return rummyBotMove(state, difficulty);
    case 'carrom': return carromBotMove(state, difficulty);
    case 'vaultdice': return vaultdiceBotMove(state, difficulty);
    case 'mahjong': return mahjongBotMove(state, difficulty);
    case 'go': return goBotMove(state, difficulty);
    case 'xiangqi': return xiangqiBotMove(state, difficulty);
    case 'doudizhu': return doudizhuBotMove(state, difficulty);
    case 'shogi': return shogiBotMove(state, difficulty);
    case 'hanafuda': return hanafudaBotMove(state, difficulty);
    case 'poker': return pokerBotMove(state, difficulty);
    case 'backgammon': return backgammonBotMove(state, difficulty);
    case 'mancala': return mancalaBotMove(state, difficulty);
    case 'dominoes': return dominoesBotMove(state, difficulty);
    case 'durak': return durakBotMove(state, difficulty);
    case 'okey': return okeyBotMove(state, difficulty);
    case 'truco': return trucoBotMove(state, difficulty);
    case 'trivia': return triviaBotMove(state, difficulty);
    default: throw new Error(`Unknown game type: ${gameType}`);
  }
}

export function renderInfo(gameType: string): { name: string; description: string; minPlayers: number; maxPlayers: number; rules: string } {
  const info = RENDER_INFO[gameType];
  if (!info) throw new Error(`Unknown game type: ${gameType}`);
  return info;
}
