import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '@/utils/logger';

const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`;

export const bullmqRedisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  keyPrefix: 'backend_bullmq:',
  db: 0,
});

bullmqRedisConnection.on('error', (err) => {
  logger.error('BullMQ Redis connection error:', err);
});

// Dedicated Redis db for matchmaking queue (db 13 to avoid collision)
export const queueClient = new Redis(redisUrl, {
  db: 0,
  keyPrefix: 'backend_redis_cache_matchmaking:',
  lazyConnect: true,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export const MATCHMAKING_QUEUE_NAME = 'MatchmakingQueue';
export const AUTO_ABANDON_QUEUE_NAME = 'AutoAbandonQueue';
