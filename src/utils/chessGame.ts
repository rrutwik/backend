import { ChessGame } from '@/interfaces/chessgame.interface';

/**
 * How long an active game may sit with no update before the player whose turn it is loses
 * (enforced by jobs/autoAbandon.worker.ts, shown to players as a countdown via `turn_deadline_at`).
 * Every write to the game (draw, move, ...) restarts the clock.
 */
export const TURN_TIMEOUT_MS = 60 * 1000;

/**
 * Converts a stored game into what clients are allowed to see.
 *
 * The draw pile is secret: cards are taken from the END of `cards_deck`, so sending it lets
 * anyone with devtools read the upcoming draws. Clients only ever need the number of cards left.
 *
 *  - `cards_remaining` is the real count (new clients should use this).
 *  - `cards_deck` is kept as an array of the same length filled with `null`, so clients that still
 *    compute `cards_deck.length` keep working during a staggered backend/frontend deploy.
 *    Once every client reads `cards_remaining` this can become `[]`.
 *
 * Always use this at the boundary where a game leaves the server (socket emits and HTTP
 * responses). Never pass its output back into the service layer.
 */
export function toClientGame<T extends Partial<ChessGame>>(input: T): T {
  // A raw Mongoose document must not be spread (it would copy $__/_doc, which still hold the real deck).
  const game: T = input && typeof (input as any).toObject === 'function' ? (input as any).toObject() : input;
  if (!game || !game.game_state) return game;
  const deck = game.game_state.cards_deck;
  const remaining = Array.isArray(deck) ? deck.length : 0;

  // Countdown for the idle-timeout rule. `server_now` lets the client correct for a wrong device clock.
  const updatedAt = (game as any).updatedAt;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : NaN;
  const timer =
    game.game_state.status === 'active' && Number.isFinite(updatedMs)
      ? {
          turn_deadline_at: new Date(updatedMs + TURN_TIMEOUT_MS).toISOString(),
          server_now: new Date().toISOString(),
        }
      : {};

  return {
    ...game,
    ...timer,
    game_state: {
      ...game.game_state,
      cards_deck: new Array(remaining).fill(null),
      cards_remaining: remaining,
    },
  };
}
