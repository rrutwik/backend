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

const LUA_POP_TWO = `
  local len = redis.call('LLEN', KEYS[1])
  if len >= 2 then
    local p1 = redis.call('LPOP', KEYS[1])
    local p2 = redis.call('LPOP', KEYS[1])
    return {p1, p2}
  end
  return nil
`;

async function popTwoPlayers(redis: Redis): Promise<[QueueEntry, QueueEntry] | null> {
  const result = await redis.eval(LUA_POP_TWO, 1, QUEUE_KEY) as string[] | null;
  if (!result || result.length !== 2) return null;
  return [JSON.parse(result[0]) as QueueEntry, JSON.parse(result[1]) as QueueEntry];
}

const LUA_GET_EXPIRED = `
  local len = redis.call('LLEN', KEYS[1])
  local expired = {}
  local now = tonumber(ARGV[1])
  local timeout = tonumber(ARGV[2])

  for i=1, len do
    local itemStr = redis.call('LINDEX', KEYS[1], 0)
    if not itemStr then break end
    
    local decoded = cjson.decode(itemStr)
    if now - tonumber(decoded.joinedAt) > timeout then
      local popped = redis.call('LPOP', KEYS[1])
      table.insert(expired, popped)
    else
      -- Since it's a FIFO queue, if the oldest isn't expired, the rest aren't either
      break
    end
  end
  return expired
`;

async function popExpiredPlayers(redis: Redis, nowMs: number, timeoutMs: number): Promise<QueueEntry[]> {
  const result = await redis.eval(LUA_GET_EXPIRED, 1, QUEUE_KEY, nowMs, timeoutMs) as string[] | null;
  if (!result) return [];
  return result.map(str => JSON.parse(str) as QueueEntry);
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

  const broadcastMatchmakingCount = async () => {
    const count = await getQueueCount(queueClient);
    io.emit("matchmaking_count", { count });
  };

  // ── Matchmaking Cron Job (runs every 5 seconds) ────────────────────────
  setInterval(async () => {
    try {
      // 1. Acquire distributed lock (expires in 4 seconds) so only ONE production node does this at a time
      const lock = await queueClient.set("matchmaking:lock", "1", "PX", 4000, "NX");
      if (!lock) return; // Another node is currently running the matchmaking cron

      // 2. Process Timeouts (FIFO queue left side is oldest)
      const expiredPlayers = await popExpiredPlayers(queueClient, Date.now(), MATCHMAKING_TIMEOUT_MS);
      if (expiredPlayers.length > 0) {
        for (const player of expiredPlayers) {
          io.to(player.socketId).emit("matchmaking_timeout", { message: "No opponent found. Please try again." });
          logger.info(`Matchmaking timeout for player ${player.playerId}`);
        }
        await broadcastMatchmakingCount();
      }

      // 3. Process matches
      while (true) {
        const pair = await popTwoPlayers(queueClient);
        if (!pair) break; // No more pairs available

        const [entry1, entry2] = pair;

        const game = await chessService.createMatchmadeGame(
          entry1.playerId,
          entry2.playerId,
          { isGuest: entry1.isGuest },
          { isGuest: entry2.isGuest },
        );

        const player1Color = game.player_white?.toString() === entry1.playerId ? "white" : "black";
        const player2Color = player1Color === "white" ? "black" : "white";

        io.to(entry1.socketId).emit("matchmaking_found", { gameId: game.game_id, color: player1Color });
        io.to(entry2.socketId).emit("matchmaking_found", { gameId: game.game_id, color: player2Color });

        await broadcastMatchmakingCount();
        logger.info(`Match! Game ${game.game_id}: ${entry1.playerId}(${player1Color}) vs ${entry2.playerId}(${player2Color})`);
      }
    } catch (err) {
      logger.error("Matchmaking cron error:", err);
    }
  }, 5000);

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
        await broadcastMatchmakingCount();


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
        await dequeueByPlayerId(queueClient, playerId);
        await broadcastMatchmakingCount();
      }
    });
  });

  return io;
};