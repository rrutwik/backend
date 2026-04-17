import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { ChessService } from "@services/chess.service";
import { AuthMiddleware, GuestMiddleware } from "@middlewares/auth.middleware";
import { Response } from "express";
import { RequestWithGuest, RequestWithUser } from "@interfaces/auth.interface";
import { createAdapter } from "@socket.io/redis-adapter";
import createClient, { Redis } from "ioredis";
import { User } from "./interfaces/users.interface";
import { Guest } from "./interfaces/guest.interface";
import { GameState } from "./interfaces/chessgame.interface";
import { logger } from "./utils/logger";
import { UserProfileModel } from "./models/user_profile.model";
import { enqueuePlayer, dequeueByPlayerId, getQueueCount } from "./utils/matchmaking";
import { queueClient } from "./jobs/connection";

declare module "socket.io" {
  interface SocketData {
    user?: User;
    guest?: Guest;
  }
}

export const socketAuthAdapter = async (socket: Socket, next: (err?: Error) => void) => {

  const req = {
    headers: socket.handshake.auth || {},
  } as RequestWithUser & RequestWithGuest;
  const res = {} as Response;

  try {
    // First run GuestMiddleware
    await new Promise<void>((resolve, reject) => {
      GuestMiddleware(req, res, (err?: unknown) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // Then run AuthMiddleware (skips if guest is present)
    await new Promise<void>((resolve, reject) => {
      AuthMiddleware(req, res, (err?: unknown) => {
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

const broadcastMatchmakingCount = async (io: Server) => {
  const count = await getQueueCount(queueClient);
  io.emit("matchmaking_count", { count });
};

// ─── Socket Server ────────────────────────────────────────────────────────────

export const initSocket = async (server: HttpServer, chessService: ChessService) => {
  const io = new Server(server, {
    cors: {
      origin: process.env.ORIGINS?.split(",") || "*",
      credentials: true,
    },
  });

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
    const user: User = socket.data.user;
    const guest: Guest = socket.data.guest;
    const playerId = user?._id?.toString() || guest?._id?.toString();

    logger.info(`Socket connected: ${socket.id}`, user ? `User:${user._id}` : `Guest:${guest?._id}`);

    // ── Join a game ────────────────────────────────────────────────────────
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

    // ── Update game state ──────────────────────────────────────────────────
    socket.on("update_game_state", async (payload: { gameId: string; version: number; game_state: GameState }) => {
      try {
        const { gameId, version, game_state } = payload;
        const updatedGame = await chessService.updateGameState(gameId, version, game_state, user, guest);
        io.to(`game:${gameId}`).emit("game_updated", {
          gameId,
          data: updatedGame,
        });
        logger.info(`Game state updated via socket for game:${gameId}`);
      } catch (err) {
        logger.error("update_game_state error:", err);
        socket.emit("error", { message: "Failed to update game state" });
      }
    });

    socket.on("draw_card", async (payload: { gameId: string }) => {
      try {
        const { gameId } = payload;
        const updatedGame = await chessService.drawCards(gameId, user, guest);
        io.to(`game:${gameId}`).emit("game_updated", {
          gameId,
          data: updatedGame,
        });
        logger.info(`Cards drawn via socket for game:${gameId}`);
      } catch (err) {
        logger.error("draw_card error:", err);
        socket.emit("error", { message: (err as Error).message || "Failed to draw cards" });
      }
    });

    socket.on("leave_game", (gameId: string) => {
      socket.leave(`game:${gameId}`);
      logger.info(`Socket ${socket.id} left game:${gameId}`);
    });

    socket.on("join_matchmaking", async () => {
      try {
        if (!playerId) {
          socket.emit("error", { message: "Not authenticated" });
          return;
        }

        const isGuest = !user && !!guest;
        let displayName = '';
        if (user) {
          const userProfile = await UserProfileModel.findOne({ user_id: playerId });
          displayName = userProfile?.first_name + ' ' + userProfile?.last_name;
        } else if (guest) {
          displayName = guest.display_name;
        }
        displayName = displayName || `Player_${playerId.slice(-6)}`;

        await enqueuePlayer(queueClient, {
          playerId,
          socketId: socket.id,
          joinedAt: Date.now(),
          isGuest
        });

        logger.info(`Player ${playerId} joined matchmaking queue`);
        await broadcastMatchmakingCount(io);


        // Notify the user they are in the queue.
        // Actual matching happens in the 5-second cron loop.
        socket.emit("matchmaking_queued", { message: "Waiting for an opponent..." });
      } catch (err) {
        logger.error("join_matchmaking error:", err);
        socket.emit("error", { message: "Failed to join matchmaking" });
      }
    });

    // ── Leave matchmaking queue ────────────────────────────────────────────
    socket.on("leave_matchmaking", async () => {
      try {
        if (!playerId) return;
        await dequeueByPlayerId(queueClient, playerId);
        socket.emit("matchmaking_cancelled", {});
        await broadcastMatchmakingCount(io);
        logger.info(`Player ${playerId} left matchmaking queue`);
      } catch (err) {
        logger.error("leave_matchmaking error:", err);
      }
    });

    // ── Get current matchmaking count ─────────────────────────────────────
    socket.on("get_matchmaking_count", async () => {
      try {
        const count = await getQueueCount(queueClient);
        socket.emit("matchmaking_count", { count });
      } catch (err) {
        logger.error("get_matchmaking_count error:", err);
      }
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on("disconnect", async (reason) => {
      logger.info(`Socket ${socket.id} disconnected:`, reason);
      if (playerId) {
        await dequeueByPlayerId(queueClient, playerId);
        await broadcastMatchmakingCount(io);
      }
    });
  });

  return io;
};