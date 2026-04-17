import Container, { Service } from 'typedi';
import { ChessGame, GameState, PlayingCard } from '@/interfaces/chessgame.interface';
import { ChessGameModel } from '@/models/chess_games.model';
import { HttpException } from '@/exceptions/HttpException';
import { logger } from '@/utils/logger';
import mongoose from 'mongoose';
import { TextEncoder } from 'util';
import { Guest } from '@/interfaces/guest.interface';
import { GuestModel } from '@/models/guest.model';
import { v4 as uuidv4 } from 'uuid';
import { UserModel } from '@/models/user.model';
import { User } from '@/interfaces/users.interface';
import { generateGuestName } from '@/utils/guestNames';
import { UserProfileModel } from '@/models/user_profile.model';

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
      logger.error('Error creating guest session:', error);
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
      logger.error('Error resolving display name:', err);
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
      logger.error('Error creating chess game:', error);
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
      logger.error('Error creating matchmade game:', error);
      throw error;
    }
  }

  /**
   * Draws N cards from the deck for the current player.
   * The deck and current_cards are updated atomically in the DB.
   */
  public async drawCards(gameId: string, count?: number, user?: User, guest?: Guest): Promise<ChessGame> {
    try {
      const gameModel = await ChessGameModel.findOne({ game_id: gameId });
      if (!gameModel) {
        throw new HttpException(404, 'Chess game not found');
      }

      const game = gameModel.toJSON();

      if (game.game_state.status !== 'active') {
        throw new HttpException(400, 'Game is not active');
      }

      // Verify the requester is a player
      const playerId = user?._id?.toString() || guest?._id?.toString();
      const isPlayerWhite = game.player_white?.toString() === playerId;
      const isPlayerBlack = game.player_black?.toString() === playerId;
      if (!game.is_vs_bot && !isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }

      // Verify it's this player's turn
      const playerColor = isPlayerWhite ? 'white' : 'black';
      if (!game.is_vs_bot && game.game_state.turn !== playerColor) {
        throw new HttpException(400, `It's not your turn. Current turn: ${game.game_state.turn}`);
      }

      const deck: DeckCard[] = [...(game.game_state.cards_deck as DeckCard[] || [])];
      // Use explicit count or fall back to the game's configured cards_to_draw
      const drawCount = count ?? game.cards_to_draw;

      // If deck is running low, append a new shuffled deck
      if (deck.length < drawCount + 5) {
        const refill = createShuffledDeck();
        deck.push(...refill);
        logger.info(`Deck refilled for game ${gameId}`);
      }

      if (deck.length < drawCount) {
        throw new HttpException(400, 'Not enough cards in deck');
      }

      // Pop drawCount cards from the end of the deck
      const drawnCards = deck.splice(deck.length - drawCount, drawCount);

      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId },
        {
          $set: {
            'game_state.current_cards': drawnCards,
            'game_state.cards_deck': deck,
          },
          $inc: { version: 1 },
        },
        { new: true }
      );

      if (!updatedGame) {
        throw new HttpException(409, 'Failed to draw cards — please try again');
      }

      logger.info(`Drew ${count} cards for game ${gameId} by player ${playerId}`);
      return updatedGame.toJSON();
    } catch (error) {
      logger.error('Error drawing cards:', error);
      throw error;
    }
  }

  private async checkIfCanRegister(game: ChessGame, user?: User, guest?: Guest): Promise<boolean> {
    const isGameOfUser = (await UserModel.findOne({
      $or: [
        { _id: game.player_white },
        { _id: game.player_black }
      ]
    })) ? true : false;
    return (user && isGameOfUser) || (guest && true);
  }

  public async registerOpponent(gameId: string, user?: User, guest?: Guest): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId });
      if (!game || (!user && !guest) || !await this.checkIfCanRegister(game, user, guest)) {
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

      if (opponentColor === 'white') {
        game.player_white = opponentId;
        game.player_white_is_guest = isGuest;
        game.player_white_name = opponentName;
      } else {
        game.player_black = opponentId;
        game.player_black_is_guest = isGuest;
        game.player_black_name = opponentName;
      }

      // Update game state to active
      game.game_state.status = 'active';
      game.markModified('game_state');

      const updatedGame = await game.save();
      logger.info(`Opponent ${opponentId} registered for game ${gameId} as ${opponentColor}`);

      return updatedGame.toJSON();
    } catch (error) {
      logger.error('Error registering opponent:', error);
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
      logger.error('Error fetching chess game:', error);
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
      logger.error('Error fetching active games for player:', error);
      throw error;
    }
  }

  public async updateGameState(gameId: string, version: number, gameState: GameState, user: User, guest: Guest): Promise<ChessGame> {
    try {
      const gameModel = await ChessGameModel.findOne({ game_id: gameId, version });
      if (!gameModel) {
        throw new HttpException(404, 'Chess game not found or version mismatch');
      }
      const game = gameModel.toJSON();
      if (game.game_state.status !== 'active') {
        throw new HttpException(400, 'Game is not active');
      }

      // Verify the current player is part of this game
      const currentPlayerId = user?._id.toString() || guest?._id.toString();
      const isPlayerWhite = game.player_white?.toString() === currentPlayerId;
      const isPlayerBlack = game.player_black?.toString() === currentPlayerId;
      const isAnyPlayer = game.player_white?.toString() === currentPlayerId || game.player_black?.toString() === currentPlayerId;
      if (!game.is_vs_bot && !isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }
      if (game.is_vs_bot && !isAnyPlayer) {
        throw new HttpException(403, 'You are not a player in this game');
      }
      // Verify it's the player's turn
      const expectedTurn = game.game_state.turn;
      const playerColor = isPlayerWhite ? 'white' : 'black';
      if (expectedTurn !== playerColor && !game.is_vs_bot) {
        throw new HttpException(400, `It's not your turn. Current turn: ${expectedTurn}`);
      }

      // Strip cards_deck from incoming state — deck is managed solely by draw_card events
      const { cards_deck: _ignored, ...sanitizedState } = gameState as GameState & { cards_deck?: unknown };

      // Perform atomic update with version increment
      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId, version }, // must match old version
        {
          $set: { game_state: { ...game.game_state, ...sanitizedState } },
          $inc: { version: 1 }, // increment version
        },
        { new: true }
      );

      if (!updatedGame) {
        // If null, another update beat us — version conflict
        throw new HttpException(409, 'Version conflict — please refresh game state');
      }

      logger.info(`Game ${gameId} state updated by ${currentPlayerId}`);
      return updatedGame.toJSON();
    } catch (error) {
      logger.error('Error updating chess game state:', error);
      throw error;
    }
  }

  public async endGame(gameId: string, winner: 'white' | 'black' | 'draw', currentPlayerId: string): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId });
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }

      // Verify the current player is part of this game
      const isPlayerWhite = game.player_white?.toString() === currentPlayerId;
      const isPlayerBlack = game.player_black?.toString() === currentPlayerId;

      if (!isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }

      // Update game state to completed
      game.game_state.status = 'completed';
      game.game_state.winner = winner;
      game.completed_at = new Date();
      game.markModified('game_state');

      const updatedGame = await game.save();
      logger.info(`Game ${gameId} ended. Winner: ${winner}`);

      return updatedGame.toJSON();
    } catch (error) {
      logger.error('Error ending chess game:', error);
      throw error;
    }
  }

  public async abandonGame(gameId: string, currentPlayerId: string): Promise<ChessGame> {
    try {
      const game = await ChessGameModel.findOne({ game_id: gameId });
      if (!game) {
        throw new HttpException(404, 'Chess game not found');
      }

      // Verify the current player is part of this game
      const isPlayerWhite = game.player_white?.toString() === currentPlayerId;
      const isPlayerBlack = game.player_black?.toString() === currentPlayerId;

      if (!isPlayerWhite && !isPlayerBlack) {
        throw new HttpException(403, 'You are not a player in this game');
      }

      // Update game state to abandoned
      game.game_state.status = 'abandoned';
      game.completed_at = new Date();
      game.markModified('game_state');

      const updatedGame = await game.save();
      logger.info(`Game ${gameId} abandoned by ${currentPlayerId}`);

      return updatedGame.toJSON();
    } catch (error) {
      logger.error('Error abandoning chess game:', error);
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
        .sort({ completed_at: -1 })
        .limit(limit);

      return games.map(game => game.toJSON());
    } catch (error) {
      logger.error('Error fetching game history:', error);
      throw error;
    }
  }
}