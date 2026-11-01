import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { ChessService } from '@/services/chess.service';
import { queueClient } from '@/jobs/connection';
import { logger } from '@/utils/logger';
import {
  botDelayMs,
  botLobbyCount,
  enqueuePlayer,
  getQueueCount,
  peekQueue,
  popExpiredPlayers,
  popPlayerIfWaited,
  popTwoPlayers,
  MATCHMAKING_TIMEOUT_MS,
} from '@/utils/matchmaking';
import { botsEnabled, pickFreeBot } from '@/services/bot.service';

const LOCK_KEY = 'matchmaking:lock';
const LOCK_TTL_MS = 10_000;
const COUNT_BROADCAST_MIN_INTERVAL_MS = 1000;

/**
 * Sockets that care about the queue size. The web client only shows it on the Find Opponent page
 * (which asks for the count on mount via `get_matchmaking_count`), so we no longer push it to every
 * connected socket, including everyone who is mid-game.
 */
export const MATCHMAKING_LOBBY_ROOM = 'matchmaking_lobby';

// ─── Throttled queue-size broadcast ───────────────────────────────────────────
// Every join/leave/disconnect used to io.emit() to *every* connected socket. Now it goes to the
// lobby room only, and bursts are coalesced to at most one broadcast per second per process (the first one goes out
// immediately). We deliberately do NOT skip "unchanged" counts: with several processes each
// one would hold its own idea of the last value and clients could end up stale.

let countTimer: NodeJS.Timeout | null = null;
let lastCountBroadcastAt = 0;

/** Queue size shown to players: the real queue, plus the simulated bot lobby when bots are on. */
export const getDisplayedQueueCount = async (): Promise<number> => {
  const real = await getQueueCount(queueClient);
  return botsEnabled() ? real + botLobbyCount() : real;
};

export const broadcastMatchmakingCount = (io: Server): void => {
  if (countTimer) return; // a broadcast is already scheduled; it will read the latest count
  const wait = Math.max(0, COUNT_BROADCAST_MIN_INTERVAL_MS - (Date.now() - lastCountBroadcastAt));
  countTimer = setTimeout(async () => {
    countTimer = null;
    lastCountBroadcastAt = Date.now();
    try {
      const count = await getDisplayedQueueCount();
      io.to(MATCHMAKING_LOBBY_ROOM).emit('matchmaking_count', { count });
    } catch (err) {
      logger.error('broadcastMatchmakingCount error:', err);
    }
  }, wait);
  countTimer.unref();
};

// ─── Matching ─────────────────────────────────────────────────────────────────

const LUA_RELEASE_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

/** Pairs queued players who have waited past their bot delay with a free bot. Call under the lock. */
const matchWaitersWithBots = async (io: Server, chessService: ChessService): Promise<void> => {
  const waiters = await peekQueue(queueClient, 20);
  for (const waiter of waiters) {
    const minWait = botDelayMs(waiter.playerId);
    if (Date.now() - waiter.joinedAt < minWait) continue;

    const botId = await pickFreeBot();
    if (!botId) {
      logger.warn('No free bot available for matchmaking');
      return;
    }

    // Atomic: a no-op if the player left or was matched since we peeked.
    const entry = await popPlayerIfWaited(queueClient, waiter.playerId, Date.now(), minWait);
    if (!entry) continue;

    try {
      const game = await chessService.createMatchmadeGame(
        entry.playerId,
        botId,
        { isGuest: entry.isGuest },
        { isGuest: true },
        { hasBot: true },
      );
      const color = game.player_white?.toString() === entry.playerId ? 'white' : 'black';
      io.to(entry.socketId).emit('matchmaking_found', { gameId: game.game_id, color });
      broadcastMatchmakingCount(io);
      logger.info(`Bot match! Game ${game.game_id}: ${entry.playerId}(${color}) vs bot ${botId}`);
    } catch (err) {
      logger.error('Bot game creation failed, re-queueing player:', err);
      await enqueuePlayer(queueClient, entry);
      return;
    }
  }
};

/**
 * Expires stale entries and pairs up waiting players.
 * Safe to call from any process at any time; a Redis lock keeps it to one runner at a time.
 * Returns false if another runner currently holds the lock.
 */
export const runMatchmaking = async (io: Server, chessService: ChessService): Promise<boolean> => {
  const token = randomUUID();
  const locked = await queueClient.set(LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
  if (!locked) return false;

  try {
    const expiredPlayers = await popExpiredPlayers(queueClient, Date.now(), MATCHMAKING_TIMEOUT_MS);
    if (expiredPlayers.length > 0) {
      for (const player of expiredPlayers) {
        io.to(player.socketId).emit('matchmaking_timeout', { message: 'No opponent found. Please try again.' });
        logger.info(`Matchmaking timeout for player ${player.playerId}`);
      }
      broadcastMatchmakingCount(io);
    }

    while (true) {
      const pair = await popTwoPlayers(queueClient);
      if (!pair) break;

      const [entry1, entry2] = pair;
      try {
        const game = await chessService.createMatchmadeGame(
          entry1.playerId,
          entry2.playerId,
          { isGuest: entry1.isGuest },
          { isGuest: entry2.isGuest },
        );

        const player1Color = game.player_white?.toString() === entry1.playerId ? 'white' : 'black';
        const player2Color = player1Color === 'white' ? 'black' : 'white';
        io.to(entry1.socketId).emit('matchmaking_found', { gameId: game.game_id, color: player1Color });
        io.to(entry2.socketId).emit('matchmaking_found', { gameId: game.game_id, color: player2Color });

        broadcastMatchmakingCount(io);
        logger.info(`Match! Game ${game.game_id}: ${entry1.playerId}(${player1Color}) vs ${entry2.playerId}(${player2Color})`);
      } catch (err) {
        // The pair was already popped from the queue. Put both back (keeping their original
        // joinedAt so they keep their place) instead of silently losing them, then stop for
        // this run so we don't spin on a persistent failure.
        logger.error('Matchmaking game creation failed, re-queueing players:', err);
        await enqueuePlayer(queueClient, entry1);
        await enqueuePlayer(queueClient, entry2);
        break;
      }
    }

    // Real players always get first pick (above). Whoever is still alone after their grace
    // period gets a bot, so nobody waits long on a quiet server.
    if (botsEnabled()) {
      await matchWaitersWithBots(io, chessService).catch((err) => logger.error('Bot matchmaking error:', err));
    }
  } finally {
    await queueClient.eval(LUA_RELEASE_LOCK, 1, LOCK_KEY, token).catch((err) => {
      logger.error('Failed to release matchmaking lock:', err);
    });
  }
  return true;
};

// In-process coalescing so a burst of joins results in one extra pass, not N concurrent runs.
let running = false;
let rerunRequested = false;

/**
 * Called right after a player joins the queue so they get matched immediately instead of
 * waiting for the periodic sweep. If the lock is held by another process, the periodic sweep
 * (see jobs/matchmaking.worker.ts) picks the player up shortly after.
 */
export const triggerMatchmaking = async (io: Server, chessService: ChessService): Promise<void> => {
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  try {
    do {
      rerunRequested = false;
      await runMatchmaking(io, chessService);
    } while (rerunRequested);
  } catch (err) {
    logger.error('triggerMatchmaking error:', err);
  } finally {
    running = false;
  }
};
