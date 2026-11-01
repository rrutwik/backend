import { Queue, Worker } from 'bullmq';
import { Server } from 'socket.io';
import { ChessService } from '@/services/chess.service';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, AUTO_ABANDON_QUEUE_NAME, BOT_QUEUE_NAME, MATCHMAKING_QUEUE_NAME } from './connection';
import { initMatchmakingWorker } from './matchmaking.worker';
import { initAutoAbandonWorker } from './autoAbandon.worker';
import { initBotWorker } from './bot.worker';
import { botsEnabled, ensureBots } from '@/services/bot.service';

const workers: Worker[] = [];
export const initBullMQ = async (io: Server, chessService: ChessService) => {
  logger.info('Initializing BullMQ queues and workers...');

  // Setup Matchmaking Queue
  const matchmakingQueue = new Queue(MATCHMAKING_QUEUE_NAME, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq:'
  });
  // The repeat key includes `every`, so the old 5s schedule would otherwise keep running next to the new one.
  await matchmakingQueue.removeRepeatable('processMatchmaking', { every: 5000 }, 'matchmaking-cron').catch((err) => {
    logger.warn('Could not remove the old 5s matchmaking schedule:', err);
  });
  await matchmakingQueue.add('processMatchmaking', {}, {
    // 2s (was 5s): this is also the fallback that hands a lone waiter a bot inside ~10s.
    repeat: { every: 2000 },
    jobId: 'matchmaking-cron',
    removeOnComplete: true,
    removeOnFail: true,
  });

  // Setup Auto Abandon Queue
  const autoAbandonQueue = new Queue(AUTO_ABANDON_QUEUE_NAME, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq:'
  });
  await autoAbandonQueue.add('processAutoAbandon', {}, {
    repeat: { every: 10000 }, // checks every 10s
    jobId: 'autoabandon-cron',
    removeOnComplete: true,
    removeOnFail: true,
  });

  // Start Workers
  workers.push(initMatchmakingWorker(io, chessService));
  workers.push(initAutoAbandonWorker(io));

  // Matchmaking bots (opt-in via BOTS_ENABLED)
  if (botsEnabled()) {
    await ensureBots();
    const botQueue = new Queue(BOT_QUEUE_NAME, {
      connection: bullmqRedisConnection,
      prefix: 'backend_bullmq:'
    });
    await botQueue.add('processBots', {}, {
      repeat: { every: 1000 },
      jobId: 'bots-cron',
      removeOnComplete: true,
      removeOnFail: true,
    });
    workers.push(initBotWorker(io, chessService));
    logger.info('Matchmaking bots enabled');
  }

  logger.info('BullMQ workers successfully attached');
};

export const closeBullMQ = async () => {
  logger.info('Closing BullMQ workers...');
  await Promise.all(workers.map(worker => worker.close()));
  logger.info('BullMQ workers closed');
};
