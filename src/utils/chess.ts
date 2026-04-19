import { PlayingCard } from '@/interfaces/chessgame.interface';
import { Move, Chess } from 'chess.js';
const CardChessMap = {
  a: "2",
  b: "3",
  c: "4",
  d: "5",
  e: "6",
  f: "7",
  g: "8",
  h: "9"
};

type CardChessMove = Move & {
  card: PlayingCard;
};

function checkMove(move: Move, card: PlayingCard) {
  if (!card) return false;
  if (card.suit === "joker") return true;

  const cardValue = String(card.value);

  const pawnCards = ["2", "3", "4", "5", "6", "7", "8", "9"];
  if (pawnCards.includes(cardValue)) {
    if (move.piece !== "p") return false;

    const fromSquare = move.from;
    if (!fromSquare) return false;
    const file = fromSquare[0] as keyof typeof CardChessMap;
    if (CardChessMap && CardChessMap[file]) {
      return CardChessMap[file] === cardValue;
    }
    return true;
  }

  const mapping: Record<string, string> = {
    A: "r",
    "10": "n",
    J: "b",
    Q: "q",
    K: "k",
  };

  if (mapping[cardValue]) {
    return move.piece === mapping[cardValue];
  }

  return false;
}

export function getValidMovesForMultipleCards(game: Chess, cards: PlayingCard[]): CardChessMove[] {
  if (!cards || cards.length === 0) return [];
  const allMoves = game.moves({ verbose: true }) as Move[];
  const validMovesMap = new Map<string, CardChessMove>();
  for (const card of cards) {
    const movesForCard = allMoves.filter((move) => {
      if (!move) return false;
      const sideToMove = game.turn();
      if (move.color !== sideToMove) return false;
      return checkMove(move, card);
    });
    movesForCard.forEach((move) => {
      const botMove = { ...move, card } as CardChessMove;
      validMovesMap.set(`${move.from}${move.to}`, botMove);
    });
  }
  return Array.from(validMovesMap.values());
}
