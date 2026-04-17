import { Worker } from 'bullmq';
import { Server } from 'socket.io';
import { ChessGameModel } from '@/models/chess_games.model';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, AUTO_ABANDON_QUEUE_NAME } from './connection';

const ABANDON_TIMEOUT_MS = 60 * 1000; // 60 seconds

export const initAutoAbandonWorker = (io: Server) => {
  const worker = new Worker(AUTO_ABANDON_QUEUE_NAME, async () => {
    try {
      logger.debug("Auto-abandon worker started");
      const thresholdTime = new Date(Date.now() - ABANDON_TIMEOUT_MS);

      const staleGames = await ChessGameModel.find({
        'game_state.status': 'active',
        updatedAt: { $lt: thresholdTime }
      });
      logger.debug(`Found ${staleGames.length} stale games`);
      if (staleGames.length === 0) return;

      for (const game of staleGames) {
        const idlePlayerColor = game.game_state.turn;
        const winnerColor = idlePlayerColor === 'white' ? 'black' : 'white';

        game.game_state.status = 'abandoned';
        game.game_state.winner = winnerColor;

        await game.save();

        logger.info(`Auto-abandoned game ${game.game_id}. Winner: ${winnerColor}`);

        // Broadcast the update to anyone in the game room
        io.to(game.game_id).emit('game_updated', game.toJSON());
        io.to(game.game_id).emit('game_over', {
          winner: winnerColor,
          reason: 'abandonment'
        });
      }
    } catch (err) {
      logger.error("Auto-abandon worker error:", err);
    }
  }, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq'
  });

  worker.on('failed', (job, err) => {
    logger.error(`AutoAbandon job failed:`, err);
  });

  return worker;
};
