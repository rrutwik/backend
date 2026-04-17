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

const QUEUE_KEY = "matchmaking:queue";
const MATCHMAKING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface QueueEntry {
  playerId: string;
  socketId: string;
  joinedAt: number;
  isGuest: boolean;
  displayName: string;
}

async function enqueuePlayer(redis: Redis, entry: QueueEntry): Promise<void> {
  // Remove existing entry for this player (de-dupe)
  const raw = await redis.lrange(QUEUE_KEY, 0, -1);
  for (const item of raw) {
    const parsed = JSON.parse(item) as QueueEntry;
    if (parsed.playerId === entry.playerId) {
      await redis.lrem(QUEUE_KEY, 0, item);
    }
  }
  await redis.rpush(QUEUE_KEY, JSON.stringify(entry));
  await redis.expire(QUEUE_KEY, 600);
}

async function dequeueByPlayerId(redis: Redis, playerId: string): Promise<void> {
  const raw = await redis.lrange(QUEUE_KEY, 0, -1);
  for (const item of raw) {
    const parsed = JSON.parse(item) as QueueEntry;
    if (parsed.playerId === playerId) {
      await redis.lrem(QUEUE_KEY, 0, item);
    }
  }
}

async function popTwoPlayers(redis: Redis): Promise<[QueueEntry, QueueEntry] | null> {
  const item1 = await redis.lpop(QUEUE_KEY);
  if (!item1) return null;
  const item2 = await redis.lpop(QUEUE_KEY);
  if (!item2) {
    await redis.lpush(QUEUE_KEY, item1);
    return null;
  }
  return [JSON.parse(item1) as QueueEntry, JSON.parse(item2) as QueueEntry];
}

async function getQueueCount(redis: Redis): Promise<number> {
  return redis.llen(QUEUE_KEY);
}

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

  // Dedicated Redis db for matchmaking queue (db 13 to avoid collision)
  const queueClient = new createClient({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT || 6379),
    db: 13,
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  await pubClient.connect();
  await subClient.connect();
  await queueClient.connect();

  io.adapter(createAdapter(pubClient, subClient));
  logger.info("Redis adapter initialized for Socket.IO");

  // Per-socket timeout handles for 5-min matchmaking auto-cancel
  const matchmakingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  const broadcastMatchmakingCount = async () => {
    const count = await getQueueCount(queueClient);
    io.emit("matchmaking_count", { count });
  };

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user;
    const guest = socket.data.guest;
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
        const updatedGame = await chessService.drawCards(gameId, undefined, user, guest);
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
        const displayName = user?.username || user?.email || guest?.display_name || `Player_${playerId.slice(-6)}`;

        await enqueuePlayer(queueClient, {
          playerId,
          socketId: socket.id,
          joinedAt: Date.now(),
          isGuest,
          displayName,
        });

        logger.info(`Player ${playerId} joined matchmaking queue`);
        await broadcastMatchmakingCount();

        const existingTimeout = matchmakingTimeouts.get(playerId);
        if (existingTimeout) clearTimeout(existingTimeout);

        const timeout = setTimeout(async () => {
          await dequeueByPlayerId(queueClient, playerId);
          socket.emit("matchmaking_timeout", { message: "No opponent found. Please try again." });
          await broadcastMatchmakingCount();
          matchmakingTimeouts.delete(playerId);
          logger.info(`Matchmaking timeout for player ${playerId}`);
        }, MATCHMAKING_TIMEOUT_MS);

        matchmakingTimeouts.set(playerId, timeout);

        // Try to match
        const pair = await popTwoPlayers(queueClient);
        if (!pair) {
          socket.emit("matchmaking_queued", { message: "Waiting for an opponent..." });
          return;
        }

        const [entry1, entry2] = pair;

        // Clear timeouts for both matched players
        for (const e of [entry1, entry2]) {
          const t = matchmakingTimeouts.get(e.playerId);
          if (t) { clearTimeout(t); matchmakingTimeouts.delete(e.playerId); }
        }

        const game = await chessService.createMatchmadeGame(
          entry1.playerId,
          entry2.playerId,
          { isGuest: entry1.isGuest, displayName: entry1.displayName },
          { isGuest: entry2.isGuest, displayName: entry2.displayName },
        );

        const player1Color = game.player_white?.toString() === entry1.playerId ? "white" : "black";
        const player2Color = player1Color === "white" ? "black" : "white";

        io.to(entry1.socketId).emit("matchmaking_found", { gameId: game.game_id, color: player1Color });
        io.to(entry2.socketId).emit("matchmaking_found", { gameId: game.game_id, color: player2Color });

        await broadcastMatchmakingCount();

        logger.info(`Match! Game ${game.game_id}: ${entry1.playerId}(${player1Color}) vs ${entry2.playerId}(${player2Color})`);
      } catch (err) {
        logger.error("join_matchmaking error:", err);
        socket.emit("error", { message: "Failed to join matchmaking" });
      }
    });

    // ── Leave matchmaking queue ────────────────────────────────────────────
    socket.on("leave_matchmaking", async () => {
      try {
        if (!playerId) return;
        const t = matchmakingTimeouts.get(playerId);
        if (t) { clearTimeout(t); matchmakingTimeouts.delete(playerId); }
        await dequeueByPlayerId(queueClient, playerId);
        socket.emit("matchmaking_cancelled", {});
        await broadcastMatchmakingCount();
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
        const t = matchmakingTimeouts.get(playerId);
        if (t) { clearTimeout(t); matchmakingTimeouts.delete(playerId); }
        await dequeueByPlayerId(queueClient, playerId);
        await broadcastMatchmakingCount();
      }
    });
  });

  return io;
};