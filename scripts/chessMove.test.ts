/**
 * Tests for server-side move validation (src/utils/chessMove.ts). No database or Redis needed.
 *   npx ts-node --transpile-only scripts/chessMove.test.ts
 */
import assert from 'assert';
import { Chess } from 'chess.js';
import { applyClientMove } from '../src/utils/chessMove';
import { ChessGame, GameState, PlayingCard } from '../src/interfaces/chessgame.interface';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const card = (value: string, suit: PlayingCard['suit'] = 'hearts'): PlayingCard => ({
  suit,
  value,
  color: suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black',
});
const joker = card('Joker', 'joker');

function gameWith(fen: string, held: PlayingCard[], turn: 'white' | 'black' = 'white'): ChessGame {
  return {
    game_id: 'T', is_vs_bot: false, cards_to_draw: 1, player_white: 'w', player_black: 'b',
    game_state: { fen, turn, status: 'active', moves: [], current_cards: held as never },
  } as ChessGame;
}

/** What the real client sends: the position after its move + a history whose last entry is the move. */
function submit(fenBefore: string, from: string, to: string, usedCard: PlayingCard, promotion?: string): GameState {
  const c = new Chess(fenBefore);
  const mv = c.move({ from, to, promotion });
  return {
    fen: c.fen(), turn: c.turn() === 'w' ? 'white' : 'black', status: 'active',
    moves: [{ cards: [usedCard], usedCard, player: 'white', move: { from: mv.from, to: mv.to, piece: mv.piece } }],
  } as GameState;
}

const throws400 = (fn: () => unknown, msg: RegExp) =>
  assert.throws(fn, (e: any) => e.status === 400 && msg.test(e.message));

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log('  ok -', name); };

test('legal pawn move with matching card is accepted and state is derived server-side', () => {
  const held = [card('5')]; // "5" moves the d-pawn
  const next = applyClientMove(gameWith(START, held), submit(START, 'd2', 'd4', held[0]));
  assert.strictEqual(next.turn, 'black');
  assert.strictEqual(next.status, 'active');
  assert.strictEqual(next.winner, undefined);
  assert.strictEqual(next.moves.length, 1);
  assert.deepStrictEqual(next.moves[0].move, { from: 'd2', to: 'd4', piece: 'p' });
  assert.deepStrictEqual(next.moves[0].usedCard, held[0]);
  assert.strictEqual(next.fen, new Chess(START).move('d4') && (() => { const c = new Chess(START); c.move('d4'); return c.fen(); })());
});

test('rejects a move the held card does not allow (e2e4 with a d-pawn card)', () => {
  const held = [card('5')];
  throws400(() => applyClientMove(gameWith(START, held), submit(START, 'e2', 'e4', held[0])), /not allowed with the cards/);
});

test('rejects moving without having drawn cards', () => {
  throws400(() => applyClientMove(gameWith(START, []), submit(START, 'd2', 'd4', card('5'))), /Draw cards/);
});

test('rejects a client-invented card (claims a joker it does not hold)', () => {
  const held = [card('5')];
  throws400(() => applyClientMove(gameWith(START, held), submit(START, 'e2', 'e4', joker)), /not allowed with the cards/);
});

test('rejects a position that does not match the claimed move (tampered FEN)', () => {
  const held = [card('5')];
  const sub = submit(START, 'd2', 'd4', held[0]);
  sub.fen = 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1'.replace('PPP1PPPP', 'PPP1PPPQ');
  throws400(() => applyClientMove(gameWith(START, held), sub), /does not match/);
});

test('client cannot set the winner or status (ignored; server derives them)', () => {
  const held = [card('5')];
  const sub = submit(START, 'd2', 'd4', held[0]);
  (sub as any).winner = 'white';
  (sub as any).status = 'completed';
  const next = applyClientMove(gameWith(START, held), sub);
  assert.strictEqual(next.status, 'active');
  assert.strictEqual(next.winner, undefined);
});

test('joker allows any piece', () => {
  const next = applyClientMove(gameWith(START, [joker]), submit(START, 'g1', 'f3', joker));
  assert.strictEqual(next.moves[0].move!.piece, 'n');
});

test('falls back to the usable held card when the claimed usedCard is wrong', () => {
  const held = [card('5'), card('K', 'spades')];
  const sub = submit(START, 'd2', 'd4', card('K', 'spades')); // king card can't move a pawn
  const next = applyClientMove(gameWith(START, held), sub);
  assert.deepStrictEqual(next.moves[0].usedCard, held[0]);
});

test('detects checkmate and awards the mover', () => {
  // 1.f3 e5 2.g4 -> black plays Qh4#
  const fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2';
  const q = card('Q', 'spades');
  const g = gameWith(fen, [q], 'black');
  const sub = submit(fen, 'd8', 'h4', q);
  sub.moves![0].player = 'black';
  const next = applyClientMove(g, sub);
  assert.strictEqual(next.status, 'completed');
  assert.strictEqual(next.winner, 'black');
});

test('detects stalemate as a draw', () => {
  // White to move Qb6?? style: black king a8 stalemated after white queen move
  const fen = '7k/8/5K2/8/8/8/8/6Q1 w - - 0 1'; // Qg1-g6 leaves black king h8 with no moves and not in check
  const q = card('Q', 'spades');
  const next = applyClientMove(gameWith(fen, [q]), submit(fen, 'g1', 'g6', q));
  assert.strictEqual(next.status, 'completed');
  assert.strictEqual(next.winner, 'draw');
});

test('promotion: accepts whichever piece the client promoted to', () => {
  const fen = '8/P7/8/8/8/8/k6K/8 w - - 0 1';
  const pawnA = card('2'); // "2" = a-pawn
  for (const promo of ['q', 'r', 'b', 'n']) {
    const next = applyClientMove(gameWith(fen, [pawnA]), submit(fen, 'a7', 'a8', pawnA, promo));
    assert.ok(next.fen.startsWith(`${promo.toUpperCase()}7`) || next.fen.includes(promo.toUpperCase()), `promoted to ${promo}`);
  }
});

test('previous move history is preserved and appended to', () => {
  const held = [card('5')];
  const g = gameWith(START, held);
  g.game_state.moves = [{ player: 'black', isFailedAttempt: true, cards: [], usedCard: card('9') } as never];
  const next = applyClientMove(g, submit(START, 'd2', 'd4', held[0]));
  assert.strictEqual(next.moves.length, 2);
  assert.strictEqual((next.moves[0] as any).isFailedAttempt, true);
});

console.log(`\n${passed} tests passed`);
