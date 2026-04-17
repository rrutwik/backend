import Redis from "ioredis";
import { LRUCache } from "lru-cache";
import { logger } from "./utils/logger";

export type CacheKey = string;

export interface CacheOptions {
  ttl?: number; // ms
  max?: number; // max in-memory items
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_ITEMS = 1000;

class HybridCache {
  private memoryCache: LRUCache<CacheKey, unknown>;
  private redis: Redis;

  constructor(redisUrl = "redis://127.0.0.1:6379", options?: CacheOptions) {
    this.memoryCache = new LRUCache<CacheKey, unknown>({
      ttl: options?.ttl ?? DEFAULT_TTL_MS,
      max: options?.max ?? DEFAULT_MAX_ITEMS,
      allowStale: false,
      updateAgeOnGet: false,
      updateAgeOnHas: false,
    });

    this.redis = new Redis(redisUrl, {
      db: 0,
      keyPrefix: "backend_redis_cache:",
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }

  public async get<T = unknown>(key: CacheKey): Promise<T | undefined> {
    const memHit = this.memoryCache.get(key) as T | undefined;
    if (memHit !== undefined) {
      logger.debug(`Memory Cache get for key: ${key}`);
      return memHit;
    }

    const redisValue = await this.redis.get(key);
    if (redisValue) {
      logger.debug(`Redis Cache hit for key: ${key}`);
      const parsed = JSON.parse(redisValue) as T;
      this.memoryCache.set(key, parsed); // populate memory cache
      return parsed;
    }

    logger.debug(`Redis Cache miss for key: ${key}`);

    return undefined;
  }

  public async set<T = unknown>(key: CacheKey, value: T, ttlMs?: number): Promise<void> {
    this.memoryCache.set(key, value, { ttl: ttlMs });
    logger.debug(`Memory Cache set for key: ${key}`);

    const data = JSON.stringify(value);
    logger.debug(`Redis Cache set for key: ${key}`);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(key, data, "PX", ttlMs);
    } else {
      await this.redis.set(key, data);
    }
  }

  public async del(key: CacheKey): Promise<void> {
    this.memoryCache.delete(key);
    await this.redis.del(key);
  }

  public async clear(): Promise<void> {
    this.memoryCache.clear();
    await this.redis.flushdb();
  }

  // Wrap helper (first check memory, then Redis, then call factory)
  public async wrap<T>(key: CacheKey, factory: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const value = await factory();
    await this.set(key, value, ttlMs);
    return value;
  }

  public async testConnection(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === "PONG";
    } catch (err) {
      console.error("Redis connection failed:", err);
      return false;
    }
  }
}

// Default singleton
export const cache = new HybridCache(process.env.REDIS_URL, {});
export default HybridCache;
