import Container, { Service } from 'typedi';
import { ChessGame, GameState, MoveHistory, PlayingCard } from '@/interfaces/chessgame.interface';
import { ChessGameModel } from '@/models/chess_games.model';
import { HttpException } from '@/exceptions/HttpException';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';
import { TextEncoder } from 'util';
import { Guest } from '@/interfaces/guest.interface';
import { GuestModel } from '@/models/guest.model';
import { v4 as uuidv4 } from 'uuid';
import { User } from '@/interfaces/users.interface';
import { generateGuestName } from '@/utils/guestNames';
import { UserProfileModel } from '@/models/user_profile.model';
import { Chess } from 'chess.js';
import { getValidMovesForMultipleCards } from '@/utils/chess';
import { applyClientMove } from '@/utils/chessMove';

type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades' | 'joker';
type CardColor = 'red' | 'black';

interface DeckCard {
  suit: Suit;
  value: string;
  color: CardColor;
}

const SUITS: Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createShuffledDeck(): DeckCard[] {
  const cards: DeckCard[] = [];

  for (const suit of SUITS) {
    for (const value of VALUES) {
      cards.push({
        suit,
        value,
        color: (suit === 'hearts' || suit === 'diamonds') ? 'red' : 'black',
      });
    }
  }

  // Add 2 jokers (matches frontend deckUtils.ts)
  cards.push({ suit: 'joker', value: 'Joker', color: 'red' });
  cards.push({ suit: 'joker', value: 'Joker', color: 'black' });

  // Fisher-Yates shuffle
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  return cards;
}

@Service()
export class ChessService {

  public async createGuestSession(metadata: Record<string, any>): Promise<Guest> {
    try {
      const display_name = await this.resolveDisplayName(null, true, generateGuestName());
      const guestSession = await GuestModel.create({
        session_uuid: uuidv4(),
        display_name,
        metadata,
      });
      logger.info(`Guest session created: ${guestSession.session_uuid} (${display_name})`);
      return guestSession.toJSON();
    } catch (error) {
      logger.error(`Error creating guest session:, ${error}`);
      throw error;
    }
  }

  private async createUniqueGameId(creatorId: string): Promise<string> {
    const data = `${creatorId}-${Date.now()}-${Math.random()}`;
    const bytes = new TextEncoder().encode(data);

    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    return hashHex.slice(0, 12).toUpperCase();
  }

  private async resolveDisplayName(playerId: string, isGuest: boolean, fallbackName: string = generateGuestName()): Promise<string> {
    try {
      if (isGuest) {
        const guest = await GuestModel.findById(playerId).select('display_name');
        if (guest && guest.display_name) return guest.display_name;
      } else {
        const profile = await UserProfileModel.findOne({ user_id: playerId }).select('first_name last_name');
        if (profile) {
          const full = `${profile.first_name || ''} ${profile.last_name || ''}`.trim();
          if (full) return full;
        }
      }
    } catch (err) {
      logger.error(`Error resolving display name:, ${err}`);
    }
    return fallbackName;
  }

  public async createGame(
    playerId: string,
    playerColor: 'white' | 'black',
    isVsBot: boolean = false,
    cardsToDraw: number = 1,
    isGuest: boolean = false
  ): Promise<ChessGame> {
    try {
      if (!playerId) {
        throw new HttpException(400, 'Player ID is required to create a game');
      }
      const deck = createShuffledDeck();
      const whiteName = playerColor === 'white' ? await this.resolveDisplayName(playerId, isGuest) : undefined;
      const blackName = playerColor === 'black' ? await this.resolveDisplayName(playerId, isGuest) : undefined;

      const game = await ChessGameModel.create({
        game_id: await this.createUniqueGameId(playerId),
        player_white: playerColor === 'white' ? playerId : null,
        player_black: playerColor === 'black' ? playerId : null,
        player_white_is_guest: playerColor === 'white' ? isGuest : false,
        player_black_is_guest: playerColor === 'black' ? isGuest : false,
        player_white_name: whiteName,
        player_black_name: blackName,
        is_vs_bot: isVsBot,
        cards_to_draw: cardsToDraw,
        game_state: {
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          turn: 'white',
          status: isVsBot ? 'active' : 'waiting_for_opponent',
          moves: [],
          cards_deck: deck,
        }
      });

      logger.info(`Chess game created: ${game.game_id} by ${playerId} (${isGuest ? 'guest' : 'user'}) as ${playerColor}`);
      return game.toJSON();
    } catch (error) {
      logger.error(`Error creating chess game:, ${error}`);
      throw error;
    }
  }

  /**
   * Creates a matchmade game between two players with random color assignment.
   * Cards to draw is fixed at 3, and the deck is pre-initialized.
   */
  public async createMatchmadeGame(
    player1Id: string,
    player2Id: string,
    player1Meta: { isGuest: boolean },
    player2Meta: { isGuest: boolean },
  ): Promise<ChessGame> {
    try {
      const deck = createShuffledDeck();
      // Randomly assign colors
      const isPlayer1White = Math.random() < 0.5;
      const [whiteId, blackId] = isPlayer1White ? [player1Id, player2Id] : [player2Id, player1Id];
      const [whiteMeta, blackMeta] = isPlayer1White ? [player1Meta, player2Meta] : [player2Meta, player1Meta];

      const whiteName = await this.resolveDisplayName(whiteId, whiteMeta.isGuest);
      const blackName = await this.resolveDisplayName(blackId, blackMeta.isGuest);

      const game = await ChessGameModel.create({
        game_id: await this.createUniqueGameId(player1Id),
        player_white: whiteId,
        player_black: blackId,
        player_white_is_guest: whiteMeta.isGuest,
        player_black_is_guest: blackMeta.isGuest,
        player_white_name: whiteName,
        player_black_name: blackName,
        is_vs_bot: false,
        cards_to_draw: 3,
        game_state: {
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          turn: 'white',
          status: 'active',
          moves: [],
          cards_deck: deck,
        }
      });

      logger.info(`Matchmade game created: ${game.game_id} — white:${whiteId}(${game.player_white_name}) black:${blackId}(${game.player_black_name})`);
      return game.toJSON();
    } catch (error) {
      logger.error(`Error creating matchmade game:, ${error}`);
      throw error;
    }
  }

  public async drawCards(gameId: string, user?: User, guest?: Guest): Promise<ChessGame> {
    try {
      // lean(): plain object, skips mongoose document hydration (deck + move history are large)
      const game = await ChessGameModel.findOne({ game_id: gameId }).lean() as unknown as ChessGame;
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }

      if (game.game_state.status !== 'active') {
        throw new HttpException(400, 'Game is not active');
      }

      const playerId = user?._id?.toString() || guest?._id?.toString();
      const isPlayerWhite = game.player_white?.toString() === playerId;
      const isPlayerBlack = game.player_black?.toString() === playerId;
      if (!game.is_vs_bot && !isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }

      const playerColor = isPlayerWhite ? 'white' : 'black';
      if (!game.is_vs_bot && game.game_state.turn !== playerColor) {
        throw new HttpException(400, `It's not your turn. Current turn: ${game.game_state.turn}`);
      }

      // Mirror of the client rule (canDrawCard): you may only draw when you hold no cards, or none of
      // the cards you hold has a legal move. Without this a modified client could keep drawing until
      // it gets a hand it likes. A stale/duplicate request is treated as a no-op, not an error.
      const heldCards = (game.game_state.current_cards as unknown as PlayingCard[]) || [];
      if (heldCards.length > 0 && getValidMovesForMultipleCards(new Chess(game.game_state.fen), heldCards).length > 0) {
        logger.debug(`draw_card ignored for game ${gameId}: player still holds playable cards`);
        return game;
      }

      const deck: DeckCard[] = [...(game.game_state.cards_deck as DeckCard[] || [])];
      const drawCount = game.cards_to_draw;

      if (deck.length < drawCount + 10) {
        const refill = createShuffledDeck();
        deck.push(...refill);
        logger.info(`Deck refilled for game ${gameId}`);
      }

      if (deck.length < drawCount) {
        throw new HttpException(400, 'Not enough cards in deck');
      }

      const chess = new Chess(game.game_state.fen);
      let isCheckmateLoss = false;
      let newCheckAttempts = game.game_state.check_attempts || 0;

      if (chess.inCheck()) {
        newCheckAttempts += 1;
        if (newCheckAttempts >= 5) {
          isCheckmateLoss = true;
        }
      }
      // Optimistic concurrency: two overlapping draw_card events (double click / retry) must not
      // both apply, otherwise the deck is spliced twice from the same snapshot and failed-attempt
      // history is duplicated.
      const versionFilter = typeof game.version === 'number' ? { version: game.version } : {};
      const drawnCards = deck.splice(deck.length - drawCount, drawCount);
      const validMoves = getValidMovesForMultipleCards(chess, drawnCards);
      const newMoveHistory: MoveHistory[] = game.game_state.moves || [];
      if (validMoves.length === 0) {
        newMoveHistory.push({
          cards: drawnCards,
          usedCard: drawnCards[0],
          player: playerColor,
          isFailedAttempt: true,
        });
      }
      if (isCheckmateLoss && validMoves.length === 0) {
        const winnerColor = game.game_state.turn === 'white' ? 'black' : 'white';
        const checkmatedGame = await ChessGameModel.findOneAndUpdate(
          { game_id: gameId, ...versionFilter },
          {
            $set: {
              'game_state.moves': newMoveHistory,
              'game_state.status': 'completed',
              'game_state.winner': winnerColor,
              'game_state.check_attempts': newCheckAttempts,
              completed_at: new Date(),
            },
            $inc: { version: 1 }
          },
          { new: true }
        ).lean();
        if (!checkmatedGame) {
          return this.currentGameAfterDrawConflict(gameId);
        }
        logger.info(`Game over by check attempt limit for game ${gameId}`);
        return checkmatedGame as unknown as ChessGame;
      }

      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId, ...versionFilter },
        {
          $set: {
            'game_state.moves': newMoveHistory,
            'game_state.current_cards': drawnCards,
            'game_state.cards_deck': deck,
            'game_state.check_attempts': newCheckAttempts,
          },
          $inc: { version: 1 },
        },
        { new: true }
      ).lean();

      if (!updatedGame) {
        return this.currentGameAfterDrawConflict(gameId);
      }

      logger.debug(`Drew ${drawCount} cards for game ${gameId} by player ${playerId}`);
      return updatedGame as unknown as ChessGame;
    } catch (error) {
      logger.error(`Error drawing cards:, ${error}`);
      throw error;
    }
  }

  /**
   * A concurrent draw already changed the game after we read it. Instead of failing the
   * request (which would surface an error toast for a harmless double-fire), return the
   * current state so the caller just re-broadcasts what the winning draw produced.
   */
  private async currentGameAfterDrawConflict(gameId: string): Promise<ChessGame> {
    logger.debug(`Concurrent draw detected for game ${gameId}, returning current state`);
    const current = await ChessGameModel.findOne({ game_id: gameId }).lean() as unknown as ChessGame;
    if (!current) {
      throw new HttpException(404, 'Chess game not found');
    }
    return current;
  }

  /**
   * Lightweight lookup for socket join checks: only the player ids and status,
   * not the card deck / move history.
   */
  public async getGameParticipants(gameId: string): Promise<{
    player_white?: string;
    player_black?: string;
    status: GameState['status'];
  }> {
    const game = await ChessGameModel.findOne({ game_id: gameId })
      .select('player_white player_black game_state.status')
      .lean();
    if (!game) {
      throw new HttpException(404, 'Chess game not found');
    }
    return {
      player_white: game.player_white?.toString(),
      player_black: game.player_black?.toString(),
      status: game.game_state.status,
    };
  }

  public async registerOpponent(gameId: string, user?: User, guest?: Guest): Promise<ChessGame> {
    try {
      if (!user && !guest) {
        throw new HttpException(401, 'User not authenticated');
      }
      const game = await ChessGameModel.findOne({ game_id: gameId }).lean() as unknown as ChessGame;
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }

      // Check if game is waiting for opponent
      if (game.is_vs_bot || game.game_state.status !== 'waiting_for_opponent') {
        throw new HttpException(400, 'Game is not waiting for an opponent');
      }

      // Check if opponent is trying to join their own game
      const creatorId = game.player_white || game.player_black;
      const opponentId = user?._id.toString() || guest?._id.toString();
      if (creatorId?.toString() === opponentId) {
        throw new HttpException(400, 'Cannot join your own game as opponent');
      }

      // Determine opponent color and update game
      const creatorColor = game.player_white ? 'white' : 'black';
      const opponentColor = creatorColor === 'white' ? 'black' : 'white';
      const isGuest = !user && !!guest;
      const opponentName = await this.resolveDisplayName(opponentId, isGuest);

      // Atomic claim of the free seat: if two people open the invite link at the same moment only
      // one of them matches (the previous read-modify-save let the second silently overwrite the first).
      const updatedGame = await ChessGameModel.findOneAndUpdate(
        {
          game_id: gameId,
          'game_state.status': 'waiting_for_opponent',
          [`player_${opponentColor}`]: null,
        },
        {
          $set: {
            [`player_${opponentColor}`]: opponentId,
            [`player_${opponentColor}_is_guest`]: isGuest,
            [`player_${opponentColor}_name`]: opponentName,
            'game_state.status': 'active',
          },
          $inc: { version: 1 },
        },
        { new: true }
      ).lean();

      if (!updatedGame) {
        throw new HttpException(409, 'This game already has an opponent');
      }

      logger.info(`Opponent ${opponentId} registered for game ${gameId} as ${opponentColor}`);
      return updatedGame as unknown as ChessGame;
    } catch (error) {
      logger.error(`Error registering opponent:, ${error}`);
      throw error;
    }
  }

  public async getGameById(gameId: string): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId });
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }
      return game.toJSON();
    } catch (error) {
      logger.error(`Error fetching chess game:, ${error}`);
      throw error;
    }
  }

  public async getActiveGamesForPlayer(playerId: string): Promise<ChessGame[]> {
    try {
      // add user first name
      const games = await ChessGameModel.find({
        $or: [
          { player_white: playerId },
          { player_black: playerId }
        ],
        'game_state.status': { $in: ['waiting_for_opponent', 'active'] }
      }).sort({ updatedAt: -1 });

      return games.map(game => game.toJSON());
    } catch (error) {
      logger.error(`Error fetching active games for player:, ${error}`);
      throw error;
    }
  }

  public async updateGameState(gameId: string, version: number, gameState: GameState, user: User, guest: Guest): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId, version }).lean() as unknown as ChessGame;
      if (!game) {
        throw new HttpException(404, 'Chess game not found or version mismatch');
      }
      if (game.game_state.status !== 'active') {
        throw new HttpException(400, 'Game is not active');
      }

      // Verify the current player is part of this game
      const currentPlayerId = user?._id.toString() || guest?._id.toString();
      const isPlayerWhite = game.player_white?.toString() === currentPlayerId;
      const isPlayerBlack = game.player_black?.toString() === currentPlayerId;
      if (!isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }
      // Verify it's the player's turn (vs-bot games: the client also plays the bot's turn)
      const expectedTurn = game.game_state.turn;
      const playerColor = isPlayerWhite ? 'white' : 'black';
      if (expectedTurn !== playerColor && !game.is_vs_bot) {
        throw new HttpException(400, `It's not your turn. Current turn: ${expectedTurn}`);
      }

      // Everything below is derived server-side; the client's fen/turn/winner/status/moves are
      // only used to identify the move, never trusted as the new state.
      const next = applyClientMove(game, gameState);
      const finished = next.status !== 'active';

      const $set: Record<string, unknown> = {
        'game_state.fen': next.fen,
        'game_state.turn': next.turn,
        'game_state.status': next.status,
        'game_state.moves': next.moves,
        'game_state.current_cards': [],
        'game_state.check_attempts': 0,
      };
      if (finished) {
        $set['game_state.winner'] = next.winner;
        $set['completed_at'] = new Date();
      }

      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId, version }, // must match old version
        { $set, $inc: { version: 1 } },
        { new: true }
      ).lean();

      if (!updatedGame) {
        // If null, another update beat us — version conflict
        throw new HttpException(409, 'Version conflict — please refresh game state');
      }

      logger.debug(`Game ${gameId} state updated by ${currentPlayerId}`);
      return updatedGame as unknown as ChessGame;
    } catch (error) {
      logger.error(`Error updating chess game state:, ${error}`);
      throw error;
    }
  }

  /**
   * Finishes a game whose position is actually over (checkmate / stalemate / draw).
   * The client no longer chooses the winner: it is derived from the stored position, so a player
   * can't declare themselves the winner of a game in progress.
   */
  public async endGame(gameId: string, _claimedWinner: 'white' | 'black' | 'draw', currentPlayerId: string): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId }).lean() as unknown as ChessGame;
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }

      // Verify the current player is part of this game
      const isPlayerWhite = game.player_white?.toString() === currentPlayerId;
      const isPlayerBlack = game.player_black?.toString() === currentPlayerId;
      if (!isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }
      if (game.game_state.status !== 'active') {
        throw new HttpException(400, 'Game is not active');
      }

      const chess = new Chess(game.game_state.fen);
      let winner: 'white' | 'black' | 'draw';
      if (chess.isCheckmate()) {
        // side to move has been checkmated
        winner = chess.turn() === 'w' ? 'black' : 'white';
      } else if (chess.isStalemate() || chess.isDraw()) {
        winner = 'draw';
      } else {
        throw new HttpException(400, 'Game is not over');
      }

      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId, 'game_state.status': 'active' },
        {
          $set: { 'game_state.status': 'completed', 'game_state.winner': winner, completed_at: new Date() },
          $inc: { version: 1 },
        },
        { new: true }
      ).lean();
      if (!updatedGame) {
        throw new HttpException(409, 'Game has already finished');
      }
      logger.info(`Game ${gameId} ended. Winner: ${winner}`);

      return updatedGame as unknown as ChessGame;
    } catch (error) {
      logger.error(`Error ending chess game:, ${error}`);
      throw error;
    }
  }

  /**
   * A player leaving: in an active game that is a forfeit (the opponent wins); a game still
   * waiting for an opponent is simply cancelled.
   */
  public async abandonGame(gameId: string, currentPlayerId: string): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId }).lean() as unknown as ChessGame;
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }

      // Verify the current player is part of this game
      const isPlayerWhite = game.player_white?.toString() === currentPlayerId;
      const isPlayerBlack = game.player_black?.toString() === currentPlayerId;
      if (!isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }
      const status = game.game_state.status;
      if (status !== 'active' && status !== 'waiting_for_opponent') {
        throw new HttpException(400, 'Game is already finished');
      }

      const $set: Record<string, unknown> = { 'game_state.status': 'abandoned', completed_at: new Date() };
      if (status === 'active' && !game.is_vs_bot) {
        $set['game_state.winner'] = isPlayerWhite ? 'black' : 'white';
      }

      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId, 'game_state.status': status },
        { $set, $inc: { version: 1 } },
        { new: true }
      ).lean();
      if (!updatedGame) {
        throw new HttpException(409, 'Game has already finished');
      }
      logger.info(`Game ${gameId} abandoned by ${currentPlayerId}`);

      return updatedGame as unknown as ChessGame;
    } catch (error) {
      logger.error(`Error abandoning chess game:, ${error}`);
      throw error;
    }
  }

  public async getGameHistory(playerId: string, limit: number = 10): Promise<ChessGame[]> {
    try {
      const games = await ChessGameModel.find({
        $or: [
          { player_white: playerId },
          { player_black: playerId }
        ],
        'game_state.status': { $in: ['completed', 'abandoned'] }
      })
        .sort({ completed_at: -1, updatedAt: -1 })
        .limit(limit);

      return games.map(game => game.toJSON());
    } catch (error) {
      logger.error(`Error fetching game history:, ${error}`);
      throw error;
    }
  }
}