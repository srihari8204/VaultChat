// lib/games/pieceNames.ts — what a screen reader says for a chess piece.
// The protocol's letters ('q', 'n') read aloud as letters; these are the words.
// Kept out of components/games/Chess.tsx, whose source is checked to contain
// no rules vocabulary (lib/games/gamesNative.selftest.ts).
export const PIECE_NAME: Record<string, string> = {
  k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn',
};
