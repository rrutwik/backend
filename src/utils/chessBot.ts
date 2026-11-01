import { Chess, Move } from 'chess.js';
import { PlayingCard } from '@/interfaces/chessgame.interface';
import { getValidMovesForMultipleCards } from '@/utils/chess';

/**
 * Move choice for server-run matchmaking bots. The scoring is a port of the client's vs-bot logic
 * (card-chess-web/src/utils/bot.ts); `skill` lets us run weaker bots so new players can win.
 */

export interface BotMove {
  from: string;
  to: string;
  promotion?: string;
  /** Position after the move; this is what update_game_state expects as `fen`. */
  fen: string;
  usedCard: PlayingCard;
}

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function scoreMove(chess: Chess, move: Move, rng: () => number): number {
  let score = 0;
  chess.move({ from: move.from, to: move.to, promotion: move.promotion });
  if (move.captured) score += (PIECE_VALUE[move.captured] || 0) * 10;
  if (chess.inCheck()) score += 3;
  if (chess.isCheckmate()) score += 1000;
  if (chess.isStalemate() || chess.isDraw()) score -= 20;

  // material from the mover's point of view (after the move it is the opponent's turn)
  const turn = chess.turn();
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const value = PIECE_VALUE[piece.type] || 0;
      score += piece.color !== turn ? value : -value;
    }
  }
  score += rng() * 0.5;
  chess.undo();
  return score;
}

/**
 * Picks a move for the bot using only the cards it holds. Returns null when no held card allows a
 * legal move (the caller should draw again). With probability `skill` the best-scored move is
 * played, otherwise a random legal one.
 */
export function chooseBotMove(
  fen: string,
  cards: PlayingCard[],
  skill: number,
  rng: () => number = Math.random,
): BotMove | null {
  const chess = new Chess(fen);
  const allowed = getValidMovesForMultipleCards(chess, cards);
  if (allowed.length === 0) return null;
  const cardFor = new Map(allowed.map((m) => [`${m.from}${m.to}`, m.card]));

  // Concrete legal moves for the allowed from->to pairs; a promotion yields several, keep only the queen.
  const candidates = chess
    .moves({ verbose: true })
    .filter((m) => cardFor.has(`${m.from}${m.to}`) && (!m.promotion || m.promotion === 'q'));
  if (candidates.length === 0) return null;

  let chosen: Move;
  if (rng() < skill) {
    chosen = candidates
      .map((m) => ({ m, score: scoreMove(chess, m, rng) }))
      .sort((a, b) => b.score - a.score)[0].m;
  } else {
    chosen = candidates[Math.floor(rng() * candidates.length)];
  }

  chess.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
  return {
    from: chosen.from,
    to: chosen.to,
    promotion: chosen.promotion,
    fen: chess.fen(),
    usedCard: cardFor.get(`${chosen.from}${chosen.to}`) as PlayingCard,
  };
}

/** Deterministic "thinking time" (1.5-5s) for a bot step, stable across processes and restarts. */
export function botThinkMs(gameId: string, version: number): number {
  let h = 2166136261;
  const s = `${gameId}:${version}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 1500 + ((h >>> 0) % 3500);
}
