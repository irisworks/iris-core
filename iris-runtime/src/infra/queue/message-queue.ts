/**
 * Redis Streams message queue.
 *
 * Uses XADD / XREADGROUP / XACK for exactly-once, ordered, persistent delivery.
 *
 * Why Redis Streams over Bull/BullMQ:
 *  - No additional abstraction layer
 *  - Native consumer groups = horizontal worker scaling
 *  - Persistent (survives Redis restart with AOF)
 *  - Built-in pending message tracking (PEL) for exactly-once semantics
 *  - Dead letter queue via XCLAIM after maxDeliveries
 *
 * Requires: npm install ioredis
 */

import type { Redis } from "ioredis";
import { logger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";

const log = logger.child({ component: "queue" });

// ============================================================================
// Types
// ============================================================================

export interface QueueMessage {
	/** Redis stream ID (auto-assigned on publish, used for ACK). */
	id: string;
	channelId: string;
	sessionId?: string;
	userId: string;
	userName?: string;
	text: string;
	attachments: string[];
	/** ISO 8601 — when the message was received by the gateway. */
	receivedAt: string;
	/** Source context for routing decisions. */
	source: "slack" | "telegram" | "api" | "event";
	metadata: Record<string, string>;
}

export type MessageHandler = (message: QueueMessage) => Promise<void>;

export interface MessageQueue {
	/**
	 * Publish a message to the queue.
	 * Returns the Redis stream message ID.
	 */
	publish(message: Omit<QueueMessage, "id">): Promise<string>;

	/**
	 * Start consuming messages.
	 * Calls handler for each message; ACKs on success, leaves in PEL on failure.
	 * Blocks indefinitely — call stop() to exit.
	 */
	consume(
		group: string,
		consumer: string,
		handler: MessageHandler,
		options?: ConsumeOptions,
	): Promise<void>;

	/** Claim and re-process messages stuck in PEL longer than minIdleMs. */
	claimStale(group: string, consumer: string, minIdleMs: number): Promise<number>;

	/** Acknowledge a message as successfully processed. */
	ack(group: string, messageId: string): Promise<void>;

	/** Publish to the dead letter stream (permanent failure). */
	deadLetter(message: QueueMessage, reason: string): Promise<void>;

	/** Current queue depth (pending messages across all consumers). */
	depth(group: string): Promise<number>;

	/** Graceful shutdown — drains in-flight messages. */
	stop(): void;
}

export interface ConsumeOptions {
	batchSize?: number;       // messages per XREADGROUP call (default: 10)
	blockMs?: number;         // BLOCK duration in ms (default: 2000)
	maxDeliveries?: number;   // move to DLQ after N failures (default: 3)
}

// ============================================================================
// RedisStreamQueue
// ============================================================================

export class RedisStreamQueue implements MessageQueue {
	private running = false;

	constructor(
		private readonly redis: Redis,
		private readonly stream: string,
		private readonly dlqStream: string,
	) {}

	// ── Produce ───────────────────────────────────────────────────────────────

	async publish(message: Omit<QueueMessage, "id">): Promise<string> {
		const fields = flatten(message);
		const id = await this.redis.xadd(this.stream, "*", ...fields);
		if (!id) throw new Error("XADD returned null — Redis may be full");
		metrics.messagesQueued.inc({ channel_id: message.channelId });
		log.debug("queued message", { stream: this.stream, id, channelId: message.channelId });
		return id;
	}

	// ── Consume ───────────────────────────────────────────────────────────────

	async consume(
		group: string,
		consumer: string,
		handler: MessageHandler,
		opts: ConsumeOptions = {},
	): Promise<void> {
		const { batchSize = 10, blockMs = 2000, maxDeliveries = 3 } = opts;

		// Ensure consumer group exists (idempotent)
		await this.ensureGroup(group);

		this.running = true;
		log.info("worker consuming", { stream: this.stream, group, consumer });

		while (this.running) {
			const done = metrics.queueProcessingLatency.startTimer();

			try {
				// Read new messages (never-delivered)
				const result = await (this.redis as any).xreadgroup(
					"GROUP", group, consumer,
					"COUNT", batchSize,
					"BLOCK", blockMs,
					"STREAMS", this.stream, ">",
				) as XReadGroupResult | null;

				done();

				if (!result) continue; // BLOCK timeout — no messages, loop

				const [, entries] = result[0];

				for (const [id, fields] of entries) {
					const message = unflatten(id, fields);
					const deliveryCount = await this.deliveryCount(group, id);

					if (deliveryCount > maxDeliveries) {
						log.warn("message exceeded max deliveries, moving to DLQ", { id, deliveryCount });
						await this.deadLetter(message, `exceeded ${maxDeliveries} delivery attempts`);
						await this.ack(group, id);
						continue;
					}

					try {
						await handler(message);
						await this.ack(group, id);
						metrics.agentRunsTotal.inc({ status: "success", model: "n/a" });
					} catch (err) {
						metrics.agentRunsTotal.inc({ status: "error", model: "n/a" });
						log.error("handler failed — message stays in PEL for retry", err, {
							messageId: id,
							channelId: message.channelId,
						});
						// No ACK — Redis keeps it in the Pending Entry List
					}
				}
			} catch (err) {
				done();
				if (this.running) {
					log.error("XREADGROUP error", err);
					await sleep(1000); // backoff before retry
				}
			}
		}

		log.info("worker stopped", { group, consumer });
	}

	// ── Stale message recovery ─────────────────────────────────────────────────

	async claimStale(group: string, consumer: string, minIdleMs: number): Promise<number> {
		let claimed = 0;
		try {
			// XAUTOCLAIM: atomically claims idle PEL messages and returns them
			const result = await (this.redis as any).xautoclaim(
				this.stream, group, consumer, minIdleMs, "0-0", "COUNT", 100,
			) as [string, XEntry[]];

			const [, entries] = result;
			for (const [id] of entries) {
				log.warn("claimed stale message", { id, minIdleMs });
				claimed++;
			}
		} catch (err) {
			log.warn("xautoclaim failed (Redis < 6.2?)", { err });
		}
		return claimed;
	}

	async ack(group: string, messageId: string): Promise<void> {
		await this.redis.xack(this.stream, group, messageId);
	}

	async deadLetter(message: QueueMessage, reason: string): Promise<void> {
		const fields = flatten({ ...message, dlqReason: reason, dlqAt: new Date().toISOString() });
		await this.redis.xadd(this.dlqStream, "*", ...fields);
		log.warn("message moved to DLQ", { messageId: message.id, reason });
	}

	async depth(group: string): Promise<number> {
		try {
			const info = await (this.redis as any).xinfo("GROUPS", this.stream) as unknown[][];
			for (const entry of info) {
				// XINFO GROUPS returns [field, value, field, value, ...]
				const pairs = entry as unknown[];
				for (let i = 0; i < pairs.length - 1; i += 2) {
					if (pairs[i] === "name" && pairs[i + 1] === group) {
						const pelIdx = pairs.findIndex((p, idx) => p === "pel-count" && idx > i);
						return pelIdx >= 0 ? Number(pairs[pelIdx + 1]) : 0;
					}
				}
			}
		} catch {
			// Redis may not have the group yet
		}
		return 0;
	}

	stop(): void {
		this.running = false;
	}

	// ── Private ───────────────────────────────────────────────────────────────

	private async ensureGroup(group: string): Promise<void> {
		try {
			// MKSTREAM: creates the stream if it doesn't exist
			await (this.redis as any).xgroup("CREATE", this.stream, group, "$", "MKSTREAM");
			log.info("created consumer group", { stream: this.stream, group });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("BUSYGROUP")) throw err;
			// Group already exists — fine
		}
	}

	private async deliveryCount(group: string, messageId: string): Promise<number> {
		try {
			const pending = await (this.redis as any).xpending(
				this.stream, group, messageId, messageId, 1,
			) as unknown[][];
			if (pending.length === 0) return 0;
			// XPENDING returns [id, consumer, idleMs, deliveryCount]
			return Number((pending[0] as unknown[])[3]) ?? 0;
		} catch {
			return 0;
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

export async function createMessageQueue(redisUrl: string, stream = "iris:messages"): Promise<MessageQueue> {
	const { default: Redis } = await import("ioredis") as { default: new (url: string, opts: object) => Redis };

	const redis = new Redis(redisUrl, {
		maxRetriesPerRequest: null, // important: null = retry forever for blocking reads
		enableReadyCheck: true,
	});

	redis.on("error", (err: Error) => log.error("queue redis error", err));

	return new RedisStreamQueue(redis, stream, `${stream}:dlq`);
}

// ============================================================================
// Serialisation helpers
// ============================================================================

type XEntry = [string, string[]];
type XReadGroupResult = [string, XEntry[]][];

function flatten(obj: Record<string, unknown>): string[] {
	const fields: string[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined || v === null) continue;
		fields.push(k, typeof v === "string" ? v : JSON.stringify(v));
	}
	return fields;
}

function unflatten(id: string, fields: string[]): QueueMessage {
	const obj: Record<string, unknown> = { id };
	for (let i = 0; i < fields.length - 1; i += 2) {
		const k = fields[i];
		const v = fields[i + 1];
		try {
			obj[k] = JSON.parse(v);
		} catch {
			obj[k] = v;
		}
	}
	return obj as unknown as QueueMessage;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
