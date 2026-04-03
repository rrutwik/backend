import Container, { Service } from 'typedi';
import { ChessGame, GameState } from '@/interfaces/chessgame.interface';
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

@Service()
export class ChessService {

  public async createGuestSession(metadata: Record<string, any>): Promise<Guest> {
    try {
      const guestSession = await GuestModel.create({
        session_uuid: uuidv4(),
        metadata,
      });
      logger.info(`Guest session created: ${guestSession.session_uuid}`);
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

  public async createGame(playerId: string, playerColor: 'white' | 'black', isVsBot: boolean = false, cardsToDraw: number = 1): Promise<ChessGame> {
    try {
      if (!playerId) {
        throw new HttpException(400, 'Player ID is required to create a game');
      }
      const game = await ChessGameModel.create({
        game_id: await this.createUniqueGameId(playerId),
        player_white: playerColor === 'white' ? playerId : null,
        player_black: playerColor === 'black' ? playerId : null,
        is_vs_bot: isVsBot,
        cards_to_draw: cardsToDraw,
        game_state: {
          fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          turn: 'white',
          status: isVsBot ? 'active' : 'waiting_for_opponent',
          moves: []
        }
      });

      logger.info(`Chess game created: ${game.game_id} by ${playerId} as ${playerColor}`);
      return game.toJSON();
    } catch (error) {
      logger.error('Error creating chess game:', error);
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

      // Check if opponent already has an active game with this player
      // const existingGame = await ChessGameModel.findOne({
      //   $or: [
      //     { player_white: creatorId, player_black: opponentId },
      //     { player_white: opponentId, player_black: creatorId }
      //   ],
      //   'game_state.status': { $in: ['waiting_for_opponent', 'active'] }
      // });

      // if (existingGame) {
      //   throw new HttpException(400, 'Active game already exists between these players');
      // }

      // Determine opponent color and update game
      const creatorColor = game.player_white ? 'white' : 'black';
      const opponentColor = creatorColor === 'white' ? 'black' : 'white';

      if (opponentColor === 'white') {
        game.player_white = opponentId;
      } else {
        game.player_black = opponentId;
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
      // Perform atomic update with version increment
      const updatedGame = await ChessGameModel.findOneAndUpdate(
        { game_id: gameId, version }, // must match old version
        {
          $set: { game_state: { ...game.game_state, ...gameState } },
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