import { Worker } from 'bullmq';
import { Server } from 'socket.io';
import { ChessService } from '@/services/chess.service';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, MATCHMAKING_QUEUE_NAME } from './connection';
import { broadcastMatchmakingCount, runMatchmaking } from '@/services/matchmaking.service';
import { botsEnabled } from '@/services/bot.service';

const BOT_COUNT_REFRESH_MS = 5000;
let lastCountRefresh = 0;

/**
 * Periodic sweep. Players are normally matched immediately when they join
 * (see triggerMatchmaking in socket.ts); this job handles queue timeouts and picks up
 * anyone missed because another process held the matchmaking lock at that moment.
 */
export const initMatchmakingWorker = (io: Server, chessService: ChessService) => {
  const worker = new Worker(MATCHMAKING_QUEUE_NAME, async () => {
    try {
      await runMatchmaking(io, chessService);
      // The displayed count includes a time-based simulated part, so refresh the lobby periodically.
      if (botsEnabled() && Date.now() - lastCountRefresh >= BOT_COUNT_REFRESH_MS) {
        lastCountRefresh = Date.now();
        broadcastMatchmakingCount(io);
      }
    } catch (err) {
      logger.error("Matchmaking worker error:", err);
    }
  }, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq:'
  });

  worker.on('failed', (job, err) => {
    logger.error(`Matchmaking job failed:`, err);
  });

  return worker;
};
