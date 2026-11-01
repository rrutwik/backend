import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { ChessService } from '@/services/chess.service';
import { ChessGameModel } from '@/models/chess_games.model';
import { GuestModel } from '@/models/guest.model';
import { Guest } from '@/interfaces/guest.interface';
import { GameState, PlayingCard } from '@/interfaces/chessgame.interface';
import { env } from '@/env';
import { logger } from '@/utils/logger';
import { generateGuestName } from '@/utils/guestNames';
import { toClientGame } from '@/utils/chessGame';
import { botThinkMs, chooseBotMove } from '@/utils/chessBot';

/**
 * Server-run opponents for matchmaking. A bot is a Guest document with `is_bot: true`; it never
 * opens a socket. Matchmaking hands a lone waiting player a free bot after a few seconds
 * (matchmaking.service.ts) and jobs/bot.worker.ts plays the bot's turns through the same
 * ChessService methods a real player's socket events use, so all rules/versioning still apply.
 */

const BOT_CACHE_TTL_MS = 60_000;
const MAX_GAMES_PER_TICK = 50;

interface BotInfo {
  id: string;
  skill: number;
}

let botCache: { at: number; bots: Map<string, BotInfo> } | null = null;

export const botsEnabled = (): boolean => env.BOTS_ENABLED;

async function loadBots(): Promise<Map<string, BotInfo>> {
  if (botCache && Date.now() - botCache.at < BOT_CACHE_TTL_MS) return botCache.bots;
  // Capped at BOT_COUNT so lowering it retires surplus bots (they just stop being picked).
  const docs = await GuestModel.find({ is_bot: true }).sort({ _id: 1 }).limit(Math.max(0, Math.floor(env.BOT_COUNT))).select('_id bot_skill').lean();
  const bots = new Map<string, BotInfo>();
  for (const d of docs) {
    bots.set(String(d._id), { id: String(d._id), skill: typeof d.bot_skill === 'number' ? d.bot_skill : 0.7 });
  }
  // Don't cache an empty result: other PM2 processes would otherwise miss bots created by instance 0 for 60s.
  if (bots.size > 0) botCache = { at: Date.now(), bots };
  return bots;
}

/** Idempotently makes sure BOT_COUNT bot guests exist. No-op unless BOTS_ENABLED. */
export async function ensureBots(): Promise<void> {
  if (!env.BOTS_ENABLED) return;
  const count = Math.max(0, Math.floor(env.BOT_COUNT));
  if (count === 0) return;

  // session_uuid is the guest's bearer token, so it must be unguessable (never a sequential name).
  const existing = await GuestModel.countDocuments({ is_bot: true });
  const missing = count - existing;
  if (missing > 0) {
    await GuestModel.insertMany(
      Array.from({ length: missing }, () => ({
        session_uuid: uuidv4(),
        display_name: generateGuestName(),
        is_bot: true,
        bot_skill: Math.round((0.4 + Math.random() * 0.55) * 100) / 100,
      })),
    );
  }
  botCache = null;
  logger.info(`Bots ready: ${count} configured, ${Math.max(0, missing)} created`);
}

/** A random bot that is not currently playing an active game, or null if all are busy. */
export async function pickFreeBot(): Promise<string | null> {
  const bots = await loadBots();
  if (bots.size === 0) return null;

  const busyGames = await ChessGameModel.find({ has_bot: true, 'game_state.status': 'active' })
    .select('player_white player_black')
    .lean();
  const busy = new Set<string>();
  for (const g of busyGames) {
    if (g.player_white) busy.add(String(g.player_white));
    if (g.player_black) busy.add(String(g.player_black));
  }
  const free = [...bots.keys()].filter((id) => !busy.has(id));
  if (free.length === 0) return null;
  return free[Math.floor(Math.random() * free.length)];
}

/**
 * One tick of the bot player: for every active bot game where it is the bot's turn and it has
 * "thought" long enough, either plays a move or draws cards. Safe to call repeatedly.
 */
export async function runBotTurns(io: Server, chessService: ChessService): Promise<void> {
  const bots = await loadBots();
  if (bots.size === 0) return;

  const games = await ChessGameModel.find({ has_bot: true, 'game_state.status': 'active' })
    .select('game_id player_white player_black version updatedAt game_state.turn game_state.fen game_state.current_cards')
    .sort({ updatedAt: 1 }) // longest-waiting first so a busy server can't starve the same games
    .limit(MAX_GAMES_PER_TICK)
    .lean();

  const now = Date.now();
  await Promise.allSettled(
    games.map(async (game) => {
      const turn = game.game_state.turn as 'white' | 'black';
      const seatId = String(turn === 'white' ? game.player_white : game.player_black);
      const bot = bots.get(seatId);
      if (!bot) return; // human's turn

      const version = typeof game.version === 'number' ? game.version : 0;
      if (now - new Date((game as unknown as { updatedAt: Date }).updatedAt).getTime() < botThinkMs(game.game_id, version)) return;

      const botAsGuest = { _id: bot.id } as unknown as Guest;
      const held = (game.game_state.current_cards || []) as unknown as PlayingCard[];
      const move = held.length > 0 ? chooseBotMove(game.game_state.fen, held, bot.skill) : null;

      try {
        const updated = move
          ? await chessService.updateGameState(
              game.game_id,
              version,
              {
                fen: move.fen,
                moves: [{ move: { from: move.from, to: move.to }, usedCard: move.usedCard }],
              } as unknown as GameState,
              undefined,
              botAsGuest,
            )
          : await chessService.drawCards(game.game_id, undefined, botAsGuest);

        io.to(`game:${game.game_id}`).emit('game_updated', { gameId: game.game_id, data: toClientGame(updated) });
      } catch (err) {
        // 404/409 = the game changed under us (human moved/left); retried next tick, not worth an error.
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 409) logger.debug(`Bot turn skipped for game ${game.game_id}: ${(err as Error).message}`);
        else logger.error(`Bot turn failed for game ${game.game_id}:`, err);
      }
    }),
  );
}
