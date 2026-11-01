/**
 * Tests for the matchmaking bot logic (src/utils/chessBot.ts + helpers in src/utils/matchmaking.ts).
 * No database or Redis needed.
 *   npx ts-node --transpile-only scripts/chessBot.test.ts
 */
import assert from 'assert';
import { Chess } from 'chess.js';
import { chooseBotMove, botThinkMs } from '../src/utils/chessBot';
import { applyClientMove } from '../src/utils/chessMove';
import { botDelayMs, botLobbyCount } from '../src/utils/matchmaking';
import { ChessGame, GameState, PlayingCard } from '../src/interfaces/chessgame.interface';
import { getValidMovesForMultipleCards } from '../src/utils/chess';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const randomCard = (): PlayingCard => {
  if (Math.random() < 0.04) return { suit: 'joker', value: 'Joker', color: 'red' };
  const suit = SUITS[Math.floor(Math.random() * 4)];
  return { suit, value: VALUES[Math.floor(Math.random() * VALUES.length)], color: suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black' };
};

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log('  ok -', name); };

test('returns null when no held card allows a move', () => {
  // only a "5" pawn card (e-file pawns need 6... d-file needs 5) -> fine; use a king card at the start: king has no moves
  assert.strictEqual(chooseBotMove(START, [{ suit: 'hearts', value: 'K', color: 'red' }], 1), null);
});

test('plays the move that wins material at full skill', () => {
  // white queen can take an undefended black queen on d5; a Q card is held
  const fen = '4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1';
  const mv = chooseBotMove(fen, [{ suit: 'spades', value: 'Q', color: 'black' }], 1, () => 0);
  assert.ok(mv);
  assert.deepStrictEqual([mv!.from, mv!.to], ['d1', 'd5']);
});

test('promotion always yields a queen', () => {
  const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
  const mv = chooseBotMove(fen, [{ suit: 'hearts', value: '2', color: 'red' }], 0.5);
  assert.ok(mv);
  assert.strictEqual(mv!.promotion, 'q');
});

test('full bot-vs-bot games are always accepted by the server-side validator', () => {
  for (let g = 0; g < 20; g++) {
    let fen = START;
    let turn: 'white' | 'black' = 'white';
    let moves: unknown[] = [];
    let status: 'active' | 'completed' = 'active';
    for (let ply = 0; ply < 300 && status === 'active'; ply++) {
      // draw until the hand has a playable move (the real game: drawing again after a failed hand)
      let held: PlayingCard[] = [];
      let mv = null as ReturnType<typeof chooseBotMove>;
      for (let tries = 0; tries < 200 && !mv; tries++) {
        held = [randomCard(), randomCard(), randomCard()];
        mv = chooseBotMove(fen, held, Math.random());
      }
      if (!mv) break; // no playable hand found (e.g. only a king, boxed in) - skip this game
      // the chosen move must be legal for a held card
      assert.ok(getValidMovesForMultipleCards(new Chess(fen), held).some((m) => m.from === mv!.from && m.to === mv!.to));

      const game = { game_id: 'T', is_vs_bot: false, cards_to_draw: 3, player_white: 'w', player_black: 'b',
        game_state: { fen, turn, status: 'active', moves, current_cards: held } } as unknown as ChessGame;
      const submitted = { fen: mv.fen, moves: [{ move: { from: mv.from, to: mv.to }, usedCard: mv.usedCard }] } as unknown as GameState;
      const next = applyClientMove(game, submitted);
      assert.strictEqual(next.fen, mv.fen, 'server-derived fen equals the bot fen');
      fen = next.fen; turn = next.turn; moves = next.moves; status = next.status;
    }
  }
});

test('botLobbyCount stays within 5..100 and changes smoothly', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  let prev = botLobbyCount(start);
  let min = prev, max = prev;
  for (let i = 1; i < 20000; i++) {
    const c = botLobbyCount(start + i * 5000);
    assert.ok(c >= 5 && c <= 100, `count ${c} in range`);
    assert.ok(Math.abs(c - prev) <= 20, 'no big jumps between 5s samples');
    prev = c; min = Math.min(min, c); max = Math.max(max, c);
  }
  assert.ok(max - min > 40, `varies over time (min ${min}, max ${max})`);
});

test('botDelayMs is 3-8s and stable; botThinkMs is 1.5-5s and stable', () => {
  for (let i = 0; i < 1000; i++) {
    const d = botDelayMs(`player${i}`);
    assert.ok(d >= 3000 && d < 8000);
    assert.strictEqual(d, botDelayMs(`player${i}`));
    const t = botThinkMs(`GAME${i}`, i);
    assert.ok(t >= 1500 && t < 5000);
    assert.strictEqual(t, botThinkMs(`GAME${i}`, i));
  }
});

console.log(`chessBot tests: ${passed} passed`);
