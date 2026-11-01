import { Redis } from 'ioredis';

/**
 * Matchmaking queue.
 *
 * Layout (all keys go through the queueClient keyPrefix):
 *   ZSET  matchmaking:q        member = playerId, score = joinedAt (ms)  -> FIFO order + expiry scan
 *   HASH  matchmaking:entries  playerId -> JSON(QueueEntry)
 *
 * Every operation is O(log n) (or O(1)) and atomic. The previous implementation kept a
 * LIST and did LRANGE + JSON.parse of the *whole* queue on every join/leave/disconnect.
 * A playerId can only be in the queue once (re-joining replaces the entry).
 *
 * NOTE: these keys are intentionally different from the old LIST key ("matchmaking:queue")
 * so that a deploy never hits a WRONGTYPE error. The old key expires on its own (TTL 600s).
 */
const ZSET_KEY = 'matchmaking:q';
const HASH_KEY = 'matchmaking:entries';
const QUEUE_TTL_SECONDS = 600;
const MAX_EXPIRE_BATCH = 100;

export const MATCHMAKING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface QueueEntry {
  playerId: string;
  socketId: string;
  joinedAt: number;
  isGuest: boolean;
}

export async function enqueuePlayer(redis: Redis, entry: QueueEntry): Promise<void> {
  await redis
    .multi()
    .hset(HASH_KEY, entry.playerId, JSON.stringify(entry))
    .zadd(ZSET_KEY, entry.joinedAt, entry.playerId)
    .expire(HASH_KEY, QUEUE_TTL_SECONDS)
    .expire(ZSET_KEY, QUEUE_TTL_SECONDS)
    .exec();
}

const LUA_DEQUEUE = `
  local removed = redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return removed
`;

/** Removes the player from the queue. Returns true if they were queued. */
export async function dequeueByPlayerId(redis: Redis, playerId: string): Promise<boolean> {
  const removed = (await redis.eval(LUA_DEQUEUE, 2, ZSET_KEY, HASH_KEY, playerId)) as number;
  return removed > 0;
}

const LUA_DEQUEUE_IF_SOCKET = `
  local json = redis.call('HGET', KEYS[2], ARGV[1])
  if not json then return 0 end
  local entry = cjson.decode(json)
  if entry.socketId ~= ARGV[2] then return 0 end
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 1
`;

/**
 * Removes the player only if their queue entry belongs to this socket.
 * Used on disconnect so an old tab/socket closing doesn't kick the player's *new* socket
 * out of the queue. Returns true if an entry was removed.
 */
export async function dequeueIfSocket(redis: Redis, playerId: string, socketId: string): Promise<boolean> {
  const removed = (await redis.eval(LUA_DEQUEUE_IF_SOCKET, 2, ZSET_KEY, HASH_KEY, playerId, socketId)) as number;
  return removed > 0;
}

// Pops the two longest-waiting players. If fewer than two valid entries exist, nothing is
// consumed (a lone valid entry is put back with its original score). Orphaned ids with no
// hash entry are dropped.
const LUA_POP_TWO = `
  local out = {}
  local guard = 0
  while #out < 2 and guard < 50 do
    guard = guard + 1
    local popped = redis.call('ZPOPMIN', KEYS[1], 1)
    if #popped == 0 then break end
    local id = popped[1]
    local json = redis.call('HGET', KEYS[2], id)
    redis.call('HDEL', KEYS[2], id)
    if json then table.insert(out, json) end
  end
  if #out < 2 then
    for _, json in ipairs(out) do
      local entry = cjson.decode(json)
      redis.call('HSET', KEYS[2], entry.playerId, json)
      redis.call('ZADD', KEYS[1], entry.joinedAt, entry.playerId)
    end
    return {}
  end
  return out
`;

export async function popTwoPlayers(redis: Redis): Promise<[QueueEntry, QueueEntry] | null> {
  const result = (await redis.eval(LUA_POP_TWO, 2, ZSET_KEY, HASH_KEY)) as string[] | null;
  if (!result || result.length !== 2) return null;
  return [JSON.parse(result[0]) as QueueEntry, JSON.parse(result[1]) as QueueEntry];
}

const LUA_POP_EXPIRED = `
  local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
  local out = {}
  for _, id in ipairs(ids) do
    local json = redis.call('HGET', KEYS[2], id)
    redis.call('ZREM', KEYS[1], id)
    redis.call('HDEL', KEYS[2], id)
    if json then table.insert(out, json) end
  end
  return out
`;

export async function popExpiredPlayers(redis: Redis, nowMs: number, timeoutMs: number): Promise<QueueEntry[]> {
  // expired  <=>  now - joinedAt > timeout  <=>  joinedAt < now - timeout (exclusive bound)
  const cutoff = `(${nowMs - timeoutMs}`;
  const result = (await redis.eval(LUA_POP_EXPIRED, 2, ZSET_KEY, HASH_KEY, cutoff, MAX_EXPIRE_BATCH)) as string[] | null;
  if (!result) return [];
  return result.map((str) => JSON.parse(str) as QueueEntry);
}

export async function getQueueCount(redis: Redis): Promise<number> {
  return redis.zcard(ZSET_KEY);
}

/** The `limit` longest-waiting entries, oldest first (read-only; use popPlayerIfWaited to take one). */
export async function peekQueue(redis: Redis, limit: number): Promise<QueueEntry[]> {
  const ids = await redis.zrange(ZSET_KEY, 0, limit - 1);
  if (ids.length === 0) return [];
  const jsons = await redis.hmget(HASH_KEY, ...ids);
  return jsons.filter((j): j is string => !!j).map((j) => JSON.parse(j) as QueueEntry);
}

const LUA_POP_IF_WAITED = `
  local json = redis.call('HGET', KEYS[2], ARGV[1])
  if not json then
    redis.call('ZREM', KEYS[1], ARGV[1])
    return nil
  end
  local entry = cjson.decode(json)
  if tonumber(ARGV[2]) - tonumber(entry.joinedAt) < tonumber(ARGV[3]) then return nil end
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return json
`;

/**
 * Atomically removes one specific player, but only if they have been waiting at least `minWaitMs`
 * and are still queued. Returns the entry, or null (not queued / not waited long enough).
 */
export async function popPlayerIfWaited(redis: Redis, playerId: string, nowMs: number, minWaitMs: number): Promise<QueueEntry | null> {
  const result = (await redis.eval(LUA_POP_IF_WAITED, 2, ZSET_KEY, HASH_KEY, playerId, nowMs, minWaitMs)) as string | null;
  return result ? (JSON.parse(result) as QueueEntry) : null;
}

// ─── Bot helpers ──────────────────────────────────────────────────────────────

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * How long a lone waiter is given to meet a real player before a bot is assigned: 3-8s, derived
 * from the player id so it is the same in every process and after a restart, and the match still
 * lands inside ~10s.
 */
export function botDelayMs(playerId: string): number {
  return 3000 + (hashString(playerId) % 5000);
}

/**
 * Number of "searching" players to add to the real queue count so the lobby never looks empty.
 * A pure function of time (a few sine waves), so every PM2 instance reports the same number and it
 * drifts smoothly instead of jumping. Always within [5, 100].
 */
export function botLobbyCount(nowMs: number = Date.now()): number {
  const t = nowMs / 1000;
  const wave = 0.5 * Math.sin(t / 97) + 0.3 * Math.sin(t / 41 + 1.3) + 0.2 * Math.sin(t / 13 + 2.1); // [-1, 1]
  const v = (wave + 1) / 2; // [0, 1]
  return Math.min(100, Math.max(5, 5 + Math.round(v * 95)));
}
