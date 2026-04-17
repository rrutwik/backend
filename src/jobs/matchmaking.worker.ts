import { Worker } from 'bullmq';
import { Server } from 'socket.io';
import { ChessService } from '@/services/chess.service';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, queueClient, MATCHMAKING_QUEUE_NAME } from './connection';
import { popExpiredPlayers, popTwoPlayers, getQueueCount, MATCHMAKING_TIMEOUT_MS } from '@/utils/matchmaking';

const broadcastMatchmakingCount = async (io: Server) => {
  const count = await getQueueCount(queueClient);
  io.emit("matchmaking_count", { count });
};

export const initMatchmakingWorker = (io: Server, chessService: ChessService) => {
  const worker = new Worker(MATCHMAKING_QUEUE_NAME, async () => {
    try {
      logger.debug("Matchmaking worker started");
      const lock = await queueClient.set("matchmaking:lock", "1", "PX", 4000, "NX");
      if (!lock) return;

      const expiredPlayers = await popExpiredPlayers(queueClient, Date.now(), MATCHMAKING_TIMEOUT_MS);
      if (expiredPlayers.length > 0) {
        for (const player of expiredPlayers) {
          io.to(player.socketId).emit("matchmaking_timeout", { message: "No opponent found. Please try again." });
          logger.info(`Matchmaking timeout for player ${player.playerId}`);
        }
        logger.debug(`Matchmaking timeout for ${expiredPlayers.length} players`);
        await broadcastMatchmakingCount(io);
      }

      while (true) {
        const pair = await popTwoPlayers(queueClient);
        logger.debug(`Pair found: ${pair}`);
        if (!pair) break;

        const [entry1, entry2] = pair;
        const game = await chessService.createMatchmadeGame(
          entry1.playerId,
          entry2.playerId,
          { isGuest: entry1.isGuest },
          { isGuest: entry2.isGuest },
        );

        const player1Color = game.player_white?.toString() === entry1.playerId ? "white" : "black";
        const player2Color = player1Color === "white" ? "black" : "white";
        logger.debug(`Match found for players ${entry1.playerId} and ${entry2.playerId}`);
        io.to(entry1.socketId).emit("matchmaking_found", { gameId: game.game_id, color: player1Color });
        io.to(entry2.socketId).emit("matchmaking_found", { gameId: game.game_id, color: player2Color });

        await broadcastMatchmakingCount(io);
        logger.info(`Match! Game ${game.game_id}: ${entry1.playerId}(${player1Color}) vs ${entry2.playerId}(${player2Color})`);
      }
    } catch (err) {
      logger.error("Matchmaking worker error:", err);
    }
  }, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq'
  });

  worker.on('failed', (job, err) => {
    logger.error(`Matchmaking job failed:`, err);
  });

  return worker;
};
