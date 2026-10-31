import { Worker } from 'bullmq';
import { Server } from 'socket.io';
import { ChessGameModel } from '@/models/chess_games.model';
import { logger } from '@/utils/logger';
import { bullmqRedisConnection, AUTO_ABANDON_QUEUE_NAME } from './connection';
import { toClientGame } from '@/utils/chessGame';
import { ChessGame } from '@/interfaces/chessgame.interface';

const ABANDON_TIMEOUT_MS = 60 * 1000; // 60 seconds
const BATCH_SIZE = 100;

export const initAutoAbandonWorker = (io: Server) => {
  const worker = new Worker(AUTO_ABANDON_QUEUE_NAME, async () => {
    try {
      const thresholdTime = new Date(Date.now() - ABANDON_TIMEOUT_MS);

      // Only fetch what we need (no card decks / move history). Backed by the
      // { 'game_state.status': 1, updatedAt: 1 } index on the schema.
      const staleGames = await ChessGameModel.find({
        'game_state.status': 'active',
        updatedAt: { $lt: thresholdTime },
      })
        .select('game_id game_state.turn')
        .limit(BATCH_SIZE)
        .lean();

      if (staleGames.length === 0) return;
      logger.debug(`Found ${staleGames.length} stale games`);

      for (const stale of staleGames) {
        try {
          const idlePlayerColor = stale.game_state.turn;
          const winnerColor = idlePlayerColor === 'white' ? 'black' : 'white';

          // Atomic: the filter repeats the staleness check, so if the player moved after the
          // query above (which bumps updatedAt / turn) this matches nothing and we skip it.
          const game = await ChessGameModel.findOneAndUpdate(
            {
              game_id: stale.game_id,
              'game_state.status': 'active',
              'game_state.turn': idlePlayerColor,
              updatedAt: { $lt: thresholdTime },
            },
            {
              $set: {
                'game_state.status': 'abandoned',
                'game_state.winner': winnerColor,
                completed_at: new Date(),
              },
              $inc: { version: 1 },
            },
            { new: true },
          ).lean();

          if (!game) continue;

          logger.info(`Auto-abandoned game ${game.game_id}. Winner: ${winnerColor}`);

          // Clients join the room `game:<id>` (see socket.ts) and listen for
          // `game_updated` as { gameId, data }.
          const room = `game:${game.game_id}`;
          io.to(room).emit('game_updated', { gameId: game.game_id, data: toClientGame(game as unknown as ChessGame) });
          io.to(room).emit('game_over', { winner: winnerColor, reason: 'abandonment' });
        } catch (err) {
          logger.error(`Auto-abandon failed for game ${stale.game_id}:`, err);
        }
      }
    } catch (err) {
      logger.error("Auto-abandon worker error:", err);
    }
  }, {
    connection: bullmqRedisConnection,
    prefix: 'backend_bullmq:'
  });

  worker.on('failed', (job, err) => {
    logger.error(`AutoAbandon job failed:`, err);
  });

  return worker;
};
