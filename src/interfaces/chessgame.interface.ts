import { ObjectId } from "mongoose";


export interface MoveHistory {
  cards: PlayingCard[]; // Multiple cards drawn
  usedCard: PlayingCard; // Which card was actually used for this move
  move?: {
    from: string;
    to: string;
    piece: string;
  },
  player: "white" | "black";
  isFailedAttempt?: boolean; // For tracking failed check escape attempts
}


export interface GameState {
  fen: string;
  pgn?: string;
  turn: 'white' | 'black';
  status: 'waiting_for_opponent' | 'active' | 'completed' | 'abandoned';
  winner?: 'white' | 'black' | 'draw';
  moves?: MoveHistory[];
  current_card?: string;
  current_cards?: string[];
  check_attempts?: number;
  cards_deck?: {
    suit: string;
    value: string;
    color: string;
  }[];
};

export interface ChessGame {
  _id?: string;
  game_id: string;
  is_vs_bot: boolean;
  cards_to_draw: number;
  player_white: string | ObjectId;
  player_black: string | ObjectId;
  /** Whether player_white is a guest (helps distinguish guest vs user IDs) */
  player_white_is_guest?: boolean;
  /** Whether player_black is a guest */
  player_black_is_guest?: boolean;
  /** Display name for white player (username or guest name) */
  player_white_name?: string;
  /** Display name for black player */
  player_black_name?: string;
  game_state: GameState;
  created_at?: Date;
  updated_at?: Date;
  completed_at?: Date;
  version?: number;
}

export type PieceType = 'pawn' | 'rook' | 'knight' | 'bishop' | 'queen' | 'king';
export type PieceColor = 'white' | 'black';
export type BoardOrientation = 'white' | 'black' | 'auto';
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades' | 'joker';

export interface Piece {
  type: PieceType;
  color: PieceColor;
  id: string;
}

export interface Position {
  row: string;
  col: string;
}

export interface PlayingCard {
  suit: Suit;
  value: string;
  color: 'red' | 'black';
}
