import { Worker } from 'bullmq';
import { Server } from 'socket.io';
import { ChessService } from '@/services/chess.service';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, BOT_QUEUE_NAME } from './connection';
import { runBotTurns } from '@/services/bot.service';

/** Plays the bots' turns (1s tick). See services/bot.service.ts. */
export const initBotWorker = (io: Server, chessService: ChessService) => {
  const worker = new Worker(BOT_QUEUE_NAME, async () => {
    try {
      await runBotTurns(io, chessService);
    } catch (err) {
      logger.error('Bot worker error:', err);
    }
  }, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq:',
  });

  worker.on('failed', (job, err) => {
    logger.error('Bot job failed:', err);
  });

  return worker;
};
