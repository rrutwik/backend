import { Queue } from 'bullmq';
import { Server } from 'socket.io';
import { ChessService } from '@/services/chess.service';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, AUTO_ABANDON_QUEUE_NAME, MATCHMAKING_QUEUE_NAME } from './connection';
import { initMatchmakingWorker } from './matchmaking.worker';
import { initAutoAbandonWorker } from './autoAbandon.worker';

export const initBullMQ = async (io: Server, chessService: ChessService) => {
  logger.info('Initializing BullMQ queues and workers...');

  // Setup Matchmaking Queue
  const matchmakingQueue = new Queue(MATCHMAKING_QUEUE_NAME, { connection: bullmqRedisConnection });
  await matchmakingQueue.add('processMatchmaking', {}, {
    repeat: { every: 5000 },
    jobId: 'matchmaking-cron',
    removeOnComplete: true,
    removeOnFail: true,
  });
  
  // Setup Auto Abandon Queue
  const autoAbandonQueue = new Queue(AUTO_ABANDON_QUEUE_NAME, { connection: bullmqRedisConnection });
  await autoAbandonQueue.add('processAutoAbandon', {}, {
    repeat: { every: 10000 }, // checks every 10s
    jobId: 'autoabandon-cron',
    removeOnComplete: true,
    removeOnFail: true,
  });

  // Start Workers
  initMatchmakingWorker(io, chessService);
  initAutoAbandonWorker(io);

  logger.info('BullMQ workers successfully attached');
};
