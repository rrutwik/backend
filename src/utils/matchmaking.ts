import { Redis } from 'ioredis';

const QUEUE_KEY = "matchmaking:queue";
export const MATCHMAKING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface QueueEntry {
  playerId: string;
  socketId: string;
  joinedAt: number;
  isGuest: boolean;
}

export async function enqueuePlayer(redis: Redis, entry: QueueEntry): Promise<void> {
  const raw = await redis.lrange(QUEUE_KEY, 0, -1);
  for (const item of raw) {
    const parsed = JSON.parse(item) as QueueEntry;
    if (parsed.playerId === entry.playerId) {
      await redis.lrem(QUEUE_KEY, 0, item);
    }
  }
  await redis.rpush(QUEUE_KEY, JSON.stringify(entry));
  await redis.expire(QUEUE_KEY, 600);
}

export async function dequeueByPlayerId(redis: Redis, playerId: string): Promise<void> {
  const raw = await redis.lrange(QUEUE_KEY, 0, -1);
  for (const item of raw) {
    const parsed = JSON.parse(item) as QueueEntry;
    if (parsed.playerId === playerId) {
      await redis.lrem(QUEUE_KEY, 0, item);
    }
  }
}

const LUA_POP_TWO = `
  local len = redis.call('LLEN', KEYS[1])
  if len >= 2 then
    local p1 = redis.call('LPOP', KEYS[1])
    local p2 = redis.call('LPOP', KEYS[1])
    return {p1, p2}
  end
  return nil
`;

export async function popTwoPlayers(redis: Redis): Promise<[QueueEntry, QueueEntry] | null> {
  const result = await redis.eval(LUA_POP_TWO, 1, QUEUE_KEY) as string[] | null;
  if (!result || result.length !== 2) return null;
  return [JSON.parse(result[0]) as QueueEntry, JSON.parse(result[1]) as QueueEntry];
}

const LUA_GET_EXPIRED = `
  local len = redis.call('LLEN', KEYS[1])
  local expired = {}
  local now = tonumber(ARGV[1])
  local timeout = tonumber(ARGV[2])

  for i=1, len do
    local itemStr = redis.call('LINDEX', KEYS[1], 0)
    if not itemStr then break end
    
    local decoded = cjson.decode(itemStr)
    if now - tonumber(decoded.joinedAt) > timeout then
      local popped = redis.call('LPOP', KEYS[1])
      table.insert(expired, popped)
    else
      break
    end
  end
  return expired
`;

export async function popExpiredPlayers(redis: Redis, nowMs: number, timeoutMs: number): Promise<QueueEntry[]> {
  const result = await redis.eval(LUA_GET_EXPIRED, 1, QUEUE_KEY, nowMs, timeoutMs) as string[] | null;
  if (!result) return [];
  return result.map(str => JSON.parse(str) as QueueEntry);
}

export async function getQueueCount(redis: Redis): Promise<number> {
  return redis.llen(QUEUE_KEY);
}
