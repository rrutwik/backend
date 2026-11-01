import { model, Schema, Document } from 'mongoose';
import { ChessGame } from '@/interfaces/chessgame.interface';
import { logger } from '@/utils/logger';

const GameStateSchema = new Schema({
  fen: {
    type: String,
    required: true,
    default: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  },
  pgn: {
    type: String,
    default: ''
  },
  turn: {
    type: String,
    enum: ['white', 'black'],
    required: true,
    default: 'white'
  },
  status: {
    type: String,
    enum: ['waiting_for_opponent', 'active', 'completed', 'abandoned'],
    required: true,
    default: 'waiting_for_opponent'
  },
  winner: {
    type: String,
    enum: ['white', 'black', 'draw']
  },
  moves: [{
    type: Object
  }],
  check_attempts: {
    type: Number,
    default: 0
  },
  current_card: {
    type: Object
  },
  current_cards: {
    type: Array,
    default: []
  },
  cards_deck: {
    type: Array
  }
}, { _id: false });

const ChessGameSchema: Schema = new Schema({
  game_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  is_vs_bot: {
    type: Boolean,
    required: true,
    default: false
  },
  has_bot: {
    type: Boolean,
    default: false,
  },
  player_white: {
    type: Schema.Types.ObjectId,
    required: false,
    index: true,
  },
  player_black: {
    type: Schema.Types.ObjectId,
    required: false,
    index: true,
  },
  player_white_is_guest: {
    type: Boolean,
    default: false,
  },
  player_black_is_guest: {
    type: Boolean,
    default: false,
  },
  player_white_name: {
    type: String,
  },
  player_black_name: {
    type: String,
  },
  cards_to_draw: {
    type: Number,
    required: true,
    default: 1,
    min: 1,
    max: 5
  },
  version: {
    type: Number,
    required: true,
    default: 0
  },
  // Was assigned in the service but missing from the schema, so mongoose silently dropped it
  // and getGameHistory's sort on it never worked.
  completed_at: {
    type: Date,
  },
  game_state: {
    type: GameStateSchema,
    required: true,
    default: () => ({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      turn: 'white',
      status: 'waiting_for_opponent',
      moves: []
    })
  }
}, {
  timestamps: true,
  collection: 'chess_games',
  versionKey: 'version'
});

// Add index for finding active games for a player
ChessGameSchema.index({ player_white: 1, 'game_state.status': 1 });
ChessGameSchema.index({ player_black: 1, 'game_state.status': 1 });
ChessGameSchema.index({ createdAt: -1 });
// Used by the auto-abandon sweep (status = 'active' AND updatedAt < threshold), which runs every 10s.
ChessGameSchema.index({ 'game_state.status': 1, updatedAt: 1 });
// Used by the bot worker (active games that have a bot seat), polled every second.
ChessGameSchema.index({ 'game_state.status': 1 }, { partialFilterExpression: { has_bot: true }, name: 'has_bot_active' });
export const ChessGameModel = model<ChessGame & Document>('chess_game', ChessGameSchema);
ChessGameModel.syncIndexes({ background: true }).catch((err) => {
  logger.error(`Failed to sync chess_games indexes: ${err}`);
});