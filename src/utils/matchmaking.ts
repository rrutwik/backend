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
