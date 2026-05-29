/**
 * Redis cache client — typed operations with distributed locks.
 *
 * Wraps ioredis (add: npm i ioredis) with:
 *  • Typed get/set with automatic JSON serialisation
 *  • Distributed locks via SET NX PX (Redlock-lite)
 *  • Hash operations for per-field session state
 *  • Sliding-window rate limiting
 *  • Graceful degradation: if Redis is unavailable, operations no-op
 *    rather than crashing the process.
 */

import type { Redis } from "ioredis";
import { metrics } from "../observability/metrics.js";
import { logger } from "../observability/logger.js";

const log = logger.child({ component: "cache" });

// ============================================================================
// Key namespaces — centralised so there are no magic strings scattered around
// ============================================================================

export const CacheKey = {
	session:       (id: string)                  => `session:${id}`,
	sessionState:  (id: string)                  => `session:${id}:state`,
	systemPrompt:  (channelId: string, hash: string) => `prompt:${channelId}:${hash}`,
	channelMode:   (channelId: string)            => `channel:${channelId}:mode`,
	skills:        (channelId: string, mtime: number) => `skills:${channelId}:${mtime}`,
	rateLimit:     (userId: string, window: string)   => `rl:${userId}:${window}`,
	workerLock:    (channelId: string)            => `lock:channel:${channelId}`,
} as const;

export const TTL = {
	session:       1800,   // 30 min — active session warm cache
	systemPrompt:  60,     // 60 s   — prompt regenerated after memory changes
	channelMode:   300,    // 5 min  — channel config reload interval
	skills:        120,    // 2 min  — skills dir hot-reload window
	rateLimit:     60,     // 1 min  — rate limit sliding window
} as const;

// ============================================================================
// Cache interface
// ============================================================================

export interface CacheClient {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T, ttlSecs?: number): Promise<void>;
	del(...keys: string[]): Promise<void>;
	exists(key: string): Promise<boolean>;

	/** Field-level hash access — no full-object deserialise cost */
	hget<T>(key: string, field: string): Promise<T | null>;
	hset(key: string, field: string, value: unknown): Promise<void>;
	hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null>;

	/** Sliding-window rate limit. Returns { allowed, remaining, resetAt }. */
	rateLimit(key: string, limit: number, windowSecs: number): Promise<RateLimitResult>;

	/**
	 * Acquire a distributed lock. Throws if lock cannot be acquired within
	 * `timeoutMs`. Returns an async `release` function.
	 * Uses SET NX PX (single-instance Redlock-lite — sufficient for one Redis).
	 */
	lock(resource: string, ttlMs: number, timeoutMs?: number): Promise<() => Promise<void>>;

	/** Publish a message to a channel (for cross-worker notifications). */
	publish(channel: string, message: unknown): Promise<void>;

	/** Subscribe to a channel. Returns an unsubscribe function. */
	subscribe(channel: string, handler: (message: unknown) => void): Promise<() => Promise<void>>;

	/** Graceful shutdown */
	close(): Promise<void>;
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetAt: number; // Unix ms
}

// ============================================================================
// Redis implementation
// ============================================================================

export class RedisCacheClient implements CacheClient {
	constructor(private readonly redis: Redis) {}

	// ── get / set / del ────────────────────────────────────────────────────────

	async get<T>(key: string): Promise<T | null> {
		try {
			const raw = await this.redis.get(key);
			if (raw === null) {
				metrics.cacheMisses.inc({ key_prefix: keyPrefix(key) });
				return null;
			}
			metrics.cacheHits.inc({ key_prefix: keyPrefix(key) });
			return JSON.parse(raw) as T;
		} catch (err) {
			metrics.cacheErrors.inc({ operation: "get" });
			log.warn("cache get failed", { key, err });
			return null;
		}
	}

	async set<T>(key: string, value: T, ttlSecs?: number): Promise<void> {
		try {
			const serialised = JSON.stringify(value);
			if (ttlSecs && ttlSecs > 0) {
				await this.redis.set(key, serialised, "EX", ttlSecs);
			} else {
				await this.redis.set(key, serialised);
			}
		} catch (err) {
			metrics.cacheErrors.inc({ operation: "set" });
			log.warn("cache set failed", { key, err });
		}
	}

	async del(...keys: string[]): Promise<void> {
		try {
			if (keys.length > 0) await this.redis.del(...keys);
		} catch (err) {
			metrics.cacheErrors.inc({ operation: "del" });
			log.warn("cache del failed", { keys, err });
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			return (await this.redis.exists(key)) > 0;
		} catch {
			return false;
		}
	}

	// ── Hash operations ────────────────────────────────────────────────────────

	async hget<T>(key: string, field: string): Promise<T | null> {
		try {
			const raw = await this.redis.hget(key, field);
			return raw ? (JSON.parse(raw) as T) : null;
		} catch (err) {
			log.warn("cache hget failed", { key, field, err });
			return null;
		}
	}

	async hset(key: string, field: string, value: unknown): Promise<void> {
		try {
			await this.redis.hset(key, field, JSON.stringify(value));
		} catch (err) {
			log.warn("cache hset failed", { key, field, err });
		}
	}

	async hgetall<T extends Record<string, unknown>>(key: string): Promise<T | null> {
		try {
			const raw = await this.redis.hgetall(key);
			if (!raw || Object.keys(raw).length === 0) return null;
			const result: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(raw)) {
				try { result[k] = JSON.parse(v); } catch { result[k] = v; }
			}
			return result as T;
		} catch (err) {
			log.warn("cache hgetall failed", { key, err });
			return null;
		}
	}

	// ── Rate limiting ─────────────────────────────────────────────────────────

	async rateLimit(key: string, limit: number, windowSecs: number): Promise<RateLimitResult> {
		try {
			// Lua script: INCR + EXPIRE in one atomic operation
			const script = `
				local current = redis.call('INCR', KEYS[1])
				if current == 1 then
					redis.call('EXPIRE', KEYS[1], ARGV[1])
				end
				local ttl = redis.call('TTL', KEYS[1])
				return {current, ttl}
			`;
			const result = await this.redis.eval(script, 1, key, String(windowSecs)) as [number, number];
			const [count, ttl] = result;
			return {
				allowed: count <= limit,
				remaining: Math.max(0, limit - count),
				resetAt: Date.now() + ttl * 1000,
			};
		} catch (err) {
			log.warn("rate limit check failed — allowing request", { key, err });
			return { allowed: true, remaining: limit, resetAt: Date.now() + windowSecs * 1000 };
		}
	}

	// ── Distributed lock ─────────────────────────────────────────────────────

	async lock(resource: string, ttlMs: number, timeoutMs = 5000): Promise<() => Promise<void>> {
		const token = crypto.randomUUID();
		const deadline = Date.now() + timeoutMs;

		// Spin-wait with exponential backoff
		let delay = 50;
		while (Date.now() < deadline) {
			const acquired = await this.redis.set(resource, token, "PX", ttlMs, "NX");
			if (acquired === "OK") {
				return async () => {
					// Only delete if we still own the lock (Lua CAS)
					const release = `
						if redis.call('GET', KEYS[1]) == ARGV[1] then
							return redis.call('DEL', KEYS[1])
						else
							return 0
						end
					`;
					await this.redis.eval(release, 1, resource, token);
				};
			}
			await sleep(delay);
			delay = Math.min(delay * 1.5, 500);
		}

		throw new Error(`Could not acquire lock on "${resource}" within ${timeoutMs}ms`);
	}

	// ── Pub/Sub ───────────────────────────────────────────────────────────────

	async publish(channel: string, message: unknown): Promise<void> {
		try {
			await this.redis.publish(channel, JSON.stringify(message));
		} catch (err) {
			log.warn("pub/sub publish failed", { channel, err });
		}
	}

	async subscribe(channel: string, handler: (message: unknown) => void): Promise<() => Promise<void>> {
		// Subscriber needs its own connection (Redis pub/sub mode restriction)
		const sub = this.redis.duplicate();
		sub.on("message", (ch, raw) => {
			if (ch !== channel) return;
			try { handler(JSON.parse(raw)); } catch { handler(raw); }
		});
		await sub.subscribe(channel);
		return async () => {
			await sub.unsubscribe(channel);
			sub.disconnect();
		};
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	async close(): Promise<void> {
		await this.redis.quit();
	}
}

// ============================================================================
// No-op implementation for environments without Redis
// ============================================================================

export class NullCacheClient implements CacheClient {
	async get<T>(_k: string): Promise<T | null> { return null; }
	async set(_k: string, _v: unknown): Promise<void> {}
	async del(..._k: string[]): Promise<void> {}
	async exists(_k: string): Promise<boolean> { return false; }
	async hget<T>(_k: string, _f: string): Promise<T | null> { return null; }
	async hset(_k: string, _f: string, _v: unknown): Promise<void> {}
	async hgetall<T>(_k: string): Promise<T | null> { return null; }
	async rateLimit(_k: string, limit: number, windowSecs: number): Promise<RateLimitResult> {
		return { allowed: true, remaining: limit, resetAt: Date.now() + windowSecs * 1000 };
	}
	async lock(_r: string, _ttl: number): Promise<() => Promise<void>> { return async () => {}; }
	async publish(_c: string, _m: unknown): Promise<void> {}
	async subscribe(_c: string, _h: (m: unknown) => void): Promise<() => Promise<void>> { return async () => {}; }
	async close(): Promise<void> {}
}

// ============================================================================
// Factory
// ============================================================================

export function createCacheClient(redisUrl?: string): CacheClient {
	if (!redisUrl) {
		log.warn("REDIS_URL not set — running with NullCacheClient (no distributed caching or locking)");
		return new NullCacheClient();
	}

	// Dynamic import so ioredis is optional
	// In production: npm install ioredis
	return new Proxy({} as CacheClient, {
		get() {
			throw new Error("Call await buildRedisCacheClient() before using the cache");
		},
	});
}

export async function buildRedisCacheClient(redisUrl: string): Promise<CacheClient> {
	const { default: Redis } = await import("ioredis") as { default: new (url: string, opts: object) => Redis };
	const redis = new Redis(redisUrl, {
		maxRetriesPerRequest: 3,
		enableReadyCheck: true,
		lazyConnect: true,
	});

	redis.on("error", (err: Error) => {
		metrics.cacheErrors.inc({ operation: "connection" });
		log.error("Redis connection error", err);
	});

	redis.on("reconnecting", () => log.warn("Redis reconnecting…"));
	redis.on("ready", () => log.info("Redis connected"));

	await redis.connect();
	return new RedisCacheClient(redis);
}

// ============================================================================
// Helpers
// ============================================================================

function keyPrefix(key: string): string {
	return key.split(":")[0] ?? "unknown";
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
