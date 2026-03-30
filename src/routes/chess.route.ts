import { Router } from 'express';
import { ChessController } from '@/controllers/chess.controller';
import { Routes } from '@interfaces/routes.interface';
import { AuthMiddleware, GuestMiddleware } from '@/middlewares/auth.middleware';

export class ChessRoute implements Routes {
  public path = '/chess/';
  public router = Router();
  public chess = new ChessController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.post(`/guest-session`, this.chess.createGuestSession);
  
    this.router.post(`${this.path}create`, GuestMiddleware, AuthMiddleware, this.chess.createGame);

    this.router.put(`${this.path}game/:gameId/join`, GuestMiddleware, AuthMiddleware, this.chess.registerOpponent);

    this.router.get(`${this.path}game/:gameId`, GuestMiddleware, AuthMiddleware, this.chess.getGame);

    this.router.get(`${this.path}active`, AuthMiddleware, this.chess.getActiveGames);

    this.router.put(`${this.path}game/:gameId/state`, GuestMiddleware, AuthMiddleware, this.chess.updateGameState);

    this.router.put(`${this.path}game/:gameId/end`, AuthMiddleware, this.chess.endGame);

    this.router.put(`${this.path}game/:gameId/abandon`, AuthMiddleware, this.chess.abandonGame);

    this.router.get(`${this.path}history`, AuthMiddleware, this.chess.getGameHistory);
  }
}
