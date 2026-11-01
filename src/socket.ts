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
import { env } from "./env";
import { toClientGame } from "./utils/chessGame";
import { enqueuePlayer, dequeueByPlayerId, dequeueIfSocket, botDelayMs } from "./utils/matchmaking";
import { queueClient } from "./jobs/connection";
import { broadcastMatchmakingCount, getDisplayedQueueCount, triggerMatchmaking, MATCHMAKING_LOBBY_ROOM } from "./services/matchmaking.service";
import { botsEnabled } from "./services/bot.service";

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
      logger.error(`WebSocket connection failed: No valid session for socket ${socket.id}`);
      return next(new Error("Authentication failed"));
    }

    next();
  } catch (err) {
    logger.error(`WebSocket connection failed: Socket authentication error for socket ${socket.id}:`, err);
    next(new Error("Authentication failed"));
  }
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

  io.engine.on("connection_error", (err) => {
    logger.error(`WebSocket connection failed: ${err.message}`, {
      code: err.code,
      message: err.message,
      context: err.context,
    });
  });

  const pubClient = new createClient(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const subClient = pubClient.duplicate();

  await pubClient.connect();
  await subClient.connect();

  io.adapter(createAdapter(pubClient, subClient, {
    key: "backend_socket.io-redis-adapter",
  }));

  logger.info("Redis adapter initialized for Socket.IO");

  io.on("connection", (socket: Socket) => {
    const user: User = socket.data.user;
    const guest: Guest = socket.data.guest;
    const playerId = user?._id?.toString() || guest?._id?.toString();

    logger.debug(`Socket connected: ${socket.id}`, user ? `User:${user._id}` : `Guest:${guest?._id} process PID:${process.pid}`);

    // ── Join a game ────────────────────────────────────────────────────────
    socket.on("join_game", async (_game: { gameId: string }) => {
      try {
        const gameId = _game.gameId;
        // Only ids + status are needed here, not the whole game (deck, move history)
        const game = await chessService.getGameParticipants(gameId);
        const userId = user?._id?.toString();
        const guestId = guest?._id?.toString();

        const isPlayer =
          (!!userId && (game.player_white === userId || game.player_black === userId)) ||
          (!!guestId && (game.player_white === guestId || game.player_black === guestId));

        if (!isPlayer && game.status !== "waiting_for_opponent") {
          socket.emit("error", { message: "You are not part of this game" });
          return socket.disconnect();
        }

        socket.join(`game:${gameId}`);
        socket.emit("joined_game", { gameId });
        logger.debug(`Socket ${socket.id} joined game:${gameId}`);
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
          data: toClientGame(updatedGame),
        });
        logger.debug(`Game state updated via socket for game:${gameId}`);
      } catch (err) {
        logger.error("update_game_state error:", err);
        socket.emit("error", { message: (err as Error).message || "Failed to update game state", gameId: payload?.gameId });
      }
    });

    socket.on("draw_card", async (payload: { gameId: string }) => {
      try {
        const { gameId } = payload;
        const updatedGame = await chessService.drawCards(gameId, user, guest);
        io.to(`game:${gameId}`).emit("game_updated", {
          gameId,
          data: toClientGame(updatedGame),
        });
        logger.debug(`Cards drawn via socket for game:${gameId}`);
      } catch (err) {
        logger.error("draw_card error:", err);
        socket.emit("error", { message: (err as Error).message || "Failed to draw cards", gameId: payload?.gameId });
      }
    });

    // The web client sends { gameId }, older callers may send the bare id; accept both.
    socket.on("leave_game", (payload: string | { gameId: string }) => {
      const gameId = typeof payload === "string" ? payload : payload?.gameId;
      if (!gameId) return;
      socket.leave(`game:${gameId}`);
      logger.debug(`Socket ${socket.id} left game:${gameId}`);
    });

    socket.on("join_matchmaking", async () => {
      try {
        if (!playerId) {
          socket.emit("error", { message: "Not authenticated" });
          return;
        }

        const isGuest = !user && !!guest;

        socket.join(MATCHMAKING_LOBBY_ROOM);
        await enqueuePlayer(queueClient, {
          playerId,
          socketId: socket.id,
          joinedAt: Date.now(),
          isGuest
        });

        logger.info(`Player ${playerId} joined matchmaking queue`);
        broadcastMatchmakingCount(io);

        // Notify the user they are in the queue (before any match so events arrive in order).
        socket.emit("matchmaking_queued", { message: "Waiting for an opponent..." });

        // Try to match right away. The periodic sweep in jobs/matchmaking.worker.ts remains
        // as a fallback (queue timeouts, or another process holding the matchmaking lock).
        void triggerMatchmaking(io, chessService);

        // If nobody else shows up, run again once this player's grace period is over so a bot is
        // assigned on time (the 2s sweep in jobs/ covers a process restart in between).
        if (botsEnabled()) {
          setTimeout(() => void triggerMatchmaking(io, chessService), botDelayMs(playerId) + 100).unref();
        }
      } catch (err) {
        logger.error("join_matchmaking error:", err);
        socket.emit("error", { message: "Failed to join matchmaking" });
      }
    });

    // ── Leave matchmaking queue ────────────────────────────────────────────
    socket.on("leave_matchmaking", async () => {
      try {
        if (!playerId) return;
        const removed = await dequeueByPlayerId(queueClient, playerId);
        socket.emit("matchmaking_cancelled", {});
        if (removed) broadcastMatchmakingCount(io);
        logger.info(`Player ${playerId} left matchmaking queue`);
      } catch (err) {
        logger.error("leave_matchmaking error:", err);
      }
    });

    // ── Get current matchmaking count ─────────────────────────────────────
    socket.on("get_matchmaking_count", async () => {
      try {
        socket.join(MATCHMAKING_LOBBY_ROOM); // subscribe to later count updates
        const count = await getDisplayedQueueCount();
        socket.emit("matchmaking_count", { count });
      } catch (err) {
        logger.error("get_matchmaking_count error:", err);
      }
    });

    // ── Disconnect ─────────────────────────────────────────────────────────
    socket.on("disconnect", async (reason) => {
      logger.debug(`Socket ${socket.id} disconnected:`, reason);
      if (!playerId) return;
      try {
        // Only remove the queue entry if it belongs to *this* socket: the same player may have
        // re-joined from a new tab/connection, and that entry must survive the old socket closing.
        // Only broadcast when something actually changed (most disconnects aren't in the queue).
        const removed = await dequeueIfSocket(queueClient, playerId, socket.id);
        if (removed) broadcastMatchmakingCount(io);
      } catch (err) {
        logger.error("disconnect cleanup error:", err);
      }
    });
  });

  return io;
};