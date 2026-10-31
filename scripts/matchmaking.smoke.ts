/**
 * Smoke test for the Redis matchmaking queue (src/utils/matchmaking.ts).
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npx ts-node scripts/matchmaking.smoke.ts
 *
 * Uses a random key prefix and deletes everything it created, so it is safe to run against a
 * dev Redis. Exits non-zero on the first failed assertion.
 */
import assert from 'assert';
import Redis from 'ioredis';
import {
  enqueuePlayer,
  dequeueByPlayerId,
  dequeueIfSocket,
  popTwoPlayers,
  popExpiredPlayers,
  getQueueCount,
  QueueEntry,
} from '../src/utils/matchmaking';

const prefix = `mmsmoke_${Date.now()}_${Math.floor(Math.random() * 1e6)}:`;
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { keyPrefix: prefix });

const entry = (playerId: string, socketId: string, joinedAt: number): QueueEntry => ({
  playerId,
  socketId,
  joinedAt,
  isGuest: false,
});

async function main() {
  const now = Date.now();

  // enqueue + count
  await enqueuePlayer(redis, entry('A', 'sockA1', now - 3000));
  await enqueuePlayer(redis, entry('B', 'sockB', now - 2000));
  await enqueuePlayer(redis, entry('C', 'sockC', now - 1000));
  assert.strictEqual(await getQueueCount(redis), 3, 'three players queued');

  // re-join from a new socket replaces the entry instead of duplicating it
  await enqueuePlayer(redis, entry('A', 'sockA2', now));
  assert.strictEqual(await getQueueCount(redis), 3, 're-join does not duplicate');

  // old socket disconnecting must NOT remove the player's newer entry
  assert.strictEqual(await dequeueIfSocket(redis, 'A', 'sockA1'), false, 'stale socket does not dequeue');
  assert.strictEqual(await getQueueCount(redis), 3, 'A still queued');
  assert.strictEqual(await dequeueIfSocket(redis, 'A', 'sockA2'), true, 'current socket dequeues');
  assert.strictEqual(await getQueueCount(redis), 2, 'A removed');
  assert.strictEqual(await dequeueIfSocket(redis, 'nobody', 'x'), false, 'unknown player is a no-op');

  // FIFO pairing
  const pair = await popTwoPlayers(redis);
  assert.ok(pair, 'pair found');
  assert.deepStrictEqual([pair![0].playerId, pair![1].playerId], ['B', 'C'], 'longest-waiting first');
  assert.strictEqual(await getQueueCount(redis), 0, 'queue drained');

  // a single waiting player is not consumed
  await enqueuePlayer(redis, entry('D', 'sockD', now));
  assert.strictEqual(await popTwoPlayers(redis), null, 'no pair with one player');
  assert.strictEqual(await getQueueCount(redis), 1, 'lone player stays queued');

  // explicit leave
  assert.strictEqual(await dequeueByPlayerId(redis, 'D'), true, 'leave returns true when queued');
  assert.strictEqual(await dequeueByPlayerId(redis, 'D'), false, 'leave returns false when not queued');

  // expiry (only entries strictly older than the timeout)
  await enqueuePlayer(redis, entry('OLD', 'sockOld', now - 10_000));
  await enqueuePlayer(redis, entry('NEW', 'sockNew', now - 1_000));
  const expired = await popExpiredPlayers(redis, now, 5_000);
  assert.deepStrictEqual(expired.map((e) => e.playerId), ['OLD'], 'only stale entries expire');
  assert.strictEqual(await getQueueCount(redis), 1, 'fresh entry kept');

  console.log('matchmaking smoke test: all assertions passed');
}

main()
  .catch((err) => {
    console.error('matchmaking smoke test FAILED:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // clean up everything under our prefix (SCAN returns un-prefixed? it returns full keys, so use a raw client)
    const raw = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    const keys = await raw.keys(`${prefix}*`);
    if (keys.length) await raw.del(...keys);
    raw.disconnect();
    redis.disconnect();
  });
