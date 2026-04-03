import { NextFunction, Response } from 'express';
import { RequestWithUser } from '@/interfaces/auth.interface';
import { ChessService } from '@/services/chess.service';
import { Container } from 'typedi';
import { logger } from '@/utils/logger';
import { GameState } from '@/interfaces/chessgame.interface';
import { Guest } from '@/interfaces/guest.interface';
import { Socket } from 'socket.io';

export class ChessController {
  private chessService = Container.get(ChessService);

  public createGuestSession = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const metadata = {
        ip: req.ip,
        ips: req.ips || [],
        userAgent: req.get('User-Agent') || 'unknown',
        referer: req.get('Referer') || null,
        origin: req.get('Origin') || null,
        acceptLanguage: req.get('Accept-Language') || null,
        ...req.body
      };
      const guestSession = await this.chessService.createGuestSession(metadata);

      return res.status(200).json({
        message: 'Guest session created successfully',
        _id: guestSession._id,
        token: guestSession.session_uuid
      });
    } catch (error) {
      logger.error('Error creating guest session:', error);
      next(error);
    }
  }

  public createGame = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const guest: Guest = req.guest;
      const { color } = req.body;

      if (!user && !guest) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      if (!color || !['white', 'black'].includes(color)) {
        return res.status(400).json({ message: 'Valid color is required (white or black)' });
      }
      const isVsBot = req.body.is_vs_bot === true;
      const cardsToDraw = req.body.cards_to_draw || 1;
      logger.info(`isVsBot: ${isVsBot} typof isVsBot: ${typeof isVsBot}`);
      const game = await this.chessService.createGame(user?._id ? user._id.toString() : guest._id.toString(), color, isVsBot, cardsToDraw);

      return res.status(201).json({
        message: 'Chess game created successfully',
        data: game
      });
    } catch (error) {
      logger.error('Error creating chess game:', error);
      next(error);
    }
  };

  public registerOpponent = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const guest: Guest = req.guest;
      const { gameId } = req.params;

      if (!user && !guest) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      if (!gameId) {
        return res.status(400).json({ message: 'Game ID is required' });
      }

      const game = await this.chessService.registerOpponent(gameId, user, guest);
      const io = req.app.get("io") as Socket;
      io.to(`game:${gameId}`).emit("game_updated", {
        gameId,
        data: game,
      });
      return res.status(200).json({
        message: 'Successfully registered as opponent',
        data: game
      });
    } catch (error) {
      logger.error('Error registering opponent:', error);
      next(error);
    }
  };

  public getGame = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const guest: Guest = req.guest;
      const { gameId } = req.params;

      if (!user && !guest) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      if (!gameId) {
        return res.status(400).json({ message: 'Game ID is required' });
      }

      const game = await this.chessService.getGameById(gameId);

      // Verify the user is part of this game
      const isPlayer = game.player_white?.toString() === user?._id.toString() || game.player_black?.toString() === user?._id.toString() || (guest && (game.player_white?.toString() === guest?._id.toString() || game.player_black?.toString() === guest?._id.toString()));
      const status = game.game_state.status;
  
      if (!isPlayer && status !== 'waiting_for_opponent') {
        return res.status(403).json({ message: 'You are not a player in this game' });
      }
  
      console.log('Game retrieved successfully');
      return res.status(200).json({
        message: 'Game retrieved successfully',
        data: game
      });
    } catch (error) {
      logger.error('Error getting chess game:', error);
      next(error);
    }
  };

  public getActiveGames = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;

      if (!user) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      const games = await this.chessService.getActiveGamesForPlayer(user._id.toString());

      return res.status(200).json({
        message: 'Active games retrieved successfully',
        data: games
      });
    } catch (error) {
      logger.error('Error getting active games:', error);
      next(error);
    }
  };

  public updateGameState = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const guest: Guest = req.guest;
    
      const { gameId } = req.params;
      const { game_state: gameState, version } = req.body as { game_state: GameState; version: number };

      if (!user && !guest) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      if (!gameId) {
        return res.status(400).json({ message: 'Game ID is required' });
      }

      if (!gameState) {
        return res.status(400).json({ message: 'Game state is required' });
      }

      const updatedGame = await this.chessService.updateGameState(gameId, version, gameState, user, guest);
      const io = req.app.get("io") as Socket;
      io.to(`game:${gameId}`).emit("game_updated", {
        gameId,
        data: updatedGame,
      });

      return res.status(200).json({
        message: 'Game state updated successfully',
        data: updatedGame
      });
    } catch (error) {
      logger.error('Error updating game state:', error);
      next(error);
    }
  };

  public endGame = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const { gameId } = req.params;
      const { winner } = req.body;

      if (!user) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      if (!gameId) {
        return res.status(400).json({ message: 'Game ID is required' });
      }

      if (!winner || !['white', 'black', 'draw'].includes(winner)) {
        return res.status(400).json({ message: 'Valid winner is required (white, black, or draw)' });
      }

      const updatedGame = await this.chessService.endGame(gameId, winner, user._id.toString());

      return res.status(200).json({
        message: 'Game ended successfully',
        data: updatedGame
      });
    } catch (error) {
      logger.error('Error ending game:', error);
      next(error);
    }
  };

  public abandonGame = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const { gameId } = req.params;

      if (!user) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      if (!gameId) {
        return res.status(400).json({ message: 'Game ID is required' });
      }

      const updatedGame = await this.chessService.abandonGame(gameId, user._id.toString());

      return res.status(200).json({
        message: 'Game abandoned successfully',
        data: updatedGame
      });
    } catch (error) {
      logger.error('Error abandoning game:', error);
      next(error);
    }
  };

  public getGameHistory = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: any = req.user;
      const { limit = 10 } = req.query;

      if (!user) {
        return res.status(401).json({ message: 'User not authenticated' });
      }

      const games = await this.chessService.getGameHistory(user._id.toString(), Number(limit));

      return res.status(200).json({
        message: 'Game history retrieved successfully',
        data: games
      });
    } catch (error) {
      logger.error('Error getting game history:', error);
      next(error);
    }
  };
}
