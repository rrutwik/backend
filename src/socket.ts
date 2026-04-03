import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { ChessService } from "@services/chess.service";
import { AuthMiddleware, GuestMiddleware } from "@middlewares/auth.middleware";
import { Request, Response } from "express";
import { RequestWithGuest, RequestWithUser } from "@interfaces/auth.interface";
import { createAdapter } from "@socket.io/redis-adapter";
import createClient from "ioredis";
import { User } from "./interfaces/users.interface";
import { Guest } from "./interfaces/guest.interface";
import { logger } from "./utils/logger";

declare module "socket.io" {
  interface SocketData {
    user?: User;
    guest?: Guest;
  }
}

export const socketAuthAdapter = async (socket: Socket, next: (err?: any) => void) => {

  const req = {
    headers: socket.handshake.auth || {},
  } as RequestWithUser & RequestWithGuest;
  const res = {} as Response;

  try {
    // First run GuestMiddleware
    await new Promise<void>((resolve, reject) => {
      GuestMiddleware(req, res, (err?: any) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // Then run AuthMiddleware (skips if guest is present)
    await new Promise<void>((resolve, reject) => {
      AuthMiddleware(req, res, (err?: any) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // Attach to socket.data
    if (req.user) socket.data.user = req.user;
    if (req.guest) socket.data.guest = req.guest;

    if (!req.user && !req.guest) {
      return next(new Error("Authentication failed"));
    }

    next();
  } catch (err) {
    logger.error("Socket authentication error:", err);
    next(new Error("Authentication failed"));
  }
};

export const initSocket = async (server: HttpServer, chessService: ChessService) => {
  const io = new Server(server, {
    cors: {
      origin: process.env.ORIGINS?.split(",") || "*",
      credentials: true,
    },
  });

  // Apply combined auth adapter
  io.use(socketAuthAdapter);

  const pubClient = new createClient({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      db: 12,
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const subClient = pubClient.duplicate();

    await pubClient.connect();
    await subClient.connect();

    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Redis adapter initialized for Socket.IO");

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user;
    const guest = socket.data.guest;

    console.log(`Socket connected: ${socket.id}`, user ? `User:${user._id}` : `Guest:${guest?._id}`);

    // Join a game
    socket.on("join_game", async (_game: { gameId: string }) => {
      try {
        const gameId = _game.gameId;
        const game = await chessService.getGameById(gameId);
        const userId = user?._id;
        const guestId = guest?._id;

        const isPlayer =
          game.player_white?.toString() === userId?.toString() ||
          game.player_black?.toString() === userId?.toString() ||
          game.player_white?.toString() === guestId?.toString() ||
          game.player_black?.toString() === guestId?.toString();

        if (!isPlayer && game.game_state.status !== "waiting_for_opponent") {
          socket.emit("error", { message: "You are not part of this game" });
          return socket.disconnect();
        }

        socket.join(`game:${gameId}`);
        socket.emit("joined_game", { gameId });
        logger.info(`Socket ${socket.id} joined game:${gameId}`);
      } catch (err) {
        logger.error("join_game error:", err);
        socket.emit("error", { message: "Failed to join game" });
        socket.disconnect();
      }
    });

    // Leave a game
    socket.on("leave_game", (gameId: string) => {
      socket.leave(`game:${gameId}`);
      logger.info(`Socket ${socket.id} left game:${gameId}`);
    });

    // Disconnect
    socket.on("disconnect", (reason) => {
      logger.info(`Socket ${socket.id} disconnected:`, reason);
    });
  });

  return io;
};