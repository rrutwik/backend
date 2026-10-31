import { Chess } from 'chess.js';
import { ChessGame, GameState, MoveHistory, PlayingCard } from '../interfaces/chessgame.interface';
import { HttpException } from '../exceptions/HttpException';
import { getValidMovesForMultipleCards } from './chess';

export interface AppliedMove {
  fen: string;
  turn: 'white' | 'black';
  status: 'active' | 'completed';
  winner?: 'white' | 'black' | 'draw';
  moves: MoveHistory[];
}

/**
 * Validates a move submitted by a client and returns the authoritative next state.
 * The client only tells us WHICH move it made (last entry of `moves`) and the position it ended
 * up in; the resulting position, turn, move history, game result and which card was used are all
 * derived here from the stored game. Throws HttpException(400) for anything illegal.
 */
export function applyClientMove(game: ChessGame, submitted: GameState): AppliedMove {
  const gs = game.game_state;
  const mover = gs.turn;
  const held = (gs.current_cards as unknown as PlayingCard[]) || [];
  if (held.length === 0) {
    throw new HttpException(400, 'Draw cards before making a move');
  }

  const submittedMoves = submitted?.moves || [];
  const claimed = submittedMoves[submittedMoves.length - 1];
  const from = claimed?.move?.from;
  const to = claimed?.move?.to;
  if (!from || !to || typeof submitted?.fen !== 'string') {
    throw new HttpException(400, 'A move is required');
  }

  const chess = new Chess(gs.fen);

  // Cards that allow this from->to move
  const sameCard = (a?: PlayingCard, b?: PlayingCard) =>
    !!a && !!b && a.suit === b.suit && a.value === b.value && a.color === b.color;
  const usableCards = held.filter((card) =>
    getValidMovesForMultipleCards(chess, [card]).some((m) => m.from === from && m.to === to)
  );
  if (usableCards.length === 0) {
    throw new HttpException(400, 'That move is not allowed with the cards you hold');
  }
  const usedCard = usableCards.find((c) => sameCard(c, claimed?.usedCard)) || usableCards[0];

  // Replay the move (try each promotion option) and require the client's position to match.
  let playedPiece: string | undefined;
  let resultFen: string | undefined;
  for (const candidate of chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to)) {
    const probe = new Chess(gs.fen);
    probe.move({ from: candidate.from, to: candidate.to, promotion: candidate.promotion });
    if (probe.fen() === submitted.fen) {
      playedPiece = candidate.piece;
      resultFen = probe.fen();
      break;
    }
  }
  if (!playedPiece || !resultFen) {
    throw new HttpException(400, 'Submitted position does not match the move');
  }

  const after = new Chess(resultFen);
  let status: 'active' | 'completed' = 'active';
  let winner: 'white' | 'black' | 'draw' | undefined;
  if (after.isCheckmate()) {
    status = 'completed';
    winner = mover;
  } else if (after.isStalemate() || after.isDraw()) {
    status = 'completed';
    winner = 'draw';
  }

  const historyEntry: MoveHistory = {
    move: { from, to, piece: playedPiece },
    cards: held,
    usedCard,
    player: mover,
  };

  return {
    fen: resultFen,
    turn: after.turn() === 'w' ? 'white' : 'black',
    status,
    winner,
    moves: [...(gs.moves || []), historyEntry],
  };
}
